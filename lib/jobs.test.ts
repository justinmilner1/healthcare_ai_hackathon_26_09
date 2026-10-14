// Unit tests for the job queue (T04, design §3.4): claiming, retry with backoff, and idempotency.
//
// Two halves. The pure half — backoff arithmetic and the runner's shared-secret check — runs anywhere. The
// queue half needs Postgres, because the claim is one `UPDATE ... FOR UPDATE SKIP LOCKED` statement and that
// is exactly the part worth testing for real; like lib/migrateVisits.test.ts it builds a throwaway schema in
// whatever server DATABASE_URL points at and drops it at the end, and skips when there is no DATABASE_URL so
// `npm test` still works on a laptop with no database up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { authorizeRunner, backoffMs, BACKOFF_MS, claimDueJobs, drainJobs, enqueue, jobsRunner, jobStateView, latestJobForVisit, MAX_ATTEMPTS, reapStuckJobs, STUCK_AFTER_MS, STUCK_ERROR, type JobHandlers } from "./jobs";
import { setLogSink } from "./log";

// ---------------------------------------------------------------------------------------------
// No database needed

describe("backoff", () => {
  it("waits a minute, then five, and never runs off the end of the table", () => {
    assert.equal(backoffMs(1), 60_000);
    assert.equal(backoffMs(2), 300_000);
    assert.equal(backoffMs(0), BACKOFF_MS[0], "a zeroth attempt still gets the first wait");
    assert.equal(backoffMs(MAX_ATTEMPTS + 5), BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
});

describe("authorizeRunner", () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it("refuses to run at all when no secret is configured", () => {
    const auth = authorizeRunner(headers({ authorization: "Bearer anything" }), undefined);
    assert.deepEqual(auth, { ok: false, status: 503, error: "jobs runner is not configured" });
    assert.equal(authorizeRunner(headers({}), "   ").ok, false, "whitespace is not a secret");
  });

  it("takes the secret as a bearer token or an x-jobs-secret header", () => {
    assert.deepEqual(authorizeRunner(headers({ authorization: "Bearer s3cret" }), "s3cret"), { ok: true });
    assert.deepEqual(authorizeRunner(headers({ Authorization: "bearer s3cret" }), "s3cret"), { ok: true });
    assert.deepEqual(authorizeRunner(headers({ "x-jobs-secret": "s3cret" }), "s3cret"), { ok: true });
  });

  it("rejects a wrong, missing, or truncated secret", () => {
    const wrong: Record<string, string>[] = [{}, { authorization: "Bearer " }, { authorization: "Bearer s3cre" }, { "x-jobs-secret": "s3cretx" }];
    for (const given of wrong) {
      assert.deepEqual(authorizeRunner(headers(given), "s3cret"), { ok: false, status: 401, error: "unauthorized" });
    }
  });
});

describe("jobsRunner", () => {
  const saved = { secret: process.env.JOBS_SECRET, mode: process.env.JOBS_RUNNER };
  const restore = () => {
    for (const [key, value] of [["JOBS_SECRET", saved.secret], ["JOBS_RUNNER", saved.mode]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  after(restore);

  it("drains inline until a secret says something else is doing it", () => {
    delete process.env.JOBS_RUNNER;
    delete process.env.JOBS_SECRET;
    assert.equal(jobsRunner(), "inline");
    process.env.JOBS_SECRET = "from-eventbridge";
    assert.equal(jobsRunner(), "scheduled");
    process.env.JOBS_RUNNER = "inline";
    assert.equal(jobsRunner(), "inline", "an explicit mode wins over the secret");
    restore();
  });
});

// ---------------------------------------------------------------------------------------------
// The queue itself, against Postgres

const SERVER_URL = process.env.DATABASE_URL;
const schema = `jobstest_${randomBytes(4).toString("hex")}`;

const fixtureUrl = (base: string) => {
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
};

describe("job queue", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = fixtureUrl(SERVER_URL!);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url });
    // The queue logs a line per job; tests assert on the rows, not on stdout.
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await db.job.deleteMany({});
  });

  /** A handler table whose jobs record what ran, and can be told to throw. */
  const spy = (behaviour: (payload: Record<string, unknown>) => void = () => {}) => {
    const seen: Record<string, unknown>[] = [];
    const handlers: JobHandlers = {
      "sour.run": async (payload) => {
        seen.push(payload);
        behaviour(payload);
      },
    };
    return { seen, handlers };
  };

  describe("claim", () => {
    it("takes due jobs oldest first, marks them running, and counts the attempt", async () => {
      const now = new Date("2026-10-11T12:00:00.000Z");
      const older = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, runAfter: new Date("2026-10-11T11:00:00.000Z") }, db);
      const newer = await enqueue({ kind: "sour.run", payload: { visitId: "v2" }, runAfter: new Date("2026-10-11T11:30:00.000Z") }, db);

      const claimed = await claimDueJobs(10, db, now);
      assert.deepEqual(claimed.map((j) => j.id), [older.job.id, newer.job.id]);
      assert.deepEqual(claimed.map((j) => j.status), ["running", "running"]);
      assert.deepEqual(claimed.map((j) => j.attempts), [1, 1]);
      assert.equal(claimed[0].startedAt?.toISOString(), now.toISOString());
    });

    it("leaves a job whose backoff has not expired alone", async () => {
      const now = new Date("2026-10-11T12:00:00.000Z");
      await enqueue({ kind: "sour.run", payload: { visitId: "later" }, runAfter: new Date("2026-10-11T12:00:01.000Z") }, db);
      assert.deepEqual(await claimDueJobs(10, db, now), []);
    });

    it("never hands the same job to a second runner", async () => {
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      const first = await claimDueJobs(10, db);
      const second = await claimDueJobs(10, db);
      assert.equal(first.length, 1);
      assert.deepEqual(second, [], "a claimed job is running, not queued");
    });

    it("honours the batch limit", async () => {
      for (const visitId of ["a", "b", "c"]) await enqueue({ kind: "sour.run", payload: { visitId } }, db);
      assert.equal((await claimDueJobs(2, db)).length, 2);
      assert.equal((await claimDueJobs(2, db)).length, 1);
    });
  });

  describe("drain", () => {
    it("runs the handler with the payload and marks the job done", async () => {
      const { seen, handlers } = spy();
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);

      const report = await drainJobs({ handlers, client: db });
      assert.deepEqual(report, { claimed: 1, done: 1, retried: 0, failed: 0 });
      assert.deepEqual(seen, [{ visitId: "v1" }]);

      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "done");
      assert.equal(row.attempts, 1);
      assert.equal(row.lastError, null);
      assert.ok(row.finishedAt);
    });

    it("drains a backlog larger than one batch, and stops at maxJobs", async () => {
      const { seen, handlers } = spy();
      for (const visitId of ["a", "b", "c", "d", "e"]) await enqueue({ kind: "sour.run", payload: { visitId } }, db);

      assert.equal((await drainJobs({ handlers, client: db, limit: 2, maxJobs: 4 })).done, 4);
      assert.equal(seen.length, 4);
      assert.equal(await db.job.count({ where: { status: "queued" } }), 1);

      assert.equal((await drainJobs({ handlers, client: db, limit: 2 })).done, 1);
      assert.equal(await db.job.count({ where: { status: "done" } }), 5);
    });

    it("fails a job whose kind has no handler", async () => {
      const { job } = await enqueue({ kind: "patient.delete", payload: { visitId: "v1" } }, db);
      const report = await drainJobs({ handlers: {}, client: db });
      assert.equal(report.retried, 1, "the first of three attempts");
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.match(row.lastError ?? "", /no handler for job kind patient.delete/);
    });
  });

  describe("retry", () => {
    it("backs off between attempts and fails after three, keeping the error", async () => {
      const { handlers } = spy(() => {
        throw new Error("gateway timed out");
      });
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);

      // Attempt 1: back on the queue, a minute out.
      assert.deepEqual(await drainJobs({ handlers, client: db }), { claimed: 1, done: 0, retried: 1, failed: 0 });
      let row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "queued");
      assert.equal(row.attempts, 1);
      assert.match(row.lastError ?? "", /gateway timed out/);
      assert.ok(row.runAfter.getTime() - Date.now() > 50_000, "waits about a minute");
      assert.equal(row.startedAt, null, "the next attempt gets its own start time");

      // A drain now claims nothing: the backoff is the point.
      assert.deepEqual(await drainJobs({ handlers, client: db }), { claimed: 0, done: 0, retried: 0, failed: 0 });

      // Attempt 2, once the minute is up: five minutes out.
      let now = new Date(Date.now() + 61_000);
      assert.equal((await drainJobs({ handlers, client: db, now })).retried, 1);
      row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.attempts, 2);
      assert.ok(row.runAfter.getTime() - Date.now() > 250_000, "waits about five minutes");

      // Attempt 3 is the last (MAX_ATTEMPTS): failed, with the error kept and the key released.
      now = new Date(Date.now() + 301_000);
      assert.deepEqual(await drainJobs({ handlers, client: db, now }), { claimed: 1, done: 0, retried: 0, failed: 1 });
      row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "failed");
      assert.equal(row.attempts, MAX_ATTEMPTS);
      assert.match(row.lastError ?? "", /gateway timed out/);
      assert.ok(row.finishedAt);
      assert.equal(row.idempotencyKey, null, "a permanently failed job does not block a fresh request");
    });

    it("keeps PHI-shaped text out of lastError", async () => {
      const { handlers } = spy(() => {
        throw new Error("SES rejected sam@example.com (+1 415 555 0132)");
      });
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await drainJobs({ handlers, client: db });
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.lastError, "Error: SES rejected [email] ([number])");
    });

    it("counts the attempt even when the process dies mid-job", async () => {
      // A claim that is never finished is what a crashed runner leaves behind: the attempt is already spent,
      // so the row cannot be retried forever.
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await claimDueJobs(10, db);
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.attempts, 1);
      assert.equal(row.status, "running");
    });
  });

  describe("stuck jobs", () => {
    /** Enqueue, claim, and then pretend the runner died `agoMs` ago without reporting back. */
    const abandoned = async (agoMs: number, over: { attempts?: number; idempotencyKey?: string } = {}) => {
      const { job } = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: over.idempotencyKey }, db);
      await claimDueJobs(10, db);
      return db.job.update({
        where: { id: job.id },
        data: { startedAt: new Date(Date.now() - agoMs), ...(over.attempts === undefined ? {} : { attempts: over.attempts }) },
      });
    };

    it("leaves a job alone while it is still inside the lease", async () => {
      const job = await abandoned(STUCK_AFTER_MS - 60_000);
      assert.deepEqual(await reapStuckJobs(db), { requeued: 0, failed: 0 });
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "running", "a slow handler is not a dead one");
      assert.equal(row.attempts, 1);
    });

    it("puts a job a dead runner left running back on the queue, keeping its key", async () => {
      const job = await abandoned(STUCK_AFTER_MS + 1000, { idempotencyKey: "sour.run:v1" });
      assert.deepEqual(await reapStuckJobs(db), { requeued: 1, failed: 0 });
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "queued");
      assert.equal(row.attempts, 1, "the attempt it spent is not given back");
      assert.equal(row.startedAt, null);
      assert.equal(row.lastError, STUCK_ERROR);
      assert.ok(row.runAfter.getTime() - Date.now() > 50_000, "comes back after a backoff, not instantly");
      assert.equal(row.idempotencyKey, "sour.run:v1", "the work is still owed, so it still holds the key");

      // And it really does run on the next drain, once the backoff is up.
      const { seen, handlers } = spy();
      assert.equal((await drainJobs({ handlers, client: db, now: new Date(Date.now() + 61_000) })).done, 1);
      assert.deepEqual(seen, [{ visitId: "v1" }]);
    });

    it("fails a stranded job that has spent all three attempts, and releases its key", async () => {
      const job = await abandoned(STUCK_AFTER_MS + 1000, { attempts: MAX_ATTEMPTS, idempotencyKey: "sour.run:v1" });
      assert.deepEqual(await reapStuckJobs(db), { requeued: 0, failed: 1 });
      const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(row.status, "failed");
      assert.equal(row.lastError, STUCK_ERROR);
      assert.ok(row.finishedAt);
      assert.equal(row.idempotencyKey, null);
    });

    it("a stranded job does not swallow the next request for the same work for ever", async () => {
      // The reason this matters: while the corpse holds the key, Generate joins it instead of starting a
      // summary, and the clinician waits on a job that can never finish.
      await abandoned(STUCK_AFTER_MS + 1000, { attempts: MAX_ATTEMPTS, idempotencyKey: "sour.run:v1" });
      assert.equal((await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db)).deduped, true);

      await drainJobs({ handlers: spy().handlers, client: db });
      const again = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      assert.equal(again.deduped, false, "once the corpse is reaped, asking again is new work");
    });
  });

  describe("idempotency", () => {
    it("joins an in-flight job instead of queueing the same work twice", async () => {
      const first = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      const second = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      assert.equal(second.deduped, true);
      assert.equal(second.job.id, first.job.id);
      assert.equal(await db.job.count(), 1);

      // Still true once it is running, which is the double-click the key exists for.
      await claimDueJobs(10, db);
      const third = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      assert.equal(third.job.id, first.job.id);
      assert.equal(await db.job.count(), 1);
    });

    it("lets the same work be asked for again once it has finished", async () => {
      const { handlers } = spy();
      const first = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      await drainJobs({ handlers, client: db });

      const again = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      assert.equal(again.deduped, false, "a clinician asking for a fresh summary is new work");
      assert.notEqual(again.job.id, first.job.id);
      assert.equal(await db.job.count(), 2);
    });

    it("does not collapse different work, or jobs enqueued without a key", async () => {
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      await enqueue({ kind: "sour.run", payload: { visitId: "v2" }, idempotencyKey: "sour.run:v2" }, db);
      await enqueue({ kind: "notify.invite", payload: { visitId: "v1" }, idempotencyKey: "notify.invite:v1" }, db);
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      assert.equal(await db.job.count(), 5);
    });
  });

  // T15 (§7.2): the provider page reads its state back from the queue, so a clinician can see where a
  // summary got to. The wording on top of this is lib/sourState.test.ts.
  describe("reading a job back for a visit", () => {
    it("finds the newest job of that kind for that visit, and nobody else's", async () => {
      const older = await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await new Promise((r) => setTimeout(r, 3)); // distinct createdAt, so "newest" has one answer
      const newer = await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await enqueue({ kind: "sour.run", payload: { visitId: "v2" } }, db);
      await enqueue({ kind: "notify.summary", payload: { visitId: "v1" } }, db);

      assert.equal((await latestJobForVisit("sour.run", "v1", db))?.id, newer.job.id);
      assert.notEqual(newer.job.id, older.job.id);
      assert.equal((await latestJobForVisit("sour.run", "nobody", db)), null);
      assert.equal(await latestJobForVisit("sour.run", "", db), null, "an empty id is not a visit");
    });

    it("does not mistake a visit id that merely appears elsewhere in a payload", async () => {
      // The query narrows on the serialized key in Postgres and then confirms by parsing, so a future
      // payload carrying someone else's id in another field cannot be read as this visit's job.
      await enqueue({ kind: "sour.run", payload: { visitId: "other", requestedBy: "v1" } }, db);
      assert.equal(await latestJobForVisit("sour.run", "v1", db), null);
      assert.equal((await latestJobForVisit("sour.run", "other", db))?.payload, JSON.stringify({ visitId: "other", requestedBy: "v1" }));
    });

    it("follows one job through queued, running, retrying and failed", async () => {
      // The same sequence a clinician watches on the page: each view is read from the row the drain left.
      const { handlers } = spy(() => {
        throw new Error("gateway said no");
      });
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);

      const queued = jobStateView((await latestJobForVisit("sour.run", "v1", db))!);
      assert.equal(queued.status, "queued");
      assert.equal(queued.attempts, 0);
      assert.equal(queued.maxAttempts, MAX_ATTEMPTS);
      assert.equal(queued.lastError, null);
      assert.equal(queued.startedAt, null);

      await claimDueJobs(10, db);
      const running = jobStateView((await latestJobForVisit("sour.run", "v1", db))!);
      assert.equal(running.status, "running");
      assert.equal(running.attempts, 1);
      assert.ok(running.startedAt, "a running job says when it started");

      // First failure: back on the queue after a backoff, with the reason already readable.
      await db.job.update({ where: { id: (await latestJobForVisit("sour.run", "v1", db))!.id }, data: { status: "queued", startedAt: null } });
      await drainJobs({ handlers, client: db });
      const retrying = jobStateView((await latestJobForVisit("sour.run", "v1", db))!);
      assert.equal(retrying.status, "queued");
      assert.equal(retrying.attempts, 2);
      assert.match(retrying.lastError ?? "", /gateway said no/);
      assert.ok(Date.parse(retrying.runAfter) > Date.now(), "a retry waits out its backoff");

      // Spend the last attempt: failed, with the reason kept for the page (§7.2).
      await db.job.update({ where: { id: (await latestJobForVisit("sour.run", "v1", db))!.id }, data: { attempts: MAX_ATTEMPTS - 1, runAfter: new Date() } });
      await drainJobs({ handlers, client: db });
      const failed = jobStateView((await latestJobForVisit("sour.run", "v1", db))!);
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, MAX_ATTEMPTS);
      assert.match(failed.lastError ?? "", /gateway said no/);
      assert.ok(failed.finishedAt, "a failed job says when it gave up");

      // And the retry the page offers is a real new job, because the failure released the key.
      const retried = await enqueue({ kind: "sour.run", payload: { visitId: "v1" }, idempotencyKey: "sour.run:v1" }, db);
      assert.equal(retried.deduped, false);
      assert.equal((await latestJobForVisit("sour.run", "v1", db))?.id, retried.job.id);
      assert.equal(jobStateView(retried.job).status, "queued");
    });

    it("reports a job that succeeded as done, with no error left over", async () => {
      await enqueue({ kind: "sour.run", payload: { visitId: "v1" } }, db);
      await drainJobs({ handlers: spy().handlers, client: db });
      const done = jobStateView((await latestJobForVisit("sour.run", "v1", db))!);
      assert.equal(done.status, "done");
      assert.equal(done.lastError, null);
      assert.ok(done.finishedAt);
    });
  });
});
