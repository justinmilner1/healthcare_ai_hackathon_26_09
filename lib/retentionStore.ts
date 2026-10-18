// Deleting data, nightly and on request (design §2.8, §10.4, §10.5). Owner: compliance.
//
// The database half of lib/retention.ts, which holds the cutoff arithmetic and the confirmation rule — the
// same split as lib/team.ts / lib/teamStore.ts and lib/auditLog.ts / lib/auditStore.ts. Two entry points,
// both called from a job handler (lib/jobHandlers.ts):
//
//   sweepRetention()   §10.4's nightly job: every practice's visits past its own retention window lose their
//                      intake, notes, messages, uploads and summaries. The `Visit` row stays, marked, and so
//                      does the `Patient`: §4.3's patient persists across visits and may book another one.
//   purgePatient()     §10.5's staff action: one patient's data end to end — every visit row, the stored
//                      objects behind their uploads, their encrypted Dexcom tokens, and their own name and
//                      contact details. The row itself stays, scrubbed and `deletedAt`, so the audit record
//                      of the deletion still points at something (§2.8).
//
// Three properties everything here is built for:
//
//   1. **Idempotent.** Both are safe to run twice. The sweep skips what it has marked; the purge works from
//      whatever is still there and reports nothing when there is nothing left. That is what makes the
//      `patient.delete` and `retention.sweep` jobs safe to retry, which §3.4 will do three times.
//   2. **Objects before rows.** The bytes are deleted by *prefix* (lib/storage.ts deletePrefix) rather than by
//      the keys on the `Upload` rows, so an object whose row a half-finished earlier attempt already removed
//      is still found. Deleting by key would lose it for ever. A prefix the store *refuses* is written to
//      `StorageOrphan` before the rows go (T70, §10.5): the purge deletes the `Visit` seconds later and the
//      prefix is derived from its id, so a refusal that is not written down is a prefix nothing can name
//      again. retryOrphanedPrefixes() is what comes back to it — from the nightly sweep, and from the next
//      purge of the same patient.
//   3. **A record of every deletion.** §10.2 counts deletions, so each cleared visit and each purged patient
//      writes one audit row, with counts and no contents (§4.8). A run that removed nothing writes nothing:
//      a row saying a sweep considered a practice and deleted none of it is a record of nothing happening.
//
// §13.4's demo practices are excluded from the nightly sweep: `Practice.isDemo` is the flag, and a practice
// wearing it keeps its visits however old they are, because the point of a demo practice is that the week of
// readings somebody walks a prospect through is still there next month. The staff action is not excluded —
// §10.5 is a person pressing a button on a named patient, and a demo patient is as deletable as any other.

import type { PrismaClient } from "@prisma/client";
import { recordAudit, type AuditWrite } from "./auditStore";
import { db } from "./db";
import { enqueue, type JobClient } from "./jobs";
import { log } from "./log";
import {
  addCounts,
  DELETED_PATIENT_NAME,
  EMPTY_PURGE,
  removedSomething,
  retentionCutoff,
  visitStoragePrefix,
  type PurgeCounts,
} from "./retention";
import { deletePrefix } from "./storage";

/** Just the delegates this needs, so a test can hand it a client pointed at a fixture schema (the pattern
 *  lib/migrateVisits.ts and lib/jobs.ts use). */
export type RetentionClient = Pick<
  PrismaClient,
  | "practice"
  | "patient"
  | "visit"
  | "upload"
  | "message"
  | "summary"
  | "followUp"
  | "patientSession"
  | "visitDelivery"
  | "dexcomConnection"
  | "dexcomOAuthState"
  | "storageOrphan"
>;

/** What a purge may be handed instead of the real thing, so a unit test needs neither a bucket nor the
 *  practice to exist in the app's own schema. */
