// npm run jobs:drain  -- drain the job queue from a terminal (design §3.4).
//
// In AWS, EventBridge Scheduler calls POST /api/jobs/run every minute. Locally there is no scheduler: the app
// drains inline after each request (lib/jobs.ts, jobsRunner), and this script is the other half of that — for
// a queue that was filled while nothing was draining it, for retrying a job whose backoff has expired, and for
// watching the queue while developing a handler.
//
//   npm run jobs:drain              drain everything due now, print the report, exit
//   npm run jobs:drain -- --watch   keep draining every 5 seconds until Ctrl-C
//   npm run jobs:drain -- --list    print the queue and exit, running nothing

import "dotenv/config";
import { db } from "../lib/db";
import { drainJobs } from "../lib/jobs";
import { scheduleRetentionSweep } from "../lib/retentionStore";

const WATCH_MS = 5000;

async function list() {
  const jobs = await db.job.findMany({ orderBy: [{ status: "asc" }, { runAfter: "asc" }], take: 50 });
  if (jobs.length === 0) return console.log("queue is empty");
  for (const j of jobs) {
    const due = j.runAfter > new Date() ? ` due ${j.runAfter.toISOString()}` : "";
    console.log(`${j.status.padEnd(7)} ${j.kind.padEnd(15)} attempt ${j.attempts}${due}${j.lastError ? ` — ${j.lastError}` : ""}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) return list();

  const once = async () => {
    // The same daily sweep the runner route queues (design §10.4): an environment with no scheduler still
    // sweeps when somebody drains the queue, and the twenty-hour window keeps --watch from queueing a second.
    if (await scheduleRetentionSweep()) console.log("queued the nightly retention sweep");
    const report = await drainJobs();
    if (report.claimed > 0 || !args.includes("--watch")) {
      console.log(`claimed ${report.claimed}, done ${report.done}, retried ${report.retried}, failed ${report.failed}`);
    }
  };

  await once();
  if (!args.includes("--watch")) return;
  console.log(`watching the queue every ${WATCH_MS / 1000}s; Ctrl-C to stop`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
    await once();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
