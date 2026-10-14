// Who touched a visit's data (design §4.8, §10.2). Owner: compliance.
//
// §10.2 names what has to be recorded: "every read of a visit's intake, summary, messages, or uploads by a
// user, every patient-link verification, every send, every deletion. Readable by practice admins on an audit
// page; exportable." §4.8 adds the one hard constraint on the row: `detail` is "JSON without PHI".
//
// This is the pure half — the vocabulary of actions, the allow-list that keeps PHI out of `detail`, the CSV
// the admin page exports through, and the filter a query string turns into. lib/auditStore.ts writes and
// reads the rows, app/api/audit answers for them, app/provider/audit shows them.
//
// No imports on purpose, for two reasons. The admin page is a client component and imports the labels and the
// action list from here, so anything this module pulled in would land in the browser bundle — which is how
// node:async_hooks reached the edge build twice already (T45, T46). And §4.8's promise is worth asserting
// without a database: lib/auditLog.test.ts feeds auditDetail() every shape PHI arrives in and reads the JSON.
//
// The relationship to lib/log.ts is deliberate and the two are not interchangeable. Application logs are
// operational and keep no record of who read what (§10.3); this table is that record, lives in Postgres with
// the practice, and is what an admin is shown. lib/audit.ts, confusingly close in name, is the *dependency*
// audit gate (§10.8) and has nothing to do with any of this.

