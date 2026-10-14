// Writing and reading the audit log (design §4.8, §10.2). Owner: compliance.
//
// The database half of lib/auditLog.ts, which holds the vocabulary, the PHI gate on `detail` and the CSV —
// the same split as lib/team.ts / lib/teamStore.ts, and for the same two reasons: the admin screen is a
// client component and may only import the pure side, and the rules are worth testing without a Postgres.
//
// Two things every caller should know:
//
//   1. **A write never fails the request it is part of.** An audit row is a record of something that already
//      happened; throwing here would turn a patient's upload or a clinician's page load into a 500 *after*
//      the thing was done. So recordAudit catches, logs `audit_write_failed` (§11.1) and returns. The log is
//      the backstop for the backstop.
//   2. **Repeated identical reads inside a minute are one row.** The Sour page polls GET /api/patient/[id]
//      up to twenty times while a summary is generated (app/provider/[id]/sour.tsx). Twenty rows per
//      clinician per visit is not a record anybody can read, so a read that matches the previous one moves
//      its `at` forward and counts itself in `detail.count` instead. Nothing is lost — the row says how many
//      and when the last one was — and §10.2's question, "who read this visit and when", still has its
//      answer. Sends and deletions are never coalesced: each one is its own event.

import {
  auditDetailJson,
  parseAuditDetail,
  readAction,
  type ActorType,
  type AuditAction,
  type AuditEntry,
  type AuditFields,
  type AuditFilter,
  type VisitPart,
  ACTOR_LABELS,
} from "./auditLog";
import { db } from "./db";
import { log } from "./log";

/** How close two identical reads have to be to become one row. One minute: long enough to swallow a page's
 *  polling, short enough that opening a visit again after a consultation is its own row. */
export const READ_COALESCE_MS = 60_000;

/** The same for a patient presenting their link. A patient works through intake over several minutes and
 *  every message resolves the token again (§5.3); the useful record is the session, not the keystroke. */
export const VERIFY_COALESCE_MS = 15 * 60_000;

export type AuditWrite = {
  practiceId: string;
  actorType: ActorType;
  /** The user who did it, the patient whose link was used, or null for a job. */
  actorId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  detail?: AuditFields;
  /** Milliseconds within which an identical row absorbs this one instead of a new row being written. */
  coalesceMs?: number;
};

/** One row, written best-effort. Awaited by its caller so the row lands before the response, but a failure
 *  here is logged and swallowed: see the note at the top of the file. */
export async function recordAudit(entry: AuditWrite): Promise<void> {
  try {
    const detail = auditDetailJson(entry.detail);
    if (entry.coalesceMs && (await absorbed(entry, detail))) return;
    await db.auditLog.create({
      data: {
        practiceId: entry.practiceId,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        detail,
      },
    });
  } catch (e) {
    // The action itself succeeded; this is the record of it going missing, which is worth an error line.
    log.error("audit_write_failed", { practiceId: entry.practiceId, userId: entry.actorId ?? undefined, error: e });
  }
}

/** True when a row identical to this one is recent enough to count it instead: its `at` moves forward and
 *  `detail.count` goes up by one. */
async function absorbed(entry: AuditWrite, detail: string | null): Promise<boolean> {
  const since = new Date(Date.now() - (entry.coalesceMs ?? 0));
  const previous = await db.auditLog.findFirst({
    where: {
      practiceId: entry.practiceId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      at: { gte: since },
    },
    orderBy: { at: "desc" },
  });
  if (!previous) return false;
  // Same action on the same thing, but the circumstances differ (a different part, a different request) —
  // that is a second event and deserves its own row.
  const sameDetail = stripCount(previous.detail) === stripCount(detail);
  if (!sameDetail) return false;

  const counted = parseAuditDetail(previous.detail) ?? {};
  const before = typeof counted.count === "number" && Number.isFinite(counted.count) ? counted.count : 1;
  // Serialized as it stands rather than back through auditDetail: this detail already passed that gate when
  // the row was written, and a second pass would drop its own `droppedFields` and report it as a drop.
  await db.auditLog.update({
    where: { id: previous.id },
    data: { at: new Date(), detail: JSON.stringify({ ...counted, count: before + 1 }) },
  });
  return true;
}

