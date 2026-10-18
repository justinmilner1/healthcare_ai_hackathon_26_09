// Unit tests for the three §7.1 triggers' shared queueing (T72): the key, the gate on the intake, and what
// the import trigger does when the queue will not take a row.
//
// No Postgres. `enqueue` only ever touches `client.job`, so the fake below is the whole database it needs —
// which is also how the dedupe branch is reachable at all: a unique violation on the idempotency key is a
// race between two writers, and here it is just the next answer the fake is told to give.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { JobClient } from "./jobs";
import { setLogSink } from "./log";
import { INTAKE_SETTLED_STATUSES, intakeSettled, queueSour, queueSourAfterImport, sourJobKey } from "./sourQueue";

type Created = { kind: string; payload: string; idempotencyKey: string | null; runAfter: Date };

/** A `Job` table of one row, and the two calls lib/jobs.ts makes against it. `conflict` makes the insert
 *  answer the way Postgres does when the idempotency key is already held by a job in flight. */
function fakeJobs({ conflict = false, broken = false } = {}) {
  const created: Created[] = [];
  const existing = { id: "job-in-flight", kind: "sour.run", status: "running" };
  const client = {
    job: {
      create: async ({ data }: { data: Created }) => {
        if (broken) throw new Error("the queue is down");
        if (conflict) throw Object.assign(new Error("duplicate key"), { code: "P2002" });
        created.push(data);
        return { id: `job-${created.length}`, ...data, status: "queued" };
      },
      findUnique: async () => (conflict ? existing : null),
    },
  } as unknown as JobClient;
  return { client, created };
}

/** The log lines a call wrote, so the "nothing happened silently" claims can be asserted. */
function captureLog() {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  return lines;
}

afterEach(() => setLogSink());

describe("sourJobKey", () => {
  it("is one in-flight run per visit", () => {
    assert.equal(sourJobKey("v1"), "sour.run:v1");
    assert.notEqual(sourJobKey("v1"), sourJobKey("v2"));
  });
});

describe("queueSour", () => {
  it("queues one sour.run for the visit, keyed so a second enqueue joins it", async () => {
    captureLog();
    const { client, created } = fakeJobs();
    const { job, deduped } = await queueSour("v1", client);
    assert.equal(deduped, false);
    assert.equal(job.kind, "sour.run");
    assert.equal(created.length, 1);
    const { runAfter, ...row } = created[0];
    assert.deepEqual(row, { kind: "sour.run", payload: JSON.stringify({ visitId: "v1" }), idempotencyKey: "sour.run:v1" });
    // Due now: the readings are already committed, so there is nothing for the run to wait for.
    assert.ok(runAfter.getTime() <= Date.now() && runAfter.getTime() > Date.now() - 60_000);
  });

  it("joins the job already in flight rather than paying for a second pair of model calls", async () => {
    captureLog();
    const { client, created } = fakeJobs({ conflict: true });
    const { job, deduped } = await queueSour("v1", client);
    assert.equal(deduped, true);
    assert.equal(job.id, "job-in-flight");
    assert.equal(created.length, 0);
  });
});

describe("intakeSettled", () => {
  it("is the statuses in which the intake has had its say, and nothing earlier", () => {
    for (const status of INTAKE_SETTLED_STATUSES) assert.equal(intakeSettled({ status }), true, status);
    assert.deepEqual([...INTAKE_SETTLED_STATUSES], ["intake_done", "summary_ready", "reviewed"]);
    // A visit still being interviewed, and one the practice cancelled: §7.1's other trigger covers the
    // first when it wraps, and nothing should summarize the second.
    for (const status of ["invited", "verified", "in_intake", "cancelled"]) {
      assert.equal(intakeSettled({ status }), false, status);
    }
  });
});

describe("queueSourAfterImport", () => {
  it("queues the run for a visit whose intake was already done", async () => {
    const lines = captureLog();
    const { client, created } = fakeJobs();
    const result = await queueSourAfterImport({ id: "v1", status: "intake_done" }, client);
    assert.deepEqual(result, { queued: true, jobId: "job-1", deduped: false });
    assert.equal(created.length, 1);
    assert.equal(created[0].idempotencyKey, "sour.run:v1");
    assert.ok(lines.some((l) => l.includes("sour_queued")), lines.join("\n"));
  });

  it("re-runs a visit that has been summarized before: new readings are a regenerate", async () => {
    captureLog();
    const { client, created } = fakeJobs();
    assert.equal((await queueSourAfterImport({ id: "v1", status: "summary_ready" }, client)).queued, true);
    assert.equal((await queueSourAfterImport({ id: "v2", status: "reviewed" }, client)).queued, true);
    assert.equal(created.length, 2);
  });

  it("leaves a visit mid-intake to the wrapping turn, and says so in the log", async () => {
    const lines = captureLog();
    const { client, created } = fakeJobs();
    for (const status of ["invited", "verified", "in_intake"]) {
      assert.deepEqual(await queueSourAfterImport({ id: "v1", status }, client), { queued: false, reason: "intake_unfinished" });
    }
    assert.equal(created.length, 0, "no run against half an interview");
    assert.equal(lines.filter((l) => l.includes("sour_queue_waiting_for_intake")).length, 3);
    assert.ok(!lines.some((l) => l.includes("sour_queued\"")), "and nothing claiming one was queued");
  });

  it("does not fail the patient's import when the queue will not take the row", async () => {
    const lines = captureLog();
    const { client } = fakeJobs({ broken: true });
    const result = await queueSourAfterImport({ id: "v1", status: "intake_done" }, client);
    assert.deepEqual(result, { queued: false, reason: "enqueue_failed" });
    assert.ok(lines.some((l) => l.includes("sour_enqueue_failed")), lines.join("\n"));
  });

  it("joins the clinician's run rather than queueing beside it", async () => {
    captureLog();
    const { client } = fakeJobs({ conflict: true });
    assert.deepEqual(await queueSourAfterImport({ id: "v1", status: "intake_done" }, client), { queued: true, jobId: "job-in-flight", deduped: true });
  });
});
