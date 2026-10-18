// Sweetie chat. Owner: Justin. Brain in lib/sweetie.ts; this route is transport.
// Every call needs a verified patient session for the visit the token names (design §5.3): the link alone
// opens the code screen and nothing else.
// GET  /api/sweetie?token=...                                   -> { visitId, name, provider, messages, status, intake, agent }
// POST /api/sweetie { token, message }                          -> { reply, provider, status, intake, agent }
// POST /api/sweetie { token, event: { type: "upload", kind, count, days? } }  -> same; Sweetie acknowledges the upload
// POST /api/sweetie { token, event: { type: "skip_questions" } } -> same; saves an explicit opt-out
// Every patient message goes through the deterministic red-flag scan before the model sees it.
// Without an API key the same targets are spoken with fixed words, so the page works offline. The same happens
// when a configured gateway times out or its circuit opens (lib/llm.ts); the `agent.degraded` flag in every
// response is what puts the quiet note on the page (design 6.3).

import { after, NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { nudge } from "@/lib/jobs";
import { llmStatus } from "@/lib/llm";
import { requireVerifiedPatient } from "@/lib/guard";
import { log, withRoute } from "@/lib/log";
import { enforceIpLimit, enforceVisitLimit } from "@/lib/ratelimit";
import { fieldsFor, greeting, parseIntake, renderNotes, skipQuestions } from "@/lib/sweetie";
import type { VisitContext } from "@/lib/sweetie";
import { queueSour } from "@/lib/sourQueue";
import { runTurn } from "@/lib/sweetieTurn";
import type { TurnStore } from "@/lib/sweetieTurn";
import type { ChatMessage, ChatRole, IntakeFieldDef, IntakeState } from "@/lib/types";
import { providerName, visitByToken } from "@/lib/visit";

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
  // §5.4 by IP first, so a caller with no token and no session is turned away before any query runs.
  enforceIpLimit("sweetie", req);
  const token = new URL(req.url).searchParams.get("token");
  const visit = await visitByToken(token);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  await requireVerifiedPatient(req, visit);
  // §5.4 by visit, and after that check on purpose: a refused request costs almost nothing, and someone a
  // link was forwarded to must not be able to spend the real patient's window.
  enforceVisitLimit("sweetie", visit.id);
  const bundle = await loadBundle(visit.id);
  const rows = await db.message.findMany({ where: { visitId: visit.id }, orderBy: { createdAt: "asc" } });
  const messages: ChatMessage[] = rows.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content, createdAt: m.createdAt.toISOString() }));
  if (messages.length === 0) {
    const hello = greeting(visit.patient.name.split(" ")[0], providerName(visit), { visitType: visit.visitType, reason: visit.reason, isSandbox: visit.isSandbox }, fieldsFor(visit.visitType, visit.isSandbox ? null : visit.reason), bundle?.status.hasDexcom);
    await db.message.create({ data: { visitId: visit.id, role: "sweetie", content: hello } });
    messages.push({ role: "sweetie", content: hello });
  }
  return NextResponse.json({ visitId: visit.id, name: visit.patient.name, provider: providerName(visit), messages, status: bundle?.status, intake: bundle?.intake, intakeFields: bundle?.intakeFields, agent: agentInfo() });
}