export type RetentionDeps = {
  client?: RetentionClient;
  /** Removing one visit's stored bytes. Defaults to lib/storage.ts's prefix delete. */
  removePrefix?: (prefix: string) => Promise<{ deleted: number; failed: number }>;
  /** Writing the audit row. Defaults to lib/auditStore.ts's recordAudit. */
  audit?: (entry: AuditWrite) => Promise<void>;
  now?: Date;
};

type Resolved = {
  client: RetentionClient;
  removePrefix: (prefix: string) => Promise<{ deleted: number; failed: number }>;
  audit: (entry: AuditWrite) => Promise<void>;
  now: Date;
};

const resolve = (deps: RetentionDeps): Resolved => ({
  client: deps.client ?? db,
  removePrefix: deps.removePrefix ?? deletePrefix,
  audit: deps.audit ?? recordAudit,
  now: deps.now ?? new Date(),
});

// ---------------------------------------------------------------------------------------------
// §10.5 The ledger of prefixes the object store would not empty (T70)

/** Whose deletion left a prefix behind: the practice whose audit trail a later pass belongs in, and the
 *  patient a second press of *Delete data* would be for. The patient is null on a sweep row (§10.4), where
 *  the `Visit` stays and the patient was never being deleted. */
type OrphanOwner = { practiceId: string; patientId: string | null };

/** What one pass over the ledger did. Separate from `PurgeCounts` because none of it is the patient's data:
 *  these are bytes a previous deletion already accounted for, being chased. */
export type OrphanSweep = {
  /** Prefixes this pass asked the object store about again. */
  prefixes: number;
  /** Objects it managed to remove this time. */
  objects: number;
  /** Objects still outstanding after it — the ones whose rows stay for the next pass. */
  orphans: number;
  /** Prefixes that came back empty, so their row is gone. */
  cleared: number;
};

export const EMPTY_ORPHAN_SWEEP: OrphanSweep = { prefixes: 0, objects: 0, orphans: 0, cleared: 0 };

/** How many prefixes one pass re-attempts. A ceiling for the same reason as SWEEP_LIMIT: the backlog is
 *  pathological if it is ever long, and the nightly job should not hold a connection open walking it. */
export const ORPHAN_RETRY_LIMIT = 200;

/**
 * What the object store said about one prefix, written down.
 *
 * A refusal becomes a `StorageOrphan` row (or bumps the one already there); a prefix that came back empty
 * clears any row an earlier attempt left. Both halves matter: without the first the bytes are unreachable,
 * and without the second a prefix somebody emptied by hand stays on the ledger for ever.
 *
 * Upsert rather than create, keyed on the prefix: one visit is one row however many times it is attempted,
 * and `attempts` is how an operator tells "refused once" from "refusing every night".
 */
async function recordPrefixOutcome(
  { client, now }: Resolved,
  prefix: string,
  result: { deleted: number; failed: number },
  owner: OrphanOwner,
): Promise<void> {
  if (result.failed === 0) {
    // deleteMany, not delete: most prefixes were never on the ledger and a missing row is the normal case.
    await client.storageOrphan.deleteMany({ where: { prefix } });
    return;
  }
  await client.storageOrphan.upsert({
    where: { prefix },
    create: {
      prefix,
      practiceId: owner.practiceId,
      patientId: owner.patientId,
      objects: result.failed,
      attempts: 1,
      createdAt: now,
      lastTriedAt: now,
    },
    // `patientId` is filled in rather than overwritten: a sweep leaves it null and a later purge of the same
    // patient is what gives the row the owner that makes it findable without a `Visit`.
    update: {
      objects: result.failed,
      attempts: { increment: 1 },
      lastTriedAt: now,
      ...(owner.patientId ? { patientId: owner.patientId } : {}),
    },
  });
}

