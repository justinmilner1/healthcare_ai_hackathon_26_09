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

async function postHandler(req: Request) {
  const auth = authorizeRunner(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const report = await drainJobs();
  // One line per job is written by the drain itself (job_done, job_retry, job_failed), which is what an alarm
  // reads; this is just the shape of the call. The full report goes back to the caller in the body.
  log.info("job_drain", { count: report.claimed });
  return NextResponse.json(report);
}

export const POST = withRoute("POST /api/jobs/run", postHandler);
