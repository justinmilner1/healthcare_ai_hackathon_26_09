// Background jobs: the queue mechanics (design §3.4, §4.9). Owner: platform.
//
// Why a table instead of awaiting the work in the request: Sour takes two model calls and SES takes a round
// trip, so doing either inline makes a patient or a clinician wait for something they are not reading, and a
// crash or a cold Lambda loses it with no record. A `Job` row is the durable unit of work: it says what to do
// (kind + payload), when it may run (runAfter), how often it has been tried (attempts) and why it last failed
// (lastError). Nothing in a payload is PHI — a visit id and nothing else — because the row outlives the
// request and the handler can read the visit back from the database.
//
// Who drains it: in production EventBridge Scheduler calls `POST /api/jobs/run` every minute with the shared
// secret (§3.4). Locally there is no scheduler, so the request that enqueues also drains after its response
// (see jobsRunner and nudge below), and `npm run jobs:drain` does it from a terminal.
//
// This module deliberately knows nothing about Sour or email: the handlers live in lib/jobHandlers.ts and are
// loaded only when a job actually runs, which keeps the queue unit-testable without the model or the AWS SDK.

import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "./db";
import { log, scrub } from "./log";
import type { SourJobState } from "./types";

/** Every kind the runner knows how to be asked for (§3.4). A kind with no handler fails the job. */
export const JOB_KINDS = ["sour.run", "notify.invite", "notify.code", "notify.summary", "patient.delete", "retention.sweep"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobStatus = "queued" | "running" | "done" | "failed";

/** One row of `Job`. Written out rather than imported from @prisma/client so the raw claim below, which
 *  returns the same columns, and the Prisma delegate agree on one type. */
export type JobRow = {
  id: string;
  kind: string;
  payload: string;
  status: string;
  attempts: number;
  runAfter: Date;
  lastError: string | null;
  idempotencyKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Just the parts of the client the queue uses, so a test can hand it one pointed at a fixture schema. */
export type JobClient = Pick<PrismaClient, "job" | "$queryRaw">;

/** Three attempts, then failed with the error recorded (§3.4). */
export const MAX_ATTEMPTS = 3;

/** How long a failed job waits before the next attempt: a minute, then five. */
export const BACKOFF_MS = [60_000, 300_000];

/** The wait after `attempts` failed attempts. The last value repeats if MAX_ATTEMPTS ever grows past it. */
export const backoffMs = (attempts: number) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];

export type JobPayload = Record<string, unknown>;

export type EnqueueInput = {
  kind: JobKind;
  payload?: JobPayload;
  /** Collapses duplicate work while it is in flight; see enqueue. */
  idempotencyKey?: string | null;
  runAfter?: Date;
};

export type EnqueueResult = { job: JobRow; deduped: boolean };

/**
 * Put one job on the queue.
 *
 * With an `idempotencyKey`, enqueueing is idempotent *while the work is in flight*: as long as a job with that
 * key is queued or running, a second enqueue joins it instead of creating a second one, so a double-clicked
 * "Send link", and an intake that wraps while the clinician is already pressing Generate, each do their thing
 * once. The key is released the moment the job reaches `done` or `failed`, so a later identical request is new
 * work — a clinician asking for a fresh summary, or staff resending a link an hour later, must not be
 * swallowed by a job that has already run. Idempotency over the *inputs* of a summary (§7.1: unchanged inputs
 * return the existing summary) is a different question with a different answer, and it lives in Sour rather
 * than here: lib/sourInput.ts fingerprints the inputs and lib/sourRun.ts looks the fingerprint up.
 */
export async function enqueue(input: EnqueueInput, client: JobClient = db): Promise<EnqueueResult> {
  const data = {
    kind: input.kind,
    payload: JSON.stringify(input.payload ?? {}),
    idempotencyKey: input.idempotencyKey ?? null,
    runAfter: input.runAfter ?? new Date(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const job = (await client.job.create({ data })) as JobRow;
      log.info("job_enqueued", { jobId: job.id, kind: job.kind });
      return { job, deduped: false };
    } catch (e) {
      if (!isUniqueViolation(e) || !data.idempotencyKey) throw e;
      const existing = (await client.job.findUnique({ where: { idempotencyKey: data.idempotencyKey } })) as JobRow | null;
      if (!existing) continue; // the holder finished between the insert and the read: try once more
      log.info("job_deduped", { jobId: existing.id, kind: existing.kind });
      return { job: existing, deduped: true };
    }
  }
  throw new Error("could not enqueue job");
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError ? e.code === "P2002" : (e as { code?: string } | null)?.code === "P2002";

/**
 * Take ownership of up to `limit` due jobs, in one statement, and count the attempt.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes two runners safe: a minute-by-minute schedule overlapping with a slow
 * drain, or two app instances, each get their own rows instead of running the same job twice. The attempt is
 * counted here rather than after the handler, so a process that dies mid-job still burns one of its three
 * attempts instead of being retried forever. Only `queued` rows are taken; a row a dead runner left `running`
 * comes back through reapStuckJobs below.
 */
export async function claimDueJobs(limit = 10, client: JobClient = db, now = new Date()): Promise<JobRow[]> {
  if (limit <= 0) return [];
  return client.$queryRaw<JobRow[]>(Prisma.sql`
    UPDATE "Job"
       SET status = 'running', attempts = attempts + 1, "startedAt" = ${now}, "updatedAt" = ${now}
     WHERE id IN (
       SELECT id FROM "Job"
        WHERE status = 'queued' AND "runAfter" <= ${now}
        ORDER BY "runAfter" ASC, "createdAt" ASC
        LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
     )
     RETURNING *`);
}

/**
 * How long a `running` row may go unreported before the runner holding it is presumed dead. Generously longer
 * than any handler takes — Sour's model calls time out at 20 seconds each (§3.5) — because reclaiming a job
 * that is in fact still running would send the same message twice.
 */
export const STUCK_AFTER_MS = 15 * 60_000;

/** What a reaped job records. Said in the handler's voice because that is where the row's other errors come
 *  from, and scrubbed by construction: it quotes nothing. */
export const STUCK_ERROR = "Error: the runner stopped before this job reported back";

/**
 * Put back the jobs a dead runner left `running`.
 *
 * `claimDueJobs` only takes `queued` rows, so without this a process that dies mid-job — a redeploy, a cold
 * Lambda frozen inside `after()`, an OOM — strands the row for good: it is never retried and never reaches
 * `failed`, which §3.4 requires it to. Worse, the row still holds its `idempotencyKey`, so every later
 * enqueue of the same work dedupes onto a job that can never finish, and the clinician's Generate button
 * joins a corpse instead of starting a summary.
 *
 * A row with attempts left goes back on the queue after a backoff, keeping its key, because the work is still
 * owed. A row that has spent all three fails properly, with the key released so the work can be asked for
 * again.
 */
export async function reapStuckJobs(client: JobClient = db, now = new Date()): Promise<{ requeued: number; failed: number }> {
  const stuck = (await client.job.findMany({
    where: { status: "running", startedAt: { lte: new Date(now.getTime() - STUCK_AFTER_MS) } },
  })) as JobRow[];

  const report = { requeued: 0, failed: 0 };
  for (const job of stuck) {
    const line = { jobId: job.id, kind: job.kind, attempt: job.attempts, attempts: MAX_ATTEMPTS, error: STUCK_ERROR };
    if (job.attempts < MAX_ATTEMPTS) {
      await client.job.update({
        where: { id: job.id },
        data: { status: "queued", runAfter: new Date(now.getTime() + backoffMs(job.attempts)), startedAt: null, lastError: STUCK_ERROR },
      });
      report.requeued += 1;
      log.warn("job_retry", line);
    } else {
      await client.job.update({
        where: { id: job.id },
        data: { status: "failed", finishedAt: now, startedAt: null, lastError: STUCK_ERROR, idempotencyKey: null },
      });
      report.failed += 1;
      log.error("job_failed", line);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Reading a job back (§7.2)

/**
 * The newest job of one kind for one visit.
 *
 * Why not `findUnique` on the idempotency key: the key is released the moment a job reaches `done` or
 * `failed`, which is exactly the state a clinician most needs to see ("failed, here is why, retry"). The
 * payload is the only lasting link from a visit to its jobs, so the query narrows on the serialized needle in
 * Postgres and then confirms in JS by parsing the payload, so a visit id that happens to appear in some other
 * field of a future payload cannot be mistaken for this one.
 */
export async function latestJobForVisit(kind: JobKind, visitId: string, client: JobClient = db): Promise<JobRow | null> {
  if (!visitId) return null;
  const needle = JSON.stringify({ visitId }).slice(1, -1); // "visitId":"<id>", exactly as enqueue wrote it
  const rows = (await client.job.findMany({
    where: { kind, payload: { contains: needle } },
    orderBy: { createdAt: "desc" },
    take: 20,
  })) as JobRow[];
  return rows.find((row) => payloadVisitId(row.payload) === visitId) ?? null;
}

function payloadVisitId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const id = (parsed as { visitId?: unknown } | null)?.visitId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** A job row as the provider page reads it (lib/types.ts SourJobState): the four states §7.2 names, the
 *  attempt count against the ceiling, and the scrubbed reason the last attempt failed. */
export function jobStateView(job: JobRow): SourJobState {
  return {
    id: job.id,
    status: (["queued", "running", "done", "failed"] as const).find((s) => s === job.status) ?? "queued",
    attempts: job.attempts,
    maxAttempts: MAX_ATTEMPTS,
    lastError: job.lastError,
    runAfter: job.runAfter.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

export type JobHandler = (payload: JobPayload, job: JobRow) => Promise<void>;
export type JobHandlers = Record<string, JobHandler | undefined>;

export type DrainReport = { claimed: number; done: number; retried: number; failed: number };

export type DrainOptions = {
  handlers?: JobHandlers;
  client?: JobClient;
  /** Jobs claimed per statement. */
  limit?: number;
  /** Ceiling on one drain, so a backlog cannot hold the request open forever. */
  maxJobs?: number;
  now?: Date;
};

/** Run every due job, oldest first, until there are none left or `maxJobs` have been handled. Rows a dead
 *  runner left behind are reaped first: they go back on the queue for a later pass, or fail if their three
 *  attempts are spent, and count in this report as a retry or a failure accordingly. */
export async function drainJobs(opts: DrainOptions = {}): Promise<DrainReport> {
  const client = opts.client ?? db;
  const handlers = opts.handlers ?? (await import("./jobHandlers")).handlers;
  const batch = opts.limit ?? 10;
  const maxJobs = opts.maxJobs ?? 100;
  const report: DrainReport = { claimed: 0, done: 0, retried: 0, failed: 0 };

  const reaped = await reapStuckJobs(client, opts.now ?? new Date());
  report.retried += reaped.requeued;
  report.failed += reaped.failed;

  while (report.claimed < maxJobs) {
    const jobs = await claimDueJobs(Math.min(batch, maxJobs - report.claimed), client, opts.now ?? new Date());
    if (jobs.length === 0) break;
    report.claimed += jobs.length;
    for (const job of jobs) {
      const started = Date.now();
      try {
        const handler = handlers[job.kind];
        if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
        await handler(parsePayload(job.payload), job);
        await client.job.update({
          where: { id: job.id },
          data: { status: "done", finishedAt: new Date(), lastError: null, idempotencyKey: null },
        });
        report.done += 1;
        log.info("job_done", { jobId: job.id, kind: job.kind, attempt: job.attempts, durationMs: Date.now() - started });
      } catch (e) {
        const retrying = job.attempts < MAX_ATTEMPTS;
        // The message is scrubbed: a handler's error can quote a gateway response, and this column is read by
        // staff on the page (§7.2) and by the log line below (§10.3).
        const lastError = scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        await client.job.update({
          where: { id: job.id },
          data: retrying
            ? { status: "queued", runAfter: new Date(Date.now() + backoffMs(job.attempts)), lastError, startedAt: null }
            : { status: "failed", finishedAt: new Date(), lastError, idempotencyKey: null },
        });
        const line = { jobId: job.id, kind: job.kind, attempt: job.attempts, attempts: MAX_ATTEMPTS, durationMs: Date.now() - started, error: lastError };
        if (retrying) {
          report.retried += 1;
          log.warn("job_retry", line);
        } else {
          report.failed += 1;
          log.error("job_failed", line);
        }
      }
    }
  }
  return report;
}

function parsePayload(raw: string): JobPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("job payload is not an object");
  return parsed as JobPayload;
}

// ---------------------------------------------------------------------------------------------
// Who drains the queue here

/**
 * `scheduled` means something outside the app calls `POST /api/jobs/run` (EventBridge in AWS, §3.4).
 * `inline` means the request that enqueues also drains, which is how local development, the demo and the e2e
 * suite work with no scheduler and no secret. Configuring `JOBS_SECRET` is what flips it, so a deployment
 * that has the secret never also runs jobs inside a page request; `JOBS_RUNNER` overrides either way.
 */
export function jobsRunner(): "inline" | "scheduled" {
  const mode = process.env.JOBS_RUNNER?.trim().toLowerCase();
  if (mode === "inline" || mode === "scheduled") return mode;
  return process.env.JOBS_SECRET ? "scheduled" : "inline";
}

/** Drain after the response, in inline mode only. `schedule` is Next's `after`, which routes pass in so this
 *  module stays free of next/server and can be unit-tested under plain node. */
export function nudge(schedule: (fn: () => Promise<void>) => void): void {
  if (jobsRunner() !== "inline") return;
  schedule(async () => {
    try {
      await drainJobs();
    } catch (e) {
      log.error("job_drain_failed", { error: e, stack: e });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The runner's shared secret (§3.4)

export type RunnerAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * The runner route is public, so the secret is the whole door. No secret configured means the route refuses to
 * run at all rather than falling open — in that deployment the inline path above is what runs jobs.
 * Accepts `Authorization: Bearer <secret>` or `X-Jobs-Secret`, compared in constant time.
 */
export function authorizeRunner(headers: Headers, secret = process.env.JOBS_SECRET): RunnerAuth {
  if (!secret?.trim()) return { ok: false, status: 503, error: "jobs runner is not configured" };
  const given = (headers.get("authorization")?.replace(/^Bearer\s+/i, "") || headers.get("x-jobs-secret") || "").trim();
  if (!given || !sameSecret(given, secret.trim())) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

/** Constant time, and over a digest so the comparison does not leak the secret's length either. */
const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