/**
 * Walk the ledger and ask the object store again.
 *
 * This is the pass that the comment in this file used to claim a second deletion was: it works from the
 * prefixes themselves, so it needs neither the `Visit` rows the purge deleted nor the `Upload` rows that
 * named the keys. A prefix that comes back empty leaves the ledger; one that is refused again stays, with
 * `attempts` one higher, for the next pass.
 *
 * `skip` is the prefixes the caller has just attempted itself, so a purge does not ask about the same visit
 * twice in one run.
 *
 * `record` is whether this pass writes its own audit row. The nightly sweep does, because nothing else
 * accounts for what it removed; a purge does not, because the objects land in its own `patient.deleted`
 * counts and two rows for one deletion would overstate it (§10.2).
 */
async function retryOrphans(
  deps: Resolved,
  where: { practiceId?: string; patientId?: string },
  opts: { skip?: readonly string[]; record?: boolean } = {},
): Promise<OrphanSweep> {
  const { client } = deps;
  const skip = new Set(opts.skip ?? []);
  const pending = await client.storageOrphan.findMany({
    where: {
      ...(where.practiceId ? { practiceId: where.practiceId } : {}),
      ...(where.patientId ? { patientId: where.patientId } : {}),
    },
    orderBy: { createdAt: "asc" },
    // Room for the skipped ones, so a purge with a long backlog still re-attempts a full page of it.
    take: ORPHAN_RETRY_LIMIT + skip.size,
  });

  const report: OrphanSweep = { ...EMPTY_ORPHAN_SWEEP };
  // Tallied per practice, because that is the unit an audit row belongs to: a nightly pass over three
  // practices' leftovers is three practices' deletions, and §10.2 is read one practice at a time.
  const byPractice = new Map<string, { prefixes: number; objects: number; orphans: number }>();
  for (const row of pending) {
    if (skip.has(row.prefix)) continue;
    if (report.prefixes >= ORPHAN_RETRY_LIMIT) break;
    const result = await deps.removePrefix(row.prefix);
    await recordPrefixOutcome(deps, row.prefix, result, { practiceId: row.practiceId, patientId: row.patientId });
    report.prefixes += 1;
    report.objects += result.deleted;
    report.orphans += result.failed;
    if (result.failed === 0) report.cleared += 1;
    const tally = byPractice.get(row.practiceId) ?? { prefixes: 0, objects: 0, orphans: 0 };
    tally.prefixes += 1;
    tally.objects += result.deleted;
    tally.orphans += result.failed;
    byPractice.set(row.practiceId, tally);
  }

  if (report.prefixes === 0) return report;
  log.info("storage_orphans_retried", {
    rows: report.prefixes,
    objects: report.objects,
    orphans: report.orphans,
    count: report.cleared,
  });
  if (!opts.record) return report;
  for (const [practiceId, tally] of byPractice) {
    // Property 3 again: a pass that removed nothing is not a deletion, and a row saying the bucket refused
    // again is the `warn` line's job, not the practice's trail.
    if (tally.objects === 0) continue;
    await deps.audit({
      practiceId,
      actorType: "system",
      action: "storage.orphans_purged",
      entityType: "practice",
      entityId: practiceId,
      detail: tally,
    });
  }
  return report;
}

/**
 * The ledger pass on its own, for a caller that is not already purging something — the nightly sweep calls
 * it through sweepRetention, and the runbook's manual drain can call it directly.
 */
export async function sweepStorageOrphans(opts: RetentionDeps & { practiceId?: string } = {}): Promise<OrphanSweep> {
  return retryOrphans(resolve(opts), opts.practiceId ? { practiceId: opts.practiceId } : {}, { record: true });
}

/**
 * Everything one visit collected, gone: the stored files, the parsed rows, the transcript, the summaries, and
 * the plumbing that hangs off it (verified patient sessions, delivery results, pending Dexcom OAuth states).
 *
 * Not a transaction, on purpose. The object store is not in it and could not be rolled back anyway, and a
 * half-done purge is not a state anything has to be protected from: the next attempt finds what is left and
 * finishes, which is property 1 at the top of this file. Wrapping the statements would buy consistency with
 * nothing to be consistent with, and would hold a write transaction open across an S3 round trip.
 *
 * The counts are the patient's own data. Sessions, deliveries and OAuth states are plumbing and are not
 * counted; they are deleted because leaving them would leave a way back into a visit with nothing in it.
 * Follow-ups (§7.5) are not counted either, for the reason given where they are deleted.
 */