/** §4.8 actorType. `system` is a background job (§3.4): nobody pressed anything. */
export const ACTOR_TYPES = ["user", "patient", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The four parts of a visit §10.2 counts as a read. One row per part, so "who saw the transcript" is a
 *  query rather than a guess about what a page happened to render. */
export const VISIT_PARTS = ["intake", "messages", "summary", "uploads"] as const;
export type VisitPart = (typeof VISIT_PARTS)[number];

/**
 * Every action that can be written, and how it reads on the audit page. The keys are the stored values, so a
 * new action is added here and nowhere else; a row written by an older build whose action this one does not
 * know is still shown, under its stored name (see actionLabel).
 *
 * The four `*.read` actions are §10.2's reads, the `sent` ones its sends, the `deleted` ones its deletions,
 * and `patient.verified` its patient-link verification. T14 adds `patient.deleted` and `retention.swept` when
 * the deletion action and the nightly sweep exist (§10.4, §10.5); T08 adds the six-digit code's own row.
 */
export const AUDIT_ACTIONS = {
  "intake.read": "Intake answers read",
  "messages.read": "Chat transcript read",
  "summary.read": "Summary read",
  "uploads.read": "Uploaded data read",
  "patient.verified": "Patient link accepted",
  "invite.sent": "Invite sent",
  "summary.sent": "Summary notice sent",
  "upload.deleted": "Upload deleted",
  "summary.deleted": "Summaries discarded",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];

/** The read action for one part of a visit. `VISIT_PARTS` and the keys above are kept in step by a test. */
export const readAction = (part: VisitPart): AuditAction => `${part}.read` as AuditAction;

/**
 * Which parts of a visit a `PatientBundle` actually carried (lib/bundle.ts), so the rows say what was seen
 * rather than what the screen has room for: a visit with no uploads records no `uploads.read`.
 *
 * `messages` is the transcript as a provider reads it. They are not handed the chat rows; they are handed
 * `Visit.notes`, which is those rows in the words Sweetie rendered for Sour (AGENTS.md, lib/sweetie.ts
 * renderNotes) — the patient's own account of their week either way, so reading it is reading the chat.
 *
 * Typed structurally rather than against PatientBundle, so this module stays free of imports (see the top of
 * the file); a PatientBundle satisfies it.
 */
export function visitPartsRead(bundle: {
  status: { hasDexcom: boolean; hasLocation: boolean; hasWhoop: boolean; answered: number };
  patient: { notes: string | null };
  providerSummary: unknown;
  patientSummary: unknown;
}): VisitPart[] {
  const parts: VisitPart[] = [];
  if (bundle.status.answered > 0) parts.push("intake");
  if (bundle.patient.notes?.trim()) parts.push("messages");
  if (bundle.providerSummary || bundle.patientSummary) parts.push("summary");
  if (bundle.status.hasDexcom || bundle.status.hasLocation || bundle.status.hasWhoop) parts.push("uploads");
  return parts;
}

/** What the page prints for an action, including one it does not know: shown as stored rather than blank, so
 *  a row from a newer build is still legible to the admin reading it. */
export const actionLabel = (action: string): string => (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;

/** §4.8 entityType: what the action was done to. */
export const ENTITY_TYPES = ["visit", "upload", "summary", "patient"] as const;

// ---------------------------------------------------------------------------------------------
// §4.8 "detail JSON without PHI".
//
// Two gates, because an allow-list of *names* is not enough on its own: `kind` is safe, but a caller that
// passed `kind: patient.name` would sail through a name check. So a value has to be the right *shape* too —
// a boolean, a finite number, or a short token with no spaces that is not shaped like a phone number or an
// address. Every field this app actually records is one of those (an upload kind, a channel, a count), and
// free text is not representable here at all. That is the point: there is no careful-wording path to getting
// a patient's words into this table.

/** The only field names that reach `detail`. Each is a constant, a count, or an opaque id. */
export const AUDIT_DETAIL_FIELDS: readonly string[] = [
  "requestId", // ties the row to the request's log lines (§11.1)
  "role",      // the actor's role when they did it (§5.2)
  "part",      // intake | messages | summary | uploads
  "parts",
  "kind",      // upload kind: dexcom | timeline | whoop | visits
  "kinds",
  "audience",  // provider | patient
  "channel",   // sms | email
  "provider",  // which sender or storage backend: ses | sns | twilio | resend | dev | s3 | fs
  "sent",
  "code",      // a short failure constant, never a message
  "count",     // reads coalesced into this row, or rows removed by a deletion
  "rows",
  "bytes",
  "summaries",
  "visitType", // one of lib/visits.ts's five ids, or "other"
];

const ALLOWED_DETAIL = new Set(AUDIT_DETAIL_FIELDS);

/** A constant, an id, or a short slug: no spaces, no `@`, nothing a sentence can hide in. 64 characters is a
 *  cuid with room to spare. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/** The number shapes PHI arrives in: a phone number, and a long digit run (an MRN, an account number). A
 *  cuid and a UUID both contain letters, so neither is caught by these. */
const PHONE_SHAPED = /\d[\d\s().-]{7,}\d/;
const LONG_DIGITS = /\d{7,}/;

/** The most elements an array field keeps. `parts` has four, `kinds` four; anything longer is a list nobody
 *  reads and a place for text to hide. */
const MAX_DETAIL_ITEMS = 20;

function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (!SAFE_TOKEN.test(value)) return undefined;
  if (PHONE_SHAPED.test(value) || LONG_DIGITS.test(value)) return undefined;
  return value;
}

export type AuditFields = Record<string, unknown>;

/**
 * The `detail` for a row: the allow-listed fields whose values are the right shape, and the names of the ones
 * that were not. Like lib/log.ts's sanitize, a dropped field is reported by *name* in `droppedFields` and
 * never by value, so a caller passing something it should not is visible on the audit page instead of silent.
 *
 * Null when there is nothing to say, which is most rows: an empty `{}` in the column reads as a detail that
 * went missing.
 */
export function auditDetail(fields: AuditFields = {}): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (!ALLOWED_DETAIL.has(key)) {
      dropped.push(key);
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_DETAIL_ITEMS).map(safeScalar).filter((v) => v !== undefined);
      if (items.length !== value.length) dropped.push(key);
      if (items.length) kept[key] = items;
      continue;
    }
    const scalar = safeScalar(value);
    if (scalar === undefined) dropped.push(key);
    else kept[key] = scalar;
  }
  if (dropped.length) kept.droppedFields = [...new Set(dropped)].sort();
  return Object.keys(kept).length ? kept : null;
}

/** The same, as the string the `detail` column holds. */
export function auditDetailJson(fields: AuditFields = {}): string | null {
  const detail = auditDetail(fields);
  return detail ? JSON.stringify(detail) : null;
}

/** A stored `detail` string, parsed back. Anything unparsable — a hand-edited row — reads as nothing rather
 *  than breaking the page it is on. */
