// Sweetie chat. Owner: Justin. Brain in lib/sweetie.ts; this route is transport.
// Every call needs a verified patient session for the visit the token names (design §5.3): the link alone
// opens the code screen and nothing else.
// GET  /api/sweetie?token=...                                   -> { visitId, name, messages, status, intake, agent }
// POST /api/sweetie { token, message }                          -> { reply, status, intake, agent }
// POST /api/sweetie { token, event: { type: "upload", kind, count, days? } }  -> same; Sweetie acknowledges the upload
// POST /api/sweetie { token, event: { type: "skip_questions" } } -> same; saves an explicit opt-out
// Every patient message goes through the deterministic red-flag scan before the model sees it.
// Without an API key the same targets are spoken with fixed words, so the page works offline. The same happens
// when a configured gateway times out or its circuit opens (lib/llm.ts); the `agent.degraded` flag in every
// response is what puts the quiet note on the page (design 6.3).

import { after, NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { enqueue, nudge } from "@/lib/jobs";
import { llmStatus, LLMUnavailable } from "@/lib/llm";
import { log, withRoute } from "@/lib/log";
import { backstop, extract, fieldsFor, greeting, merge, nextTarget, parseIntake, redFlagReply, renderNotes, scanRedFlags, scripted, skipQuestions, speak } from "@/lib/sweetie";
import type { VisitContext } from "@/lib/sweetie";
import type { ChatMessage, IntakeFieldDef, IntakeState } from "@/lib/types";
import { patientAllowed, VERIFICATION_REQUIRED } from "@/lib/patientSession";
import { providerName, visitByToken } from "@/lib/visit";

const MAX_TURNS = 6;

type UploadEvent = { type: "upload"; kind: string; count: number; days?: number };

// `connected` is whether a model is configured at all (the page's "Demo mode"); `degraded` is a configured
// gateway that is failing, which is the quiet note in design 6.3. Read after the model call, so the reply and
// the state the page shows agree.
const agentInfo = () => {
  const s = llmStatus();
  return { connected: s.configured, model: s.model, degraded: s.configured && s.degraded };
};

/** One line whenever the patient gets scripted words instead of Sweetie's. A configured gateway that is
 *  failing is a warning someone should see; no gateway at all is just offline development. */
function logScripted(event: string, visit: { id: string; patientId: string }, fields: Record<string, unknown> = {}) {
  const s = llmStatus();
  const line = { visitId: visit.id, patientId: visit.patientId, scripted: true, degraded: s.configured && s.degraded, ...fields };
  if (s.configured) log.warn(event, line);
  else log.info(event, line);
}

async function getHandler(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const visit = await visitByToken(token);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  if (!(await patientAllowed(req, visit))) return NextResponse.json(VERIFICATION_REQUIRED, { status: 401 });
  const bundle = await loadBundle(visit.id);
  const rows = await db.message.findMany({ where: { visitId: visit.id }, orderBy: { createdAt: "asc" } });
  const messages: ChatMessage[] = rows.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content, createdAt: m.createdAt.toISOString() }));
  if (messages.length === 0) {
    const hello = greeting(visit.patient.name.split(" ")[0], providerName(visit), { visitType: visit.visitType, reason: visit.reason, isSandbox: visit.isSandbox }, fieldsFor(visit.visitType, visit.isSandbox ? null : visit.reason), bundle?.status.hasDexcom);
    await db.message.create({ data: { visitId: visit.id, role: "sweetie", content: hello } });
    messages.push({ role: "sweetie", content: hello });
  }
  return NextResponse.json({ visitId: visit.id, name: visit.patient.name, messages, status: bundle?.status, intake: bundle?.intake, intakeFields: bundle?.intakeFields, agent: agentInfo() });
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; message?: string; event?: UploadEvent | { type: "skip_questions" } };
  const visit = await visitByToken(body.token ?? null);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  if (!(await patientAllowed(req, visit))) return NextResponse.json(VERIFICATION_REQUIRED, { status: 401 });
  const message = body.message?.trim();
  const event = body.event?.type === "upload" ? body.event : undefined;
  const skippingQuestions = body.event?.type === "skip_questions";
  if (!message && !event && !skippingQuestions) return NextResponse.json({ error: "message or event is required" }, { status: 400 });

  const firstName = visit.patient.name.split(" ")[0];
  const context = { visitType: visit.visitType, reason: visit.reason, isSandbox: visit.isSandbox };
  // Demo metadata is not a patient's clinical reason for booking.
  const defs = fieldsFor(context.visitType, visit.isSandbox ? null : context.reason);
  let state: IntakeState = parseIntake(visit.intake, defs);
  const wasWrapped = state.wrapped;
  let reply: string;
  let exportHelp: "dexcom" | "timeline" | "whoop" | null = null;

  if (message) {
    await db.message.create({ data: { visitId: visit.id, role: "patient", content: message } });
    state = { ...state, turns: state.turns + 1 };

    // 1. Safety first, before any model call.
    const flag = scanRedFlags(message);
    if (flag) {
      state = { ...state, flagged: flag, wrapped: true };
      reply = redFlagReply(firstName, providerName(visit));
      return finish(visit.id, state, defs, context, reply, wasWrapped);
    }
  }

  if (skippingQuestions) {
    // Skipping is for a patient who has given us something. With nothing answered and nothing uploaded
    // there is no week to view, so steer back to the first question instead of wrapping an empty intake.
    const soFar = await loadBundle(visit.id);
    const hasAnything = state.turns > 0 || Boolean(soFar?.status.hasDexcom || soFar?.status.hasLocation || soFar?.status.hasWhoop);
    if (!hasAnything) {
      // No chat message: the greeting already asked the first question. The page shows a short inline hint.
      return NextResponse.json({ skipRefused: true, status: soFar?.status, intake: soFar?.intake, intakeFields: soFar?.intakeFields, agent: agentInfo() });
    }
    return finish(visit.id, skipQuestions(state), defs, context,
      "You've skipped the remaining questions. Anything you've already shared is saved for your care team. You can view your week now.", wasWrapped);
  }

  const history = await db.message.findMany({ where: { visitId: visit.id }, orderBy: { createdAt: "asc" } });
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
      logScripted("sweetie_extract_unavailable", visit, { turns: state.turns });
      exportHelp = guessExportHelp(message);
      if (askedTarget.kind === "upload" && /\b(no|not|rather not|don'?t|skip|pass)\b/i.test(message)) state = { ...state, skipped: [...state.skipped, askedTarget.which] };
    }
    state = backstop(state, askedId, message);
  }

  // 4. Decide direction from state + what has actually been uploaded.
  const bundle = await loadBundle(visit.id);
  const status = bundle!.status;
  let target = nextTarget(state, defs);
  if (state.turns >= MAX_TURNS && target.kind !== "wrap") target = { kind: "wrap" };

  // 5. Say it.
  const uploadEvent = event ? { kind: event.kind, count: event.count, days: event.days } : undefined;
  if (llm) {
    try {
      reply = await speak({ firstName, providerName: providerName(visit), visit: context, state, defs, status, target, transcript, exportHelp, uploadEvent });
    } catch (e) {
      if (!(e instanceof LLMUnavailable)) throw e;
      logScripted("sweetie_scripted", visit, { target: target.kind });
      reply = scripted({ firstName, target, exportHelp, uploadEvent, isSandbox: visit.isSandbox });
    }
  } else {
    logScripted("sweetie_scripted", visit, { target: target.kind });
    reply = scripted({ firstName, target, exportHelp, uploadEvent, isSandbox: visit.isSandbox });
  }
  if (target.kind === "wrap") state = { ...state, wrapped: true };

  return finish(visit.id, state, defs, context, reply, wasWrapped);
}