async function purgeVisitData(deps: Resolved, visitId: string, owner: OrphanOwner): Promise<PurgeCounts> {
  const { client } = deps;
  // Objects first: by prefix, so the bytes go even when no row points at them any more (property 2).
  const prefix = visitStoragePrefix(visitId);
  const objects = await deps.removePrefix(prefix);
  // And written down before the rows go, because afterwards nothing can name this prefix (property 2).
  await recordPrefixOutcome(deps, prefix, objects, owner);
  // `UploadData` is the heavy half of an upload and cascades from the `Upload` row (§4.6).
  const uploads = await client.upload.deleteMany({ where: { visitId } });
  const turns = await client.message.deleteMany({ where: { visitId } });
  const summaries = await client.summary.deleteMany({ where: { visitId } });
  // §7.5's follow-up log. Not counted, because the counts are an inventory of what the *patient* gave us and
  // these rows are a clinician's questions about it; they go with the summary they were asked about, and a
  // sweep that left them would leave the patient's week described in somebody's question (lib/followUps.ts).
  await client.followUp.deleteMany({ where: { visitId } });
  await client.patientSession.deleteMany({ where: { visitId } });
  await client.visitDelivery.deleteMany({ where: { visitId } });
  await client.dexcomOAuthState.deleteMany({ where: { visitId } });
  return {
    visits: 0,
    uploads: uploads.count,
    turns: turns.count,
    summaries: summaries.count,
    objects: objects.deleted,
    orphans: objects.failed,
  };
}

// ---------------------------------------------------------------------------------------------
// §10.4 The nightly sweep

export type SweepReport = {
  /** How many practices were considered. Demo practices are not among them (§13.4). */
  practices: number;
  /** How many practices were left alone for being demo practices (§13.4). */
  demoPractices: number;
  /** How many visits were cleared. */
  visits: number;
  counts: PurgeCounts;
  /** §10.5's unfinished deletions, re-attempted on the same nightly clock (T70). */
  orphans: OrphanSweep;
};

/** How many visits one sweep clears before leaving the rest for the next run. A ceiling rather than a
 *  pagination bug: the job runs nightly and a backlog only exists the first time a practice shortens its
 *  window, where finishing a day later is fine and holding a connection for an hour is not. */
export const SWEEP_LIMIT = 500;

/**
 * §10.4: "a nightly `retention.sweep` job deletes visit data older than the practice setting (default 365
 * days), leaving the audit record." One practice at a time, because the window is the practice's own.
 *
 * A visit is judged by its appointment, or by when it was created if it never had one (lib/retention.ts
 * visitRetentionAnchor), and `retentionSweptAt` is what stops the next run considering it again.
 */