async function postHandler(req: Request) {
  // §5.4 by IP, before the body is read: a POST here can cost a model call, which is the expensive thing.
  enforceIpLimit("sweetie", req);
  const body = (await req.json().catch(() => ({}))) as { token?: string; message?: string; event?: UploadEvent | { type: "skip_questions" } };
  const visit = await visitByToken(body.token ?? null);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  await requireVerifiedPatient(req, visit);
  // §5.4 by visit, after the session check for the reason given in getHandler.
  enforceVisitLimit("sweetie", visit.id);
  const message = body.message?.trim();
  const event = body.event?.type === "upload" ? body.event : undefined;
  const skippingQuestions = body.event?.type === "skip_questions";
  if (!message && !event && !skippingQuestions) return NextResponse.json({ error: "message or event is required" }, { status: 400 });

  const firstName = visit.patient.name.split(" ")[0];
  const context = { visitType: visit.visitType, reason: visit.reason, isSandbox: visit.isSandbox };
  // Demo metadata is not a patient's clinical reason for booking.
  const defs = fieldsFor(context.visitType, visit.isSandbox ? null : context.reason);
  const state: IntakeState = parseIntake(visit.intake, defs);
  const wasWrapped = state.wrapped;
  const store = turnStore(visit.id, defs, context);

  if (skippingQuestions) {
    // Skipping is for a patient who has given us something. With nothing answered and nothing uploaded
    // there is no week to view, so steer back to the first question instead of wrapping an empty intake.
    const soFar = await loadBundle(visit.id);
    const hasAnything = state.turns > 0 || Boolean(soFar?.status.hasDexcom || soFar?.status.hasLocation || soFar?.status.hasWhoop);
    if (!hasAnything) {
      // No chat message: the greeting already asked the first question. The page shows a short inline hint.
      return NextResponse.json({ skipRefused: true, status: soFar?.status, intake: soFar?.intake, intakeFields: soFar?.intakeFields, agent: agentInfo() });
    }
    const skipped = skipQuestions(state);
    const goodbye = "You've skipped the remaining questions. Anything you've already shared is saved for your care team. You can view your week now.";
    await store.commit(goodbye, skipped);
    return respond(visit.id, skipped, goodbye, wasWrapped);
  }

  // The turn itself — the order of the message write, the safety scan, the two model calls and the commit —
  // is lib/sweetieTurn.ts, because design 6.2 is a claim about that order and a route cannot be tested for it.
  const turn = await runTurn(
    {
      message,
      event: event ? { kind: event.kind, count: event.count, days: event.days } : undefined,
      state,
      defs,
      visit: context,
      firstName,
      providerName: providerName(visit),
    },
    store,
  );
  if (turn.fallbackAt === "extract") logScripted("sweetie_extract_unavailable", visit, { turns: turn.state.turns });
  if (turn.fellBack) logScripted("sweetie_scripted", visit, { target: turn.target.kind });

  return respond(visit.id, turn.state, turn.reply, wasWrapped);
}

/** The database half of a turn (lib/sweetieTurn.ts). Everything here is this visit's rows and nothing else. */
function turnStore(visitId: string, defs: IntakeFieldDef[], context: VisitContext): TurnStore {
  return {
    append: async (role: ChatRole, content: string) => {
      await db.message.create({ data: { visitId, role, content } });
    },
    transcript: async () => {
      const history = await db.message.findMany({ where: { visitId }, orderBy: { createdAt: "asc" } });
      return history.map((m) => `${m.role === "sweetie" ? "Sweetie" : "Patient"}: ${m.content}`).join("\n");
    },
    status: async () => (await loadBundle(visitId))!.status,
    // One transaction, which is the "consistent state" half of 6.2: Sweetie's reply, the intake it was
    // written from, and the visit status it implies either all land or none do. Three statements used to go
    // out one at a time, so a crash between them could leave a question on screen that the stored intake had
    // never seen — the patient would answer it and the answer would be filed against the wrong field.
    // The visit status only ever moves forwards: a patient adding a line after Sour has run must not walk the
    // visit back to intake, which is why it is an updateMany with a `from` list rather than an update (4.4).
    commit: async (reply: string, state: IntakeState) => {
      const reached = state.wrapped ? "intake_done" : "in_intake";
      const from = state.wrapped ? ["invited", "verified", "in_intake"] : ["invited", "verified"];
      await db.$transaction([
        db.message.create({ data: { visitId, role: "sweetie", content: reply } }),
        db.visit.update({ where: { id: visitId }, data: { intake: JSON.stringify(state), notes: renderNotes(state, defs, context) } }),
        db.visit.updateMany({ where: { id: visitId, status: { in: from } }, data: { status: reached } }),
      ]);
    },
  };
}

/** What the page gets back once the turn is committed, plus the one side effect a wrap has (7.1). */
async function respond(visitId: string, state: IntakeState, reply: string, wasWrapped: boolean) {
  const bundle = await loadBundle(visitId);

  // Trigger: the turn that wraps the intake queues Sour (7.1), so the doctor's link email is on its way
  // while the patient is still reading Sweetie's goodbye. Once per wrap — and a queued row rather than work
  // done in `after()`, because the patient's last turn must not be the only chance Sour ever gets: a crash
  // between the reply and the summary used to lose it silently, and now it is a row with three attempts.
  if (state.wrapped && !wasWrapped && bundle?.status.hasDexcom) {
    try {
      const { job } = await queueSour(visitId);
      log.info("sour_queued", { visitId, jobId: job.id });
    } catch (e) {
      // Sweetie's goodbye still goes out; the clinician's Generate button is the fallback.
      log.error("sour_enqueue_failed", { visitId, error: e });
    }
    nudge(after);
  }

  return NextResponse.json({ reply, provider: bundle?.patient.provider.name, status: bundle?.status, intake: bundle?.intake, intakeFields: bundle?.intakeFields, agent: agentInfo() });
}

export const GET = withRoute("GET /api/sweetie", getHandler);
export const POST = withRoute("POST /api/sweetie", postHandler);
