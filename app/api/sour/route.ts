// Sour: provider summary. Owner: Justin (taken over from the scaffold; James did not land changes).
// POST /api/sour { visitId }                   -> queues a `sour.run` job and returns 202 { jobId, status }; the
//                                                 job writes both summaries and queues the two link emails (§3.4,
//                                                 §7.1), or returns the saved pair unchanged if the intake and
//                                                 uploads are the ones it already summarized (§7.1). The page
//                                                 polls GET /api/patient/[id], where that job's state and the
//                                                 retry live (§7.2), and this route is also the retry.
// POST /api/sour { visitId, question }         -> free-text follow-up ("why was Tuesday bad?") -> { answer,
//                                                 followUp }. The question is written to the visit's
//                                                 follow-up log before the model is asked, the answer is
//                                                 written back onto the same row, and one audit row records
//                                                 that it was asked (§7.5, lib/followUps.ts).
// GET  /api/sour?visitId=<id>                  -> { followUps }: that log, oldest first, for the panel on the
//                                                 provider page. Nothing here is ever emailed (§7.5, §8.2).
// `visitId` identifies the visit (design §4.4) and may also be that visit's invite token.
// All numbers are computed deterministically in lib/sour.ts and handed to the model as a local-time brief
// (per-day rows, time-of-day windows, spikes with places, nights labeled by the evening before).
// The model only writes patterns and questions. Safety flags (lows <54, TBR >4%, sustained >250) are
// computed in code and attached to the provider summary regardless of the narrative.
// Without an API key the summaries still return with placeholder patterns so the pages render.
// The same job is queued by the Sweetie route when intake wraps up (lib/jobHandlers.ts, lib/sourRun.ts) —
// that path is the patient's, keyed by their token, and does not come through here.
//
// Both halves are clinical, so both are admin or clinician and not staff (§5.2), and both resolve the visit
// through the practice: another practice's visit id reads as a visit that does not exist (lib/guard.ts).