export async function sweepRetention(opts: RetentionDeps & { practiceId?: string } = {}): Promise<SweepReport> {
  const deps = resolve(opts);
  const { client, now } = deps;
  // Both kinds in one query, rather than `isDemo: false` in the `where`: a sweep that says how many
  // practices it skipped is a sweep an operator can tell from one that found no practices at all, and
  // sweeping a single practice by hand (`practiceId`) has to be able to report that this one is a demo.
  const all = await client.practice.findMany({
    where: opts.practiceId ? { id: opts.practiceId } : {},
    select: { id: true, retentionDays: true, isDemo: true },
  });
  const practices = all.filter((practice) => !practice.isDemo);
  const demoPractices = all.length - practices.length;
  // One line, not one per practice: a deployment with a dozen demo practices should not write a dozen lines
  // every night. `demo: true` is §13.4's label for §11.1's alarm filters (lib/demo.ts).
  if (demoPractices > 0) log.info("retention_demo_skipped", { count: demoPractices, demo: true });

  const report: SweepReport = {
    practices: practices.length,
    demoPractices,
    visits: 0,
    counts: EMPTY_PURGE,
    orphans: EMPTY_ORPHAN_SWEEP,
  };
  for (const practice of practices) {
    const cutoff = retentionCutoff(practice.retentionDays, now);
    const expired = await client.visit.findMany({
      where: {
        patient: { practiceId: practice.id },
        retentionSweptAt: null,
        // The anchor, as a query: the appointment when there is one, and otherwise the row's own age. A visit
        // booked for next month is not old, whatever its `createdAt` says.
        OR: [{ scheduledAt: { lt: cutoff } }, { AND: [{ scheduledAt: null }, { createdAt: { lt: cutoff } }] }],
      },
      select: { id: true, patientId: true },
      orderBy: { createdAt: "asc" },
      take: SWEEP_LIMIT,
    });
    if (expired.length === 0) continue;

    let practiceCounts = EMPTY_PURGE;
    for (const visit of expired) {
      // No patient on the owner: the sweep is not deleting anybody, it is clearing an old visit's data, and
      // the `Visit` row stays. A prefix it cannot empty is still unreachable afterwards — `retentionSweptAt`
      // stops the next sweep considering the visit — so it goes on the ledger the same way (T70).
      const counts = await purgeVisitData(deps, visit.id, { practiceId: practice.id, patientId: null });
      // What is left is the appointment and its outcome: when it was, what type, who it was for, that it was
      // reviewed. `reason` goes with the rest — it is what the patient called in about, in their own words.
      await client.visit.update({
        where: { id: visit.id },
        data: { notes: null, intake: null, reason: null, retentionSweptAt: now, tokenExpiresAt: now },
      });
      report.visits += 1;
      report.counts = addCounts(report.counts, counts);
      practiceCounts = addCounts(practiceCounts, counts);
      // One row per visit: a visit's data going is one deletion, and §10.2 records every deletion. The actor
      // is the job — nobody pressed anything (§4.8). `visits` is not in the detail because the row *is* the
      // visit; what the counts say is how much of its data there was.
      await deps.audit({
        practiceId: practice.id,
        actorType: "system",
        action: "retention.swept",
        entityType: "visit",
        entityId: visit.id,
        detail: {
          days: practice.retentionDays,
          uploads: counts.uploads,
          turns: counts.turns,
          summaries: counts.summaries,
          objects: counts.objects,
          orphans: counts.orphans,
        },
      });
    }
    log.info("retention_swept", {
      practiceId: practice.id,
      days: practice.retentionDays,
      visits: expired.length,
      uploads: practiceCounts.uploads,
      turns: practiceCounts.turns,
      summaries: practiceCounts.summaries,
      objects: practiceCounts.objects,
      orphans: practiceCounts.orphans,
    });
  }

  // §10.5's leftovers, chased on §10.4's clock: the two are different promises but there is only one nightly
  // job, and a prefix the bucket refused is not waiting on anybody's retention window. Demo practices are
  // not excluded here the way their visits are (§13.4) — a patient somebody deleted from a demo practice is
  // as deleted as any other, and these bytes were supposed to be gone already.
  report.orphans = await retryOrphans(deps, opts.practiceId ? { practiceId: opts.practiceId } : {}, { record: true });
  return report;
}

// ---------------------------------------------------------------------------------------------
// §10.5 The staff action

export type PurgeResult = {
  counts: PurgeCounts;
  /** Whether the patient had encrypted Dexcom tokens, and they are gone (§4.10, §10.5). */
  dexcom: boolean;
  /** False when there was no such patient at all, which is what a retry of a finished job finds. */
  found: boolean;
};

