// POST /api/jobs/run  -> drains every due job. Owner: platform.
//
// The runner from design §3.4. EventBridge Scheduler calls it once a minute with the shared secret in
// `Authorization: Bearer <JOBS_SECRET>`; the response is the drain report, which is what the CloudWatch alarm
// on failed jobs reads. Transport only: the queue is lib/jobs.ts and the work is lib/jobHandlers.ts.
//
// Without JOBS_SECRET the route refuses (503) rather than falling open — see jobsRunner(): that deployment
// drains inline after each request instead, which is how local development, the demo and the e2e suite run.

import { NextResponse } from "next/server";
import { authorizeRunner, drainJobs } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { scheduleRetentionSweep } from "@/lib/retentionStore";

async function postHandler(req: Request) {
  const auth = authorizeRunner(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // §10.4's "nightly" wants a clock, and this tick is the only one the app has. scheduleRetentionSweep
  // queues a sweep at most once in twenty hours, so a minute-by-minute schedule still sweeps once a day, and
  // an environment with no second EventBridge rule still sweeps at all. Before the drain, so the sweep it
  // queues runs in this same pass rather than waiting for the next minute.
  const sweep = await scheduleRetentionSweep();
  const report = await drainJobs();
  // One line per job is written by the drain itself (job_done, job_retry, job_failed), which is what an alarm
  // reads; this is just the shape of the call. The full report goes back to the caller in the body.
  log.info("job_drain", { count: report.claimed });
  return NextResponse.json({ ...report, sweepQueued: Boolean(sweep) });
}

export const POST = withRoute("POST /api/jobs/run", postHandler);