export function parseAuditDetail(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// One row, as the page and the export read it.

export type AuditEntry = {
  id: string;
  /** ISO, not a Date: this shape crosses JSON to the audit screen (the same reason lib/team.ts gives). */
  at: string;
  actorType: string;
  actorId: string | null;
  /** Who, in words an admin recognises: a colleague's name or address, or "Patient" / "Scheduled job".
   *  Resolved from the practice's own users at read time — never stored, so the row keeps no contact detail. */
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: Record<string, unknown> | null;
};

/** How a non-user actor is named on screen. A patient is identified by the visit on the row, not here. */
export const ACTOR_LABELS: Record<string, string> = { patient: "Patient (own link)", system: "Scheduled job" };

// ---------------------------------------------------------------------------------------------
// Export (§10.2 "exportable").

export const AUDIT_CSV_HEADER = ["at", "actor", "actorType", "actorId", "action", "entityType", "entityId", "detail"] as const;

/** A spreadsheet reads a leading =, +, - or @ as a formula, so a value that starts with one is prefixed with
 *  an apostrophe. Nothing in `detail` can begin that way, but `actor` is a name an admin typed. */
const deformulate = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

const csvCell = (value: unknown): string => {
  const text = deformulate(value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** RFC 4180 CSV of the rows on screen, header first. CRLF line endings, which is what the spec says and what
 *  Excel wants; a reader that only knows LF is unbothered by the extra CR. */
export function auditCsv(entries: readonly AuditEntry[]): string {
  const rows = [
    [...AUDIT_CSV_HEADER].join(","),
    ...entries.map((e) =>
      [e.at, e.actor, e.actorType, e.actorId, e.action, e.entityType, e.entityId, e.detail ? JSON.stringify(e.detail) : ""]
        .map(csvCell)
        .join(","),
    ),
  ];
  return `${rows.join("\r\n")}\r\n`;
}

/** The filename the browser saves the export under. Dated, so two exports do not overwrite each other. */
export const auditCsvFilename = (now = new Date()): string => `sweetspot-audit-${now.toISOString().slice(0, 10)}.csv`;

// ---------------------------------------------------------------------------------------------
// Filtering (§10.2 "lists and filters entries").

export const AUDIT_LIMITS = [100, 250, 500] as const;
export const DEFAULT_AUDIT_LIMIT = 100;
const MAX_FILTER_TEXT = 64;

export type AuditFilter = {
  action?: string;
  actorId?: string;
  entityId?: string;
  /** Inclusive lower bound. */
  from?: Date;
  /** **Exclusive** upper bound: a `to` of 2026-10-14 is the end of that day, so the day the admin picked is
   *  included rather than cut off at midnight. */
  to?: Date;
  limit: number;
};

const text = (raw: string | null | undefined): string | undefined => {
  const value = raw?.trim().slice(0, MAX_FILTER_TEXT);
  return value || undefined;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A date from the filter form, which sends `YYYY-MM-DD`; a full ISO timestamp is accepted too. Unparsable
 *  is no filter rather than an error: a stale bookmark should show the log, not a 400. */
const date = (raw: string | null | undefined, endOfDay = false): Date | undefined => {
  const value = raw?.trim();
  if (!value) return undefined;
  const at = new Date(DAY.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(at.getTime())) return undefined;
  // A bare day as an upper bound means "including that day", so the bound is the midnight after it.
  if (endOfDay && DAY.test(value)) at.setUTCDate(at.getUTCDate() + 1);
  return at;
};

/**
 * The query string as a filter. Nothing here validates the vocabulary: an action nobody writes simply matches
 * no rows, which is the honest answer to asking for it, and the page's own dropdown only offers actions that
 * exist. The length cap is so a filter cannot be a payload.
 */
export function parseAuditFilter(params: URLSearchParams): AuditFilter {
  const limit = Number(params.get("limit"));
  return {
    action: text(params.get("action")),
    actorId: text(params.get("actorId")),
    entityId: text(params.get("entityId")),
    from: date(params.get("from")),
    to: date(params.get("to"), true),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, AUDIT_LIMITS[AUDIT_LIMITS.length - 1]) : DEFAULT_AUDIT_LIMIT,
  };
}