/**
 * One patient's data, end to end (§10.5): every visit and everything that hung off it, the stored objects,
 * the Dexcom tokens, and their name, phone number and email.
 *
 * What is left behind is a row with `deletedAt`, no contact details and the name in lib/retention.ts
 * DELETED_PATIENT_NAME. §4.3 keeps the row and §2.8 says why: the audit record of the deletion has to point
 * at something, and a practice has to be able to answer "did you delete this person's data" a year later.
 * Nothing on it identifies them, and lib/visitStore.ts will not match a new visit onto a deleted patient, so
 * a patient who comes back is a new row rather than a quietly undeleted one.
 *
 * `requestedBy` is the staff member who asked (§5.2's user id, opaque): the audit row is written against
 * them, because a person pressed this even though a job carried it out. Omitted — a deletion started from the
 * runbook (§13.5) — the row is the job's.
 */
export async function purgePatient(opts: RetentionDeps & { patientId: string; requestedBy?: string | null }): Promise<PurgeResult> {
  const deps = resolve(opts);
  const { client, now } = deps;
  const patient = await client.patient.findUnique({
    where: { id: opts.patientId },
    select: { id: true, practiceId: true, name: true, phone: true, email: true, deletedAt: true, visits: { select: { id: true } } },
  });
  if (!patient) {
    log.warn("patient_purge_missing", { patientId: opts.patientId });
    return { counts: EMPTY_PURGE, dexcom: false, found: false };
  }

  let counts = EMPTY_PURGE;
  const owner: OrphanOwner = { practiceId: patient.practiceId, patientId: patient.id };
  const attempted: string[] = [];
  for (const visit of patient.visits) {
    attempted.push(visitStoragePrefix(visit.id));
    counts = addCounts(counts, await purgeVisitData(deps, visit.id, owner));
    // The visit row goes too, which is what tells this apart from the sweep: there is no patient left for the
    // appointment to belong to. Anything still hanging off it cascades (§4.4).
    await client.visit.delete({ where: { id: visit.id } });
    counts = addCounts(counts, { ...EMPTY_PURGE, visits: 1 });
  }

  // What an earlier attempt could not empty, before it deleted the `Visit` rows that named those prefixes
  // (T70). This is what makes pressing *Delete data* again reach the object store at all: by here
  // `patient.visits` is usually empty, and walking it was the only thing the old purge did. The prefixes
  // just attempted above are skipped, so one run asks about one visit once; anything that fails in this
  // pass is already back on the ledger for the nightly one.
  const retried = await retryOrphans(deps, { patientId: patient.id }, { skip: attempted });
  counts = addCounts(counts, { ...EMPTY_PURGE, objects: retried.objects, orphans: retried.orphans });

  const dexcom = (await client.dexcomConnection.deleteMany({ where: { patientId: patient.id } })).count > 0;
  const identified = patient.name !== DELETED_PATIENT_NAME || Boolean(patient.phone || patient.email);
  await client.patient.update({
    where: { id: patient.id },
    data: { name: DELETED_PATIENT_NAME, phone: null, email: null, deletedAt: patient.deletedAt ?? now },
  });

  // A retry whose first attempt finished the work finds nothing to remove and says nothing: see property 3.
  // `orphans` is the exception that is not nothing: a deletion the object store refused is a deletion that
  // did not finish, and the practice is owed a row saying so even on a run that removed nothing else.
  if (removedSomething(counts) || dexcom || identified || counts.orphans > 0) {
    await deps.audit({
      practiceId: patient.practiceId,
      actorType: opts.requestedBy ? "user" : "system",
      actorId: opts.requestedBy ?? null,
      action: "patient.deleted",
      entityType: "patient",
      entityId: patient.id,
      detail: { ...counts, dexcom },
    });
    log.info("patient_purged", {
      patientId: patient.id,
      practiceId: patient.practiceId,
      userId: opts.requestedBy ?? undefined,
      visits: counts.visits,
      uploads: counts.uploads,
      turns: counts.turns,
      summaries: counts.summaries,
      objects: counts.objects,
      orphans: counts.orphans,
    });
  }
  if (counts.orphans > 0) {
    // The rows are gone and the bytes are not. Said out loud because §10.5 promises the objects too. The
    // prefixes are on `StorageOrphan` (T70), so the nightly sweep and the next press of *Delete data* both
    // come back to them; this line is how an operator knows that is happening rather than finishing.
    log.warn("patient_purge_orphans", { patientId: patient.id, orphans: counts.orphans });
  }
  return { counts, dexcom, found: true };
}