/** A stored detail with the running count and the request id taken out, so two reads of the same thing are
 *  recognised as the same read however many times it has already been counted. */
function stripCount(raw: string | null): string {
  const detail = parseAuditDetail(raw);
  if (!detail) return "";
  const rest = Object.entries(detail)
    .filter(([key]) => key !== "count" && key !== "requestId")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(rest));
}

/**
 * §10.2's read: one row per part of the visit a user actually received. `parts` is the subset that was in the
 * response, so a visit with no uploads records no `uploads.read` — the log says what was seen, not what the
 * screen has room for.
 */
export async function recordVisitRead(opts: {
  practiceId: string;
  visitId: string;
  actor: { id: string; role?: string | null };
  parts: readonly VisitPart[];
}): Promise<void> {
  for (const part of opts.parts) {
    await recordAudit({
      practiceId: opts.practiceId,
      actorType: "user",
      actorId: opts.actor.id,
      action: readAction(part),
      entityType: "visit",
      entityId: opts.visitId,
      detail: { part, role: opts.actor.role ?? undefined },
      coalesceMs: READ_COALESCE_MS,
    });
  }
}

/** §10.2's patient-link verification: the invite token was presented and accepted (§5.3). Called from
 *  lib/visit.ts, where the token is resolved, so every one of the patient's entry points is covered by one
 *  line. T08's six-digit code adds its own action beside this one. */
export async function recordPatientVerified(visit: { id: string; patientId: string; patient: { practiceId: string } }): Promise<void> {
  await recordAudit({
    practiceId: visit.patient.practiceId,
    actorType: "patient",
    actorId: visit.patientId,
    action: "patient.verified",
    entityType: "visit",
    entityId: visit.id,
    coalesceMs: VERIFY_COALESCE_MS,
  });
}

// ---------------------------------------------------------------------------------------------
// Reading it back, for app/api/audit and the admin page behind it.

export type AuditActor = { id: string; label: string };

export type AuditListing = {
  entries: AuditEntry[];
  /** How many rows match the filter, which may be more than `entries` holds. */
  total: number;
  /** The practice's own users, for the actor filter. */
  actors: AuditActor[];
};

/** The practice's audit log, newest first, filtered (§10.2). Scoped by practiceId and nothing else: there is
 *  no id in the route to point at another practice, which is the cheapest way to honour §5.2. */
export async function auditListing(practiceId: string, filter: AuditFilter): Promise<AuditListing> {
  const where = {
    practiceId,
    ...(filter.action ? { action: filter.action } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.entityId ? { entityId: filter.entityId } : {}),
    ...(filter.from || filter.to ? { at: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) } } : {}),
  };
  // One transaction, not three parallel queries: the page prints "4 of 5 shown" if a row lands between the
  // page and the count, which reads as a bug in the very table whose job is to be trusted.
  const [rows, total, users] = await db.$transaction([
    db.auditLog.findMany({ where, orderBy: { at: "desc" }, take: filter.limit }),
    db.auditLog.count({ where }),
    db.user.findMany({ where: { practiceId }, select: { id: true, name: true, email: true }, orderBy: { email: "asc" } }),
  ]);

  // The actor's name is joined at read time and never stored (§4.8): the row keeps an opaque user id, and a
  // colleague's address is the practice's own — the settings screen already shows admins every one of them.
  const named = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  return {
    entries: rows.map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      actorType: row.actorType,
      actorId: row.actorId,
      actor: actorLabel(row.actorType, row.actorId, named),
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      detail: parseAuditDetail(row.detail),
    })),
    total,
    actors: users.map((u) => ({ id: u.id, label: u.name ? `${u.name} (${u.email})` : u.email })),
  };
}

/** Who, in words. A user who has since been removed from the practice is shown as a departed colleague
 *  rather than as a blank: the row is the point, and it outlives the account. */
function actorLabel(actorType: string, actorId: string | null, named: Map<string, string>): string {
  if (actorType === "user") return (actorId && named.get(actorId)) ?? "Former colleague";
  return ACTOR_LABELS[actorType] ?? actorType;
}
