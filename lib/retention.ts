// How long data is kept, and what "delete it" means (design §2.8, §10.4, §10.5). Owner: compliance.
//
// §10.4: "a nightly `retention.sweep` job deletes visit data older than the practice's retention setting
// (default 365 days), leaving the audit record." §10.5: "a staff action deletes a patient's data end to end
// (S3 objects included) and records it." §2.8 is the same two sentences in the customer's words.
//
// This is the pure half — the cutoff arithmetic, which date a visit is judged by, the confirmation a staff
// member has to type, and the shape of what a purge reports. lib/retentionStore.ts does the deleting, the
// two job handlers call it (lib/jobHandlers.ts) and app/api/deletion is the staff action.
//
// No imports, for the same two reasons as lib/auditLog.ts: the dashboard is a client component and imports
// the confirmation helper from here, so anything this module pulled in would land in the browser bundle; and
// the rules below are worth asserting without a Postgres (lib/retention.test.ts).

/** §4.1's default, mirrored from the Prisma schema so a caller with no practice row in hand can still say
 *  what the window is. The practice's own `retentionDays` is what the sweep actually reads. */
export const DEFAULT_RETENTION_DAYS = 365;

const DAY_MS = 86_400_000;

/**
 * The moment a visit has to be older than to be swept: `now` minus the practice's window.
 *
 * A window that is missing or not a whole number falls back to the default rather than to "keep nothing" —
 * the bounds on the settings form (lib/team.ts MIN/MAX_RETENTION_DAYS) stop a bad value being stored, and a
 * row that somehow holds one should keep data too long rather than delete it too early.
 */
export function retentionCutoff(retentionDays: number | null | undefined, now: Date = new Date()): Date {
  const days = Number.isInteger(retentionDays) && (retentionDays as number) > 0 ? (retentionDays as number) : DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Which date a visit's age is counted from: the appointment, or when the row was made if there is never
 * going to be one.
 *
 * The appointment is the right anchor because that is the day the data is *about* — a week of Dexcom readings
 * uploaded for a visit on the 3rd is that visit's week, whenever the row happened to be created. It also
 * means a visit booked months ahead is never swept before it has happened, which `createdAt` alone would do.
 */
export function visitRetentionAnchor(visit: { scheduledAt: Date | null; createdAt: Date }): Date {
  return visit.scheduledAt ?? visit.createdAt;
}

/** True when this visit is past the practice's window and has not been swept yet. */
export function isVisitExpired(visit: { scheduledAt: Date | null; createdAt: Date; retentionSweptAt: Date | null }, cutoff: Date): boolean {
  if (visit.retentionSweptAt) return false;
  return visitRetentionAnchor(visit).getTime() < cutoff.getTime();
}

/** Where one visit's uploaded bytes live (lib/storage.ts newUploadKey). Deleting the prefix is what clears
 *  the objects an `Upload` row no longer points at — a row removed by a half-finished earlier attempt. */
export const visitStoragePrefix = (visitId: string): string => `visits/${visitId}/`;

// ---------------------------------------------------------------------------------------------
// §10.5 "with confirmation"

/**
 * Whether what a staff member typed to confirm a deletion matches the patient they are looking at.
 *
 * The confirmation is the patient's own name, typed out, rather than an "are you sure": the action is
 * irreversible and the only mistake worth guarding against is doing it to the wrong row, which a dialog with
 * one button cannot catch. Compared case-insensitively and on collapsed whitespace, because this is a
 * safeguard and not a spelling test.
 */
export function confirmsDeletion(typed: unknown, patientName: string): boolean {
  if (typeof typed !== "string") return false;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const given = normalize(typed);
  return given.length > 0 && given === normalize(patientName);
}

/** The name a deleted patient's row keeps, so the row that remains for the audit trail (§2.8) says what it
 *  is rather than looking like a patient nobody named. Not a name anybody is called: §4.3 keeps the row, and
 *  §10.5 means nothing on it may still identify them. */
export const DELETED_PATIENT_NAME = "Deleted patient";

// ---------------------------------------------------------------------------------------------
// What a purge reports

/** What one purge removed. Every field is a count, which is what the audit row and the log line carry: the
 *  record says how much went, never what any of it was (§4.8). */
export type PurgeCounts = {
  visits: number;
  uploads: number;
  /** Chat rows: what lib/log.ts calls the turns of a transcript, and not "messages", because §4.8's own
   *  guard refuses any field whose name could be mistaken for the text of one (lib/auditLog.test.ts). */
  turns: number;
  summaries: number;
  /** Stored objects removed from S3 or the local backend (§10.5 "S3 objects included"). */
  objects: number;
  /** Objects the storage backend refused to remove. Above zero means orphaned bytes and a `warn` line. */
  orphans: number;
};

export const EMPTY_PURGE: PurgeCounts = { visits: 0, uploads: 0, turns: 0, summaries: 0, objects: 0, orphans: 0 };

/** Did this purge actually remove anything? A purge that found nothing writes no audit row: a nightly sweep
 *  over a practice inside its window, and a retried job whose first attempt finished the work, are not
 *  deletions and a row saying they were would be a record of nothing happening. */
export const removedSomething = (counts: PurgeCounts): boolean =>
  counts.visits + counts.uploads + counts.turns + counts.summaries + counts.objects > 0;

export const addCounts = (a: PurgeCounts, b: PurgeCounts): PurgeCounts => ({
  visits: a.visits + b.visits,
  uploads: a.uploads + b.uploads,
  turns: a.turns + b.turns,
  summaries: a.summaries + b.summaries,
  objects: a.objects + b.objects,
  orphans: a.orphans + b.orphans,
});
