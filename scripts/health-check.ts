// npm run health:check — the deploy health check (design §11.2, §13.3). Owner: ops.
//
// Asks a running deployment's `/api/health` whether it can see its database, its uploads bucket and the model
// gateway, prints the per-check table, and exits 1 if any of them is down. This is the gate between "the new
// version is running" and "traffic goes to it": a release that cannot reach Postgres must not be promoted,
// and finding that out here costs one request instead of one patient's intake.
//
//   npm run health:check                              against APP_URL
//   npm run health:check -- --url https://host         against anything else
//   npm run health:check -- --attempts 10 --delay 3    while a new task is still coming up
//
// It retries because a deploy is a race: the task is registered before it has opened its pool. A *down*
// report is retried for the same reason; only the last attempt decides. The liveness path next door is the
// load balancer's business, not this script's — see app/api/health/route.ts for why they are separate.

import { config as loadEnv } from "dotenv";
import { formatReport, isHealthReport } from "../lib/health";

loadEnv();

/** `--url x` / `--url=x`, with a default. */
function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

const base = arg("url", process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const url = `${base}/api/health`;
const attempts = Math.max(1, Number(arg("attempts", "5")));
const delayMs = Math.max(0, Number(arg("delay", "3")) * 1000);
const timeoutMs = Math.max(1, Number(arg("timeout", "10")) * 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One attempt: the HTTP status, and the report when the body was one. */
async function attempt(): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
}

console.log(`health check: ${url}`);

for (let n = 1; n <= attempts; n++) {
  const last = n === attempts;
  let status = 0;
  let body = "";
  try {
    ({ status, body } = await attempt());
  } catch (e) {
    // Not up yet, or not up at all. Either way there is nothing to parse.
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.log(`  attempt ${n}/${attempts}: no answer (${reason})`);
    if (last) process.exit(1);
    await sleep(delayMs);
    continue;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }

  if (!isHealthReport(parsed)) {
    // A load balancer's own error page, or a build too old to have this endpoint. Not a health report, so it
    // is not a pass, and the body is worth seeing rather than summarising.
    console.log(`  attempt ${n}/${attempts}: HTTP ${status}, and the body is not a health report: ${body.slice(0, 200)}`);
    if (last) process.exit(1);
    await sleep(delayMs);
    continue;
  }

  console.log(`  attempt ${n}/${attempts}: HTTP ${status}`);
  console.log(formatReport(parsed));
  if (status === 200 && parsed.ok) process.exit(0);
  if (last) process.exit(1);
  await sleep(delayMs);
}