/**
 * The staff action itself (§10.5), as the route performs it: the patient is closed now and the purge is
 * queued as the `patient.delete` job §3.4 names.
 *
 * Two steps rather than one because they fail differently. Marking `deletedAt` is a single statement that
 * cannot half-happen, and it is what immediately stops the patient being matched onto a new visit
 * (lib/visitStore.ts) and tells the dashboard to stop offering their row; the purge itself touches an object
 * store and a dozen tables, which is exactly the work §3.4 says belongs in a job with attempts and a recorded
 * error. The idempotency key collapses a double-pressed button onto one job while it is in flight, and
 * releases afterwards so staff can ask again if it failed.
 */
export async function requestPatientDeletion(opts: {
  patientId: string;
  requestedBy: string;
  client?: RetentionClient;
  jobs?: JobClient;
  now?: Date;
}): Promise<{ jobId: string; deduped: boolean }> {
  const client = opts.client ?? db;
  // `updateMany` with `deletedAt: null`, so asking again — because the first job failed, which is the only
  // reason staff would — does not move the date the deletion was asked for. That date is part of the record
  // (§2.8) and the second request is the same request, not a second deletion. The route has already found
  // the patient in the caller's practice, so matching nothing here means it is already marked.
  await client.patient.updateMany({ where: { id: opts.patientId, deletedAt: null }, data: { deletedAt: opts.now ?? new Date() } });
  const { job, deduped } = await enqueue(
    {
      kind: "patient.delete",
      payload: { patientId: opts.patientId, requestedBy: opts.requestedBy },
      idempotencyKey: `patient.delete:${opts.patientId}`,
    },
    opts.jobs,
  );
  log.info("patient_deletion_requested", { patientId: opts.patientId, userId: opts.requestedBy, jobId: job.id });
  return { jobId: job.id, deduped };
}

// ---------------------------------------------------------------------------------------------
// Who asks for the nightly sweep

/**
 * How long a sweep's work is good for. Shorter than a day so a scheduler whose tick drifts still sweeps every
 * calendar day, long enough that a minute-by-minute runner does not sweep twice.
 */
export const SWEEP_INTERVAL_MS = 20 * 3_600_000;

/**
 * Put a `retention.sweep` on the queue if one has not been queued recently, and say whether that happened.
 *
 * §10.4 wants this nightly and §3.4 gives the app one clock: EventBridge calling `POST /api/jobs/run` every
 * minute. So the runner asks this on every tick and the window above is what makes it nightly — no second
 * schedule to create, and nothing to go wrong in an environment that has not got one. The guard is the
 * *creation* time of the last sweep rather than its idempotency key, because the key is released the moment a
 * job finishes, which for this job is seconds later.
 *
 * `npm run jobs:drain` does the same, so a local database or a staging environment with no scheduler still
 * sweeps when somebody drains the queue.
 */
export async function scheduleRetentionSweep(client: JobClient = db, now: Date = new Date()): Promise<{ jobId: string } | null> {
  const recent = await client.job.findFirst({
    where: { kind: "retention.sweep", createdAt: { gte: new Date(now.getTime() - SWEEP_INTERVAL_MS) } },
    select: { id: true },
  });
  if (recent) return null;
  const { job } = await enqueue({ kind: "retention.sweep", payload: {}, idempotencyKey: `retention.sweep:${now.toISOString().slice(0, 10)}` }, client);
  return { jobId: job.id };
}
