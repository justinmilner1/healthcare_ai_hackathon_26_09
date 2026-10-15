import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { checkHealth, formatReport, isHealthReport, runCheck, statusOf, type Check, type CheckName, type HealthReport, type Probe } from "./health";
import { LLMUnavailable } from "./llm";
import { setLogSink } from "./log";

// The probes are injected, so none of this needs a database, a bucket or a gateway (design §12.1). What is
// being tested is the part the endpoint's behaviour hangs on: which failures are 503, which are not, that a
// failing dependency never puts its error message in the body, and that the three run at the same time.

const lines: string[] = [];

beforeEach(() => {
  lines.length = 0;
  setLogSink((_level, line) => lines.push(line));
});

afterEach(() => setLogSink());

const ok: Probe = async () => ({ status: "ok", detail: "reachable" });
const skipped: Probe = async () => ({ status: "skipped", detail: "not_configured" });
const failing = (e: unknown): Probe => async () => {
  throw e;
};

const report = (probes: Partial<Record<CheckName, Probe>>) => checkHealth({ db: ok, storage: ok, model: ok, ...probes });

test("all three reachable is ok, with a latency on every check", async () => {
  const r = await report({});
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
  assert.deepEqual(Object.keys(r.checks), ["db", "storage", "model"]);
  for (const [name, check] of Object.entries(r.checks)) {
    assert.equal(check.status, "ok", name);
    assert.equal(typeof check.latencyMs, "number", name);
    assert.ok(check.latencyMs >= 0, `${name} latency should be a duration`);
  }
});

test("a dependency that is not configured is skipped, and a skip is still healthy", async () => {
  // A deployment with no model key is §3.5's scripted mode and the mode the e2e suite runs in; calling it an
  // outage would mean the healthy state is unreachable without Bedrock.
  const r = await report({ model: skipped });
  assert.equal(r.checks.model.status, "skipped");
  assert.equal(r.checks.model.detail, "not_configured");
  assert.equal(r.status, "ok");
  assert.equal(r.ok, true);
});

test("any dependency down takes the whole report down", async () => {
  for (const name of ["db", "storage", "model"] as CheckName[]) {
    const r = await report({ [name]: failing(new Error("connect ECONNREFUSED 10.0.1.5:5432")) });
    assert.equal(r.status, "down", `${name} down should be a down report`);
    assert.equal(r.ok, false, `${name} down should not be ok`);
    assert.equal(r.checks[name].status, "down");
    // The other two still get reported: an operator needs to know whether it is one dependency or all three.
    for (const other of (["db", "storage", "model"] as CheckName[]).filter((n) => n !== name)) {
      assert.equal(r.checks[other].status, "ok", `${other} should still be reported`);
    }
  }
});

test("the report never carries the error message, only a word from the vocabulary", async () => {
  // The route is public (lib/access.test.ts) and a Prisma connection error names the host and the user.
  const secret = "connect ECONNREFUSED sweetspot@db-prod.internal:5432";
  const r = await report({ db: failing(new Error(secret)) });
  assert.equal(r.checks.db.detail, "unreachable");
  assert.equal(JSON.stringify(r).includes("db-prod.internal"), false, "the health body leaked the database host");
  // It is in the log instead, where §10.3 governs it.
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, "health_check_failed");
  assert.equal(logged.check, "db");
  assert.match(logged.error, /ECONNREFUSED/);
});

test("an open circuit is reported as such rather than as an unreachable gateway", async () => {
  // lib/llm.ts has already decided the gateway is failing, and an operator reading the report should be able
  // to tell "nothing is listening" from "this app stopped calling it".
  const r = await report({ model: failing(new LLMUnavailable("circuit_open")) });
  assert.equal(r.checks.model.status, "down");
  assert.equal(r.checks.model.detail, "circuit_open");
});

