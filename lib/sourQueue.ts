// Where a `sour.run` job comes from (design §7.1, docs/JOBS.md). Owner: platform.
//
// §7.1 names three things that enqueue a run — intake wrapping, a Dexcom import completing, and the
// provider page's Generate button — and all three want the same row: `sour.run` for one visit, keyed so
// that two of them arriving together is one run and not two pairs of model calls (lib/jobs.ts, enqueue).
// The key lives here rather than being spelled out at each call site, because the triggers are only correct
// as a set: a summary needs the intake *and* the readings, and either one can be the last to arrive.
//
//   intake wraps      queues on every wrap, with or without glucose  (wrapQueuesSour below)
//   data arrives      queues when the intake is already done          (queueSourAfterImport below)
//   Generate          queues whatever the state is — a clinician asked (app/api/sour/route.ts)
//   inputs moved      a finishing run queues its own successor        (queueSourSuccessor below)
//
// The import trigger's gate on the intake is the one data condition here, and it is about ordering rather
// than about content: a run before the intake has had its say writes a brief from half an interview. The
// wrap has no such condition, because nothing about a wrap is provisional — see `wrapQueuesSour`.
//
// The fourth is not a fourth trigger: it is what the first three need when one of them arrives during a run
// (T149). `enqueue` collapses a second `sour.run` while the first is in flight, and `loadSourContext` reads
// the uploads when the job runs — so an export shared while the wrap's run is mid-flight joins a run that
// read its inputs before the file existed, and nothing queues the readings afterwards. `runSour` closes
// that by comparing fingerprints on its way out; `queueSourSuccessor` is the row it writes.

import { enqueue, type EnqueueResult, type JobClient } from "./jobs";
import { log } from "./log";

/** One in-flight `sour.run` per visit (lib/jobs.ts: the key is released when the job finishes). */
export const sourJobKey = (visitId: string) => `sour.run:${visitId}`;

/**
 * The key a finishing run's successor is queued under (T149, §7.1).
 *
 * Deliberately *not* `sourJobKey`. The run that discovers its inputs have moved is still `running`, so it
 * still holds that key, and a successor queued under it would collapse into the very job it is meant to
 * follow — which is the bug, one layer down. The fingerprint it is queued *for* is what makes this key
 * right rather than merely different: two runs of the same visit that both end up looking at the same new
 * inputs queue one job between them, and a fingerprint that is not moving cannot mint a new key, so the
 * chain stops when the data does (lib/sourRun.ts states the whole termination argument).
 */
export const sourSuccessorKey = (visitId: string, inputHash: string) => `sour.run:${visitId}:after:${inputHash}`;

/**
 * Queue the run that reads the inputs this one missed (T149).
 *
 * Called by `runSour` on its way out, never by a route: it is not a fourth trigger but the repair of the
 * other three, for the window in which `enqueue`'s dedupe is the wrong answer. `inputHash` is the visit's
 * fingerprint as it stands now — what the successor will be summarizing, and the key it is held under.
 */
export const queueSourSuccessor = (visitId: string, inputHash: string, client?: JobClient): Promise<EnqueueResult> =>
  enqueue({ kind: "sour.run", payload: { visitId }, idempotencyKey: sourSuccessorKey(visitId, inputHash) }, client);

/** Put a `sour.run` on the queue for this visit. The caller still has to `nudge(after)` so a deployment
 *  with no scheduler drains it (docs/JOBS.md); that needs `after` from next/server and stays in the route. */
export const queueSour = (visitId: string, client?: JobClient): Promise<EnqueueResult> =>
  enqueue({ kind: "sour.run", payload: { visitId }, idempotencyKey: sourJobKey(visitId) }, client);

