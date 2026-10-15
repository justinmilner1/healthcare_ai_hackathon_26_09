// What `GET /api/health` answers (design §11.2). Owner: ops.
//
// Three dependencies, checked in parallel, each with the time it took: the database, the uploads bucket, and
// the model gateway. Two rules decide what the endpoint does with them:
//
//   1. A check that *fails* makes the whole report `down`, and the route answers 503. That is §11.2's
//      "checks ... reachability" with teeth: a deploy that cannot see its database must not be promoted.
//   2. A dependency that is not configured is `skipped`, not down. A deployment with no model key is the
//      scripted mode §3.5 and §11.3 ask us to support, and the e2e suite runs in it on purpose; calling that
//      an outage would make the healthy state unreachable.
//
// Nothing here echoes an error message back to the caller. The endpoint is public (lib/access.test.ts), and a
// Prisma connection error carries the database host and user. So each check answers with a word from a fixed
// vocabulary — `unreachable`, `circuit_open`, `not_configured` — and the real error goes to the log, scrubbed,
// where §10.3 already governs it.
//
// The probes are injectable because that is the only way to unit-test the report without a database, a bucket
// and a gateway. The route passes none and gets the real three.

import { db } from "./db";
import { gatewayState, LLMUnavailable, probeGateway } from "./llm";
import { log } from "./log";
import { checkStorage } from "./storage";

export type CheckName = "db" | "storage" | "model";
export type CheckStatus = "ok" | "down" | "skipped";

/** `detail` is always one of a fixed set of words — never an error message, never a host name. */
export type Check = { status: CheckStatus; latencyMs: number; detail: string };

export type HealthReport = {
  ok: boolean;
  status: "ok" | "down";
  checks: Record<CheckName, Check>;
};

/** A probe says what it found, or throws. Resolving with `skipped` is how "nothing is configured" differs
 *  from "configured and broken": one is a deployment choice, the other is an outage. */
export type ProbeResult = { status: "ok" | "skipped"; detail: string };
export type Probe = () => Promise<ProbeResult>;
export type Probes = Record<CheckName, Probe>;

/** The cheapest round trip that proves the connection pool can reach Postgres and get an answer back. */
const dbProbe: Probe = async () => {
  await db.$queryRaw`SELECT 1`;
  return { status: "ok", detail: "reachable" };
};

/** Writable local directory, or HeadBucket on S3 (lib/storage.ts). The detail is which backend answered,
 *  because "ok" means different things for a volume and for a bucket and ops needs to know which it got. */
const storageProbe: Probe = async () => ({ status: "ok", detail: await checkStorage() });

/**
 * The gateway, in the order the answers get cheaper:
 *
 *   no key              `skipped`. Scripted mode (§3.5, §11.3), not an outage.
 *   circuit open        `down` without a request. lib/llm.ts has already decided the gateway is failing;
 *                       asking the network again would only make the health check slower than the outage.
 *   anything else       one unauthenticated GET at the base URL. `half_open` falls through to here on
 *                       purpose: the cooldown has elapsed, so this is the moment to look again.
 */
const modelProbe: Probe = async () => {
  if (!process.env.OPENAI_API_KEY) return { status: "skipped", detail: "not_configured" };
  if (gatewayState() === "open") throw new LLMUnavailable("circuit_open");
  await probeGateway();
  return { status: "ok", detail: "reachable" };
};

export const DEFAULT_PROBES: Probes = { db: dbProbe, storage: storageProbe, model: modelProbe };

/** `circuit_open` is the one failure this app diagnosed itself, so it keeps its name; everything else is a
 *  dependency that did not answer, and saying more than that on a public route leaks the topology. */
const reasonOf = (e: unknown): string => (e instanceof LLMUnavailable && e.message === "circuit_open" ? "circuit_open" : "unreachable");

/** Run one probe and time it, whichever way it ends. Never throws: a report is more use than a 500. */
export async function runCheck(name: CheckName, probe: Probe, now: () => number = Date.now): Promise<Check> {
  const started = now();
  try {
    const { status, detail } = await probe();
    return { status, latencyMs: now() - started, detail };
  } catch (e) {
    const latencyMs = now() - started;
    // The only place the real error appears. `error` is scrubbed and capped by lib/log.ts.
    log.error("health_check_failed", { check: name, durationMs: latencyMs, error: e });
    return { status: "down", latencyMs, detail: reasonOf(e) };
  }
}

/** Down if any check is down. `skipped` is a deployment without that dependency, which is still healthy. */
export function statusOf(checks: Record<CheckName, Check>): "ok" | "down" {
  return Object.values(checks).some((c) => c.status === "down") ? "down" : "ok";
}

/**
 * The whole report. The three probes run together rather than one after another, so the endpoint costs about
 * as long as its slowest dependency — a load balancer's timeout is the budget, not three of them.
 */
export async function checkHealth(probes: Partial<Probes> = {}, now: () => number = Date.now): Promise<HealthReport> {
  const use = { ...DEFAULT_PROBES, ...probes };
  const names: CheckName[] = ["db", "storage", "model"];
  const results = await Promise.all(names.map((name) => runCheck(name, use[name], now)));
  const checks = Object.fromEntries(names.map((name, i) => [name, results[i]])) as Record<CheckName, Check>;
  const status = statusOf(checks);
  return { ok: status === "ok", status, checks };
}

/** One line per check, for `npm run health:check` — the post-deploy gate (§13.3) and anyone with a terminal. */
export function formatReport(report: HealthReport): string {
  const rows = (Object.entries(report.checks) as [CheckName, Check][]).map(
    ([name, c]) => `  ${name.padEnd(8)} ${c.status.padEnd(8)} ${String(c.latencyMs).padStart(5)}ms  ${c.detail}`,
  );
  return [`health: ${report.status}`, ...rows].join("\n");
}
