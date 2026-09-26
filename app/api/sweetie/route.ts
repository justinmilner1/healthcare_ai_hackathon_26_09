// Sweetie chat. Owner: Justin. Brain in lib/sweetie.ts; this route is transport.
// GET  /api/sweetie?token=...                                   -> { patientId, name, messages, status, intake, agent }
// POST /api/sweetie { token, message }                          -> { reply, status, intake, agent }
// POST /api/sweetie { token, event: { type: "upload", kind, count, days? } }  -> same; Sweetie acknowledges the upload
// POST /api/sweetie { token, event: { type: "skip_questions" } } -> same; saves an explicit opt-out
// Every patient message goes through the deterministic red-flag scan before the model sees it.
// Without an API key the same targets are spoken with fixed words, so the page works offline.

import { after, NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { LLMUnavailable, MODEL } from "@/lib/llm";
import { runSour } from "@/lib/sourRun";
import { backstop, extract, fieldsFor, greeting, merge, nextTarget, parseIntake, redFlagReply, renderNotes, scanRedFlags, scripted, skipQuestions, speak } from "@/lib/sweetie";
import type { VisitContext } from "@/lib/sweetie";
import type { ChatMessage, IntakeFieldDef, IntakeState } from "@/lib/types";

const MAX_TURNS = 6;

type UploadEvent = { type: "upload"; kind: string; count: number; days?: number };

async function patientByToken(token: string | null) {
  if (!token) return null;
  return db.patient.findUnique({ where: { token }, include: { provider: true } });
}

const agentInfo = () => ({ connected: Boolean(process.env.OPENAI_API_KEY), model: MODEL() });

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const patient = await patientByToken(token);
  if (!patient) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  const bundle = await loadBundle(patient.id);
  const rows = await db.message.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: "asc" } });
  const messages: ChatMessage[] = rows.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content, createdAt: m.createdAt.toISOString() }));
  if (messages.length === 0) {
    const hello = greeting(patient.name.split(" ")[0], patient.provider.name, { visitType: patient.visitType, reason: patient.reason }, fieldsFor(patient.visitType, patient.reason));
    await db.message.create({ data: { patientId: patient.id, role: "sweetie", content: hello } });
    messages.push({ role: "sweetie", content: hello });
  }
  return NextResponse.json({ patientId: patient.id, name: patient.name, messages, status: bundle?.status, intake: bundle?.intake, intakeFields: bundle?.intakeFields, agent: agentInfo() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; message?: string; event?: UploadEvent | { type: "skip_questions" } };
  const patient = await patientByToken(body.token ?? null);
  if (!patient) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  const message = body.message?.trim();
  const event = body.event?.type === "upload" ? body.event : undefined;
  const skippingQuestions = body.event?.type === "skip_questions";
  if (!message && !event && !skippingQuestions) return NextResponse.json({ error: "message or event is required" }, { status: 400 });

  const firstName = patient.name.split(" ")[0];
  const visit = { visitType: patient.visitType, reason: patient.reason };
  const defs = fieldsFor(visit.visitType, visit.reason);
  let state: IntakeState = parseIntake(patient.intake, defs);
  const wasWrapped = state.wrapped;
  let reply: string;
  let exportHelp: "dexcom" | "timeline" | "whoop" | null = null;

  if (message) {
    await db.message.create({ data: { patientId: patient.id, role: "patient", content: message } });
    state = { ...state, turns: state.turns + 1 };

    // 1. Safety first, before any model call.
    const flag = scanRedFlags(message);
    if (flag) {
      state = { ...state, flagged: flag, wrapped: true };
      reply = redFlagReply(firstName, patient.provider.name);
      return finish(patient.id, state, defs, visit, reply, wasWrapped);
    }
  }

  if (skippingQuestions) {
    return finish(patient.id, skipQuestions(state), defs, visit,
      "You've skipped the remaining questions. Anything you've already shared is saved for your care team. You can view your week now.", wasWrapped);
  }

  const history = await db.message.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: "asc" } });
  const transcript = history.map((m) => `${m.role === "sweetie" ? "Sweetie" : "Patient"}: ${m.content}`).join("\n");

  // 2. What was Sweetie asking? Decided from the state before this message, so the extractor and the
  //    backstop both know which field the answer belongs to.
  const askedTarget = nextTarget(state, defs);
  const askedId = askedTarget.kind === "field" ? askedTarget.def.id : null;

  // 3. Extract what the latest message tells us (model), then the deterministic backstop.
  let llm = true;
  if (message) {
    try {
      const ex = await extract(state, defs, transcript, message, askedId);
      state = merge(state, ex);
      exportHelp = ex.asks_export_help;
      // A decline while being offered the data upload counts even if the extractor missed it.
      if (askedTarget.kind === "upload" && /\b(no|not|rather not|don'?t|skip|pass)\b/i.test(message) && !state.skipped.includes(askedTarget.which)) {
        state = { ...state, skipped: [...state.skipped, askedTarget.which] };
      }
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      llm = false;
      exportHelp = guessExportHelp(message);
      if (askedTarget.kind === "upload" && /\b(no|not|rather not|don'?t|skip|pass)\b/i.test(message)) state = { ...state, skipped: [...state.skipped, askedTarget.which] };
    }
    state = backstop(state, askedId, message);
  }

  // 4. Decide direction from state + what has actually been uploaded.
  const bundle = await loadBundle(patient.id);
  const status = bundle!.status;
  let target = nextTarget(state, defs);
  if (state.turns >= MAX_TURNS && target.kind !== "wrap") target = { kind: "wrap" };

  // 5. Say it.
  const uploadEvent = event ? { kind: event.kind, count: event.count, days: event.days } : undefined;
  if (llm) {
    try {
      reply = await speak({ firstName, providerName: patient.provider.name, visit, state, defs, status, target, transcript, exportHelp, uploadEvent });
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      reply = scripted({ firstName, target, exportHelp, uploadEvent });
    }
  } else {
    reply = scripted({ firstName, target, exportHelp, uploadEvent });
  }
  if (target.kind === "wrap") state = { ...state, wrapped: true };

  return finish(patient.id, state, defs, visit, reply, wasWrapped);
}

async function finish(patientId: string, state: IntakeState, defs: IntakeFieldDef[], visit: VisitContext, reply: string, wasWrapped = false) {
  await db.message.create({ data: { patientId, role: "sweetie", content: reply } });
  await db.patient.update({ where: { id: patientId }, data: { intake: JSON.stringify(state), notes: renderNotes(state, defs, visit) } });
  const bundle = await loadBundle(patientId);

  // Trigger: the turn that wraps the intake also kicks off Sour, after this reply is on its way, so the
  // doctor's link email arrives while the patient is still reading Sweetie's goodbye. Once per wrap.
  if (state.wrapped && !wasWrapped && bundle?.status.hasDexcom) {
    after(async () => {
      try {
        await runSour(patientId);
      } catch (e) {
        console.error("Sour auto-run after intake failed:", e);
      }
    });
  }

  return NextResponse.json({ reply, status: bundle?.status, intake: bundle?.intake, intakeFields: bundle?.intakeFields, agent: agentInfo() });
}

function guessExportHelp(text: string): "dexcom" | "timeline" | "whoop" | null {
  const t = text.toLowerCase();
  if (!/how|where|get|find|export|download/.test(t)) return null;
  if (/dexcom|clarity|glucose|cgm/.test(t)) return "dexcom";
  if (/timeline|maps|location/.test(t)) return "timeline";
  if (/whoop|sleep/.test(t)) return "whoop";
  return null;
}