/**
 * §7.1's "when intake wraps": does this turn queue the run? (§2.6, §7.1, T143)
 *
 * Exactly twice — wrapped now, not wrapped before — and on nothing else. `hasDexcom` is in the input and
 * deliberately not in the answer, which is the whole of T143: the route used to require it, so a check-in
 * that wrapped with no glucose queued no run, `runSour` never reached `markSummaryReady`, and the
 * `notify.summary` job that carries §2.6's "the clinician is emailed a link" was never enqueued — while
 * Sweetie's own last sentence told the patient their doctor would see a one-page summary before the visit
 * (lib/sweetie.ts). §2.6 and §7.1 both name the trigger as the wrap with no data condition on it, and the
 * conversation-only brief is a brief the product already renders (app/provider/[id]/sour.tsx: "No glucose
 * data was shared. This summary is from the conversation only."), so the promise is kept by running rather
 * than by weakening the sentence. Naming the field here is what lets lib/sourQueue.test.ts assert that a
 * no-glucose wrap still queues, instead of leaving it to whatever the route happens not to check.
 *
 * A wrap is never empty *of what the patient said*, so this never queues a run over nothing to write
 * about: the field-driven wrap has answers behind it, the skip path refuses outright with nothing answered
 * and nothing uploaded (app/api/sweetie/route.ts), and a flagged wrap has the red flag and the message that
 * fired it (lib/sweetieTurn.ts, §2.5). That is a different emptiness from the clinician's surfaces', which
 * is `visitNotStarted` in lib/sourState.ts — no answer, no glucose, no wrap — and the two parting company
 * is what T148 was: a flag on the patient's first message wraps with every field `unfilled`, so this queued
 * a run, `runSour` saved both summaries and §2.6 emailed the link, while the page read `answered === 0`
 * with no `wrapped` in its own predicate and told the clinician to wait for a patient who had just
 * described chest pain. `visitNotStarted` is now false for every visit this returns true for, which is the
 * invariant the two sentences have to keep: anything worth queueing a run for is worth rendering.
 */
export function wrapQueuesSour(turn: { wrapped: boolean; wasWrapped: boolean; hasDexcom: boolean }): boolean {
  return turn.wrapped && !turn.wasWrapped;
}

/**
 * Visit statuses in which the intake has had its say (§4.4), so newly arrived glucose data is the last
 * thing a summary was waiting for.
 *
 * `intake_done` is what the wrapping turn commits; `summary_ready` and `reviewed` are visits that have been
 * summarized already and are getting fresh readings, which is a regenerate and still work worth queueing.
 * The earlier statuses are the ones to leave alone: a patient who connects Dexcom before answering Sweetie
 * is mid-intake, and summarizing there would write a brief from half an interview, move the visit to
 * `summary_ready` under the patient's feet, and email the clinician that a summary is ready — only for the
 * wrapping turn to queue a second run and a second email minutes later. That ordering is already covered,
 * from the other side: the wrap queues the run itself once the data is in.
 */
export const INTAKE_SETTLED_STATUSES: readonly string[] = ["intake_done", "summary_ready", "reviewed"];

export const intakeSettled = (visit: { status: string }): boolean => INTAKE_SETTLED_STATUSES.includes(visit.status);

/** What the import trigger did, for a route that wants to say so in its response or its log. */
export type ImportQueueResult =
  | { queued: true; jobId: string; deduped: boolean }
  | { queued: false; reason: "intake_unfinished" | "enqueue_failed" };

/**
 * §7.1's "when a Dexcom import completes": the trigger for a visit whose glucose data arrived after the
 * intake was already done, by OAuth import or by Clarity upload.
 *
 * Call it once the upload row is committed, so the run reads the readings it was queued for, and never
 * before: a job that beats its own data produces a summary of nothing. It does not throw. The import is the
 * patient's — they are waiting on a redirect or an upload card — and a queue that will not take a row is
 * not their problem: the provider page's Generate button is still there, which is the fallback this trigger
 * exists to make unnecessary rather than to replace.
 */
export async function queueSourAfterImport(visit: { id: string; status: string }, client?: JobClient): Promise<ImportQueueResult> {
  if (!intakeSettled(visit)) {
    // Not an error and not a silence: the data is in and the intake is what the summary is still waiting
    // for, which is the wrapping turn's trigger to queue (app/api/sweetie/route.ts).
    log.info("sour_queue_waiting_for_intake", { visitId: visit.id });
    return { queued: false, reason: "intake_unfinished" };
  }
  try {
    const { job, deduped } = await queueSour(visit.id, client);
    // The same event the wrapping turn writes; `route` on the line (lib/log.ts, withRoute) is which trigger
    // it was, so there is one event name to look for when a summary did not happen (docs/JOBS.md).
    log.info("sour_queued", { visitId: visit.id, jobId: job.id });
    return { queued: true, jobId: job.id, deduped };
  } catch (e) {
    log.error("sour_enqueue_failed", { visitId: visit.id, error: e });
    return { queued: false, reason: "enqueue_failed" };
  }
}
