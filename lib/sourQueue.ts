// Where a `sour.run` job comes from (design §7.1, docs/JOBS.md). Owner: platform.
//
// §7.1 names three things that enqueue a run — intake wrapping, a Dexcom import completing, and the
// provider page's Generate button — and all three want the same row: `sour.run` for one visit, keyed so
// that two of them arriving together is one run and not two pairs of model calls (lib/jobs.ts, enqueue).
// The key lives here rather than being spelled out at each call site, because the triggers are only correct
// as a set: a summary needs the intake *and* the readings, and either one can be the last to arrive.
//
//   intake wraps      queues when the visit already has Dexcom data   (app/api/sweetie/route.ts)
//   data arrives      queues when the intake is already done          (queueSourAfterImport below)
//   Generate          queues whatever the state is — a clinician asked (app/api/sour/route.ts)
//
// The two patient-side triggers are each other's mirror image, which is what makes "whichever half lands
// second queues the run" true without either of them knowing about the other, and what keeps the pair from
// queueing twice when they land together.

import { enqueue, type EnqueueResult, type JobClient } from "./jobs";
import { log } from "./log";

/** One in-flight `sour.run` per visit (lib/jobs.ts: the key is released when the job finishes). */
export const sourJobKey = (visitId: string) => `sour.run:${visitId}`;

/** Put a `sour.run` on the queue for this visit. The caller still has to `nudge(after)` so a deployment
 *  with no scheduler drains it (docs/JOBS.md); that needs `after` from next/server and stays in the route. */
export const queueSour = (visitId: string, client?: JobClient): Promise<EnqueueResult> =>
  enqueue({ kind: "sour.run", payload: { visitId }, idempotencyKey: sourJobKey(visitId) }, client);

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