async function finish(visitId: string, state: IntakeState, defs: IntakeFieldDef[], context: VisitContext, reply: string, wasWrapped = false) {
  await db.message.create({ data: { visitId, role: "sweetie", content: reply } });
  await db.visit.update({ where: { id: visitId }, data: { intake: JSON.stringify(state), notes: renderNotes(state, defs, context) } });
  // The visit's own state, so the dashboard and the job runner do not have to read the intake JSON (§4.4).
  // Only ever forwards: a patient adding a line after Sour has run must not walk the visit back to intake.
  const reached = state.wrapped ? "intake_done" : "in_intake";
  const from = state.wrapped ? ["invited", "verified", "in_intake"] : ["invited", "verified"];
  await db.visit.updateMany({ where: { id: visitId, status: { in: from } }, data: { status: reached } });
  const bundle = await loadBundle(visitId);

  // Trigger: the turn that wraps the intake queues Sour (§7.1), so the doctor's link email is on its way
  // while the patient is still reading Sweetie's goodbye. Once per wrap — and a queued row rather than work
  // done in `after()`, because the patient's last turn must not be the only chance Sour ever gets: a crash
  // between the reply and the summary used to lose it silently, and now it is a row with three attempts.
  if (state.wrapped && !wasWrapped && bundle?.status.hasDexcom) {
    try {
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId }, idempotencyKey: `sour.run:${visitId}` });
      log.info("sour_queued", { visitId, jobId: job.id });
    } catch (e) {
      // Sweetie's goodbye still goes out; the clinician's Generate button is the fallback.
      log.error("sour_enqueue_failed", { visitId, error: e });
    }
    nudge(after);
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

export const GET = withRoute("GET /api/sweetie", getHandler);
export const POST = withRoute("POST /api/sweetie", postHandler);