import { after, NextResponse } from "next/server";
import { recordAudit, recordVisitRead } from "@/lib/auditStore";
import { followUpsFor, historyFrom, MAX_QUESTION_CHARS, recordAnswer, recordQuestion, renderHistory } from "@/lib/followUps";
import { requireCapability, requireProvider, requireVisitInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { ask, llmStatus, LLMUnavailable } from "@/lib/llm";
import { log, withRoute } from "@/lib/log";
import { sourChatSystem } from "@/lib/prompts";
import { loadSourContext } from "@/lib/sourRun";

async function postHandler(req: Request) {
  // Signed in before anything is validated: which capability this needs depends on whether a question came
  // with it, but "who is asking" does not, and a stranger should not learn what this route wants in a 400.
  await requireProvider();
  const body = (await req.json().catch(() => null)) as { visitId?: string; question?: unknown } | null;
  if (!body || typeof body.visitId !== "string" || !body.visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  if (body.question !== undefined && (typeof body.question !== "string" || !body.question.trim() || body.question.length > MAX_QUESTION_CHARS)) {
    return NextResponse.json({ error: `question must be non-empty text of at most ${MAX_QUESTION_CHARS} characters` }, { status: 400 });
  }
  // Queueing a summary needs the visit and nothing else; only the follow-up question needs the brief, which
  // costs a parse of the whole Dexcom upload.
  if (typeof body.question !== "string") {
    const me = await requireCapability("summaries:generate");
    const visit = await requireVisitInPractice(body.visitId, me);
    // Generation is a job (§3.4): two model calls and two emails are not something a clinician should hold a
    // request open for, and the row survives a redeploy mid-run. Asking twice while the first run is still in
    // flight joins it; asking again after it has finished is a real regenerate (lib/jobs.ts, enqueue).
    const { job, deduped } = await enqueue({ kind: "sour.run", payload: { visitId: visit.id }, idempotencyKey: `sour.run:${visit.id}` });
    nudge(after);
    return NextResponse.json({ jobId: job.id, status: job.status, queued: true, deduped }, { status: 202 });
  }

  // The brief is this patient's week, so the question path is read access to a summary, checked before the
  // parse of the whole Dexcom upload that building it costs.
  const me = await requireCapability("summaries:read");
  const visit = await requireVisitInPractice(body.visitId, me);
  const ctx = await loadSourContext(visit.id);
  if (!ctx) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  const { brief } = ctx;
  // §10.2: the brief put in front of the clinician is this visit's uploads and what the patient told Sweetie,
  // so asking a follow-up is a read of both and is recorded as one.
  await recordVisitRead({ practiceId: me.practiceId, visitId: ctx.visitId, actor: me, parts: ["uploads", "messages"] });

  // §7.5: the question goes on the record before the model is asked, so an outage leaves what the clinician
  // asked rather than losing it, and the recent conversation comes from that record rather than from the
  // browser — a reload, a second clinician and a second device all continue the same thread.
  const asked = await recordQuestion(ctx.visitId, me, body.question);
  const history = historyFrom(await followUpsFor(ctx.visitId));
  // One row per question (§10.2), written whether or not an answer arrives: what an admin is answering is
  // "was this patient's data put to the model, and by whom", which the asking already settles.
  await recordAudit({
    practiceId: me.practiceId,
    actorType: "user",
    actorId: me.id,
    action: "summary.question",
    entityType: "visit",
    entityId: ctx.visitId,
    detail: { role: me.role },
  });

  try {
    const answer = await ask(
      sourChatSystem(),
      `PATIENT DATA\n${brief}\n\nRECENT CONVERSATION (doctor q, Sour a):\n${renderHistory(history)}\n\nLATEST DOCTOR MESSAGE:\n${body.question.trim()}`,
      { effort: "low" },
    );
    if (!answer.trim()) throw new Error("Empty Sour reply");
    const plain = plainAnswer(answer);
    const logged = await recordAnswer(asked.id, plain, me);
    log.info("sour_question_answered", { visitId: ctx.visitId, userId: me.id, practiceId: me.practiceId });
    return NextResponse.json({ answer: plain, followUp: logged ?? { ...asked, answer: plain } });
  } catch (e) {
    // The question stays on the log unanswered either way: it is a record of what was asked, and the page
    // shows it as a question Sour never answered rather than quietly dropping it.
    if (e instanceof LLMUnavailable) {
      const error = llmStatus().configured
        ? "Sour chat is unavailable: the model gateway is not responding. Try again in a minute."
        : "Sour chat is unavailable until the model is configured.";
      return NextResponse.json({ error, followUp: asked }, { status: 503 });
    }
    // The caller's string may be a link token (loadSourContext takes either); log the resolved id.
    log.error("sour_chat_failed", { visitId: ctx.visitId, error: e });
    return NextResponse.json({ error: "Sour could not answer. Please try again.", followUp: asked }, { status: 502 });
  }
}

/**
 * §7.5's "visible on the page": one visit's follow-up log, for the panel beside the one-pager.
 *
 * Read access to a summary and nothing more (§5.2): the log is a conversation about this visit's data, so
 * whoever may read the brief may read what has been asked about it. Not folded into `PatientBundle`, which
 * is the one response the *patient* also receives for their own visit (§2.7) — the clinician's questions are
 * not theirs to read, and keeping the log on a provider-only route is what makes that structural rather
 * than a filter somebody has to remember. No audit row of its own: the page load beside it is the read
 * §10.2 records, and this is part of it.
 */
async function getHandler(req: Request) {
  const me = await requireCapability("summaries:read");
  const visitId = new URL(req.url).searchParams.get("visitId");
  if (!visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  const visit = await requireVisitInPractice(visitId, me);
  return NextResponse.json({ followUps: await followUpsFor(visit.id) });
}

function plainAnswer(raw: string): string {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (!text.startsWith("{") || !text.endsWith("}")) return text;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.answer === "string") return parsed.answer;

    const prose = Object.values(parsed)
      .flatMap((value) => {
        if (typeof value === "string") return [value];
        if (Array.isArray(value)) {
          return value.filter((item): item is string => typeof item === "string");
        }
        return [];
      })
      .join(" ");

    return prose || text;
  } catch {
    return text;
  }
}

export const GET = withRoute("GET /api/sour", getHandler);
export const POST = withRoute("POST /api/sour", postHandler);