test("the three checks run together, so the report costs the slowest one and not their sum", async () => {
  const slow = (ms: number): Probe => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { status: "ok", detail: "reachable" };
  };
  const started = Date.now();
  const r = await checkHealth({ db: slow(60), storage: slow(60), model: slow(60) });
  const elapsed = Date.now() - started;
  assert.equal(r.status, "ok");
  assert.ok(elapsed < 150, `three 60ms probes in parallel took ${elapsed}ms; they are running one after another`);
});

test("runCheck times the failure as well as the success", async () => {
  let clock = 1_000;
  const now = () => clock;
  const check = await runCheck("storage", async () => {
    clock += 42;
    throw new Error("nope");
  }, now);
  assert.deepEqual(check, { status: "down", latencyMs: 42, detail: "unreachable" });
});

test("runCheck answers with a report rather than throwing, whatever the probe does", async () => {
  // A 500 from the health endpoint tells an operator nothing about which dependency broke.
  for (const thrown of [new Error("boom"), "a string", undefined, { status: 500 }]) {
    const check = await runCheck("model", failing(thrown));
    assert.equal(check.status, "down");
    assert.equal(check.detail, "unreachable");
  }
});

test("statusOf reads the checks and nothing else", () => {
  const check = (status: Check["status"]): Check => ({ status, latencyMs: 1, detail: "x" });
  assert.equal(statusOf({ db: check("ok"), storage: check("ok"), model: check("ok") }), "ok");
  assert.equal(statusOf({ db: check("ok"), storage: check("skipped"), model: check("skipped") }), "ok");
  assert.equal(statusOf({ db: check("ok"), storage: check("ok"), model: check("down") }), "down");
  assert.equal(statusOf({ db: check("down"), storage: check("down"), model: check("down") }), "down");
});

test("formatReport puts every check on its own line for the deploy gate's log", () => {
  const r: HealthReport = {
    ok: false,
    status: "down",
    checks: {
      db: { status: "ok", latencyMs: 3, detail: "reachable" },
      storage: { status: "down", latencyMs: 1200, detail: "unreachable" },
      model: { status: "skipped", latencyMs: 0, detail: "not_configured" },
    },
  };
  const text = formatReport(r);
  const [first, ...rows] = text.split("\n");
  assert.equal(first, "health: down");
  assert.equal(rows.length, 3);
  assert.match(rows[0], /db\s+ok\s+3ms\s+reachable/);
  assert.match(rows[1], /storage\s+down\s+1200ms\s+unreachable/);
  assert.match(rows[2], /model\s+skipped\s+0ms\s+not_configured/);
});

// ---- isHealthReport: what the deploy gate is allowed to call a pass -------------------------------------

test("isHealthReport accepts a real report and refuses everything else", async () => {
  assert.equal(isHealthReport(await report({})), true);
  assert.equal(isHealthReport(await report({ db: failing(new Error("x")) })), true, "a down report is still a report");

  for (const notOne of [
    null,
    undefined,
    "ok",
    42,
    {},
    { ok: true },
    // A load balancer's error page, parsed: shaped like JSON, not like a report.
    { message: "Service Unavailable" },
    // The build before this ticket: the old endpoint's shape. Reading it as a pass would mean the gate
    // silently stopped checking storage and the gateway.
    { ok: true, db: "ok" },
    // Half a report: two checks, no model.
    { ok: true, status: "ok", checks: { db: { status: "ok", latencyMs: 1, detail: "reachable" }, storage: { status: "ok", latencyMs: 1, detail: "local" } } },
    // A check with a status nobody writes.
    { ok: true, status: "ok", checks: { db: { status: "fine", latencyMs: 1, detail: "x" }, storage: { status: "ok", latencyMs: 1, detail: "x" }, model: { status: "ok", latencyMs: 1, detail: "x" } } },
  ]) {
    assert.equal(isHealthReport(notOne), false, JSON.stringify(notOne) ?? "undefined");
  }
});
