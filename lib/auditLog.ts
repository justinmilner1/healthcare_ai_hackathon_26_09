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
 * The four `*.read` actions are §10.2's reads, the `sent` ones its sends, the `deleted` and `swept` ones its
 * deletions, and `patient.verified` its patient-link verification. `patient.deleted` is the staff action of
 * §10.5, written against the person who asked for it; `retention.swept` is the nightly job of §10.4, whose
 * actor is the job, and there is one row per visit it cleared — a visit's data going is one deletion.
 *
 * The two `patient.consent_*` actions are §2.4's screen, which is not one of §10.2's four categories either
 * and is here because it is the answer the rest of the trail rests on: every row about this visit's data
 * exists because the patient said yes first.
 *
 * `summary.reviewed` is not one of §10.2's four categories; it is §7.3's clinical sign-off, recorded here
 * because "a clinician reviewed this before the visit" is exactly the kind of claim an admin is later asked
 * to stand behind, and the row is the only place it is visible next to who read what. `summary.question` is
 * §7.5's follow-up, and is a read of the same kind: a clinician put a question about this patient's week to
 * the model, which is one more thing an admin has to be able to see was done. One row per question asked,
 * never coalesced — and the question itself is not on the row, only that there was one (§4.8); what was
 * asked lives on the visit, where only the people who may read the summary can see it (lib/followUps.ts).
 */
export const AUDIT_ACTIONS = {
  "intake.read": "Intake answers read",
  "messages.read": "Chat transcript read",
  "summary.read": "Summary read",
  "uploads.read": "Uploaded data read",
  "patient.verified": "Patient link accepted",
  // §2.4's one screen, both ways it can be answered (T09, T51). A patient-side decision like the
  // verification above, and recorded for the same reason: the practice is later asked to stand behind the
  // claim that this patient agreed before anything was collected, and a decline is the moment a session was
  // ended on the patient's own say-so. One row per visit either way — a second acceptance keeps the first
  // one's time (lib/consent.ts recordConsent) and writes nothing.
  "patient.consent_accepted": "Intake consent accepted",
  "patient.consent_declined": "Intake consent declined",
  "invite.sent": "Invite sent",
  "code.sent": "Verification code sent",
  "summary.sent": "Summary notice sent",
  "deletion.sent": "Deletion confirmation sent",
  // §8.1 A channel closing or reopening, from what SES or SNS told us (lib/notifyStore.ts): the bounce, the
  // spam report, the patient texting STOP, the patient texting START. Not one of §10.2's four categories and
  // recorded anyway, because "why did this patient stop getting their invites" is a question an admin is
  // asked and should not have to answer out of a log search. The row says which channel and the provider's
  // own word for it, never the address or the number (§4.8).
  "contact.suppressed": "Contact channel closed",
  "contact.resumed": "Contact channel reopened",
  // §4.2's `name`, set by the person it belongs to on the settings screen (T115). Not one of §10.2's four
  // categories and recorded for the reason `summary.reviewed` below is: the users table is what an admin is
  // shown when they are asked who works here, so how a name on it got there is a question they can be put.
  // The row says whose row changed and the role it carries, never the name itself — `detail` is counts and
  // constants (§4.8), and a colleague's name is not one.
  "user.name_set": "Name set",
  "summary.reviewed": "Summary marked reviewed",
  "summary.question": "Follow-up question asked",
  "upload.deleted": "Upload deleted",
  "summary.deleted": "Summaries discarded",
  "patient.deleted": "Patient data deleted",
  "retention.swept": "Visit data removed by retention",
  // §10.5's unfinished deletions, finished later (T70). A purge that the object store refused leaves the
  // prefix on `StorageOrphan`; the nightly job comes back to it, and when the bytes finally go that is a
  // deletion §10.2 counts like any other. One row per practice per pass, against the job — nobody pressed
  // anything, and the patient it was for is already a blanked row (§4.3).
  "storage.orphans_purged": "Orphaned files removed",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];

/** The read action for one part of a visit. `VISIT_PARTS` and the keys above are kept in step by a test. */
export const readAction = (part: VisitPart): AuditAction => `${part}.read` as AuditAction;

/**
 * Which parts of a visit a `PatientBundle` actually carried (lib/bundle.ts), so the rows say what was seen
 * rather than what the screen has room for: a visit with no uploads records no `uploads.read`.
 *
 * `messages` is the transcript as a provider reads it, and since T154 that is *both* of the two things it
 * could mean, so the row is recorded for either. `Visit.notes` is the patient's answers in the words
 * Sweetie rendered for Sour (AGENTS.md, lib/sweetie.ts `renderNotes`). The patient's chat rows themselves
 * are handed over too, in `patientMessages`: the brief quotes them verbatim wherever the notes hold no
 * answer of the patient's (§2.6, lib/patientWords.ts), which is where the old reading of this comment was
 * false — the flag line alone is non-empty notes, so §10.2 was recording a `messages.read` against a
 * clinician who had been shown none of the patient's words.
 *
 * Typed structurally rather than against PatientBundle, so this module stays free of imports (see the top of
 * the file); a PatientBundle satisfies it.
 */
export function visitPartsRead(bundle: {
  status: { hasDexcom: boolean; hasLocation: boolean; hasWhoop: boolean; answered: number };
  patient: { notes: string | null };
  patientMessages: string[];
  providerSummary: unknown;
  patientSummary: unknown;
}): VisitPart[] {
  const parts: VisitPart[] = [];
  if (bundle.status.answered > 0) parts.push("intake");
  if (bundle.patient.notes?.trim() || bundle.patientMessages.some((m) => m.trim())) parts.push("messages");
  if (bundle.providerSummary || bundle.patientSummary) parts.push("summary");
  if (bundle.status.hasDexcom || bundle.status.hasLocation || bundle.status.hasWhoop) parts.push("uploads");
  return parts;
}

/** What the page prints for an action, including one it does not know: shown as stored rather than blank, so
 *  a row from a newer build is still legible to the admin reading it. */
export const actionLabel = (action: string): string => (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;

/**
 * Which `detail` field is a problem rather than a count, so the page can print it as a warning (T70).
 *
 * `droppedFields` is a caller that passed something §4.8 would not store. `orphans` above zero is the one
 * that says a deletion did not finish: the rows are gone and that many stored objects are not. An admin
 * filtering to "Patient data deleted" to confirm a request has to see that at a glance rather than read it
 * out of a number sitting in the same grey as `objects` beside it. Zero is the ordinary case and stays quiet.
 *
 * Here rather than in the page for the reason the labels are: this is the vocabulary, and §12.1 can assert
 * it without rendering anything (lib/auditLog.test.ts).
 */
export const detailWarns = (key: string, value: unknown): boolean =>
  key === "droppedFields" || (key === "orphans" && typeof value === "number" && value > 0);

/** What an admin is told when they hover the one pill that is warning them about something. */
export const ORPHANS_WARNING = "The storage backend refused this many objects. The deletion is unfinished until a later pass clears them.";

// ---------------------------------------------------------------------------------------------
// What the page says about itself (§10.2, §10.7, T219).
//
// The lede over the audit table was a literal in the JSX, and it claimed two things the table directly
// beneath it contradicted. That entries "are never edited or removed": a repeated read moves an existing
// row's `at` forward and rewrites its `detail` with a higher count (`absorbed` in lib/auditStore.ts), which
// is both of the columns the sentence went on to name. And that a row carries "only who, what, and when",
// over five columns — the other two being `On`, which the page's own filter bar offers to search by, and
// `Detail`. §10.7 makes integrity a HIPAA control, so the one page whose subject is the record itself is
// where overstating it costs something.
//
// Here rather than in the page for the reason the labels and `detailWarns` are: a sentence that makes a
// claim about the store is a decision, and a decision the unit suite cannot call is one nothing holds
// (§12.1). That is T205's pattern, and it is also why this went uncaught — there was nothing in lib/ to
// write a test against. The coalescing window and the column list are now the sentence's only inputs, so
// turning coalescing off or adding a sixth column changes what the admin reads.
//
// What is *not* claimed here is tamper resistance. A row is an ordinary Postgres row and anyone with the
// database password can change one (docs/COMPLIANCE.md, risk `R4`); this sentence is about what the app
// itself does, which is the only thing the page can honestly speak for.

/**
 * How close two identical reads have to be to become one row. One minute: long enough to swallow a page's
 * polling, short enough that opening a visit again after a consultation is its own row.
 *
 * In the pure module rather than in lib/auditStore.ts, which is what applies it, because the sentence above
 * the table describes this number and the page may not import the store (see the top of this file). The
 * store takes it from here, so there is one of it.
 */
export const READ_COALESCE_MS = 60_000;

/**
 * The columns of the audit table, in order, each with the words the lede uses for what it carries.
 *
 * One list, read twice: `app/provider/audit/audit.tsx` draws its `<th>` and its per-row mobile labels from
 * it, and `auditRowSentence` enumerates it. That is what stops the two disagreeing — the bug this ticket was
 * filed about was a sentence naming three of them over a table showing five.
 */
export const AUDIT_COLUMNS = [
  { header: "When", carries: "when" },
  { header: "Who", carries: "who" },
  { header: "What", carries: "what" },
  // Opaque either way: a cuid for the row's `entityId`, with its `entityType` beside it. Saying "the id"
  // rather than naming the thing is the honest reading — §10.2's subject is a visit, but a deletion row is
  // against a patient and a sweep row against a practice.
  { header: "On", carries: "the id of what was touched" },
  { header: "Detail", carries: "a few counts and constants" },
] as const;

export type AuditColumn = (typeof AUDIT_COLUMNS)[number];
/** The five header strings as a union, so a column added here is a column the page will not compile without. */
export type AuditColumnHeader = AuditColumn["header"];

/** §10.2's scope: which events reach this table at all, and who may read it. */
export const AUDIT_LEDE_SCOPE =
  "Every read of a visit's answers, chat, uploads or summary; every patient link accepted; every message sent; every deletion. Admins only.";

/** An English list: `a`, `a and b`, `a, b and c`. */
const sentenceList = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * What a row carries, enumerated from the columns themselves.
 *
 * The `carries no patient details` half is the true half of the old sentence and is kept as it was: `On` is
 * an opaque cuid and `Detail` is counts and constants, both of them behind the gate below. It is the
 * enumeration after the dash that was false, and it is no longer written by hand.
 */
export const auditRowSentence = (columns: readonly { carries: string }[] = AUDIT_COLUMNS): string =>
  `A row carries no patient details — only ${sentenceList(columns.map((c) => c.carries))}.`;

/** The coalescing window in words a sentence can use: 60_000 is "a minute", 30_000 "30 seconds". */
export function coalesceWindowWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "a minute" : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

/**
 * Whether a row is ever written twice, and when — the claim T219 was filed about, and what T220 made true.
 *
 * Both branches are here so the sentence follows the rule rather than describing one setting of it. With
 * coalescing off, every event is its own row and nothing is ever rewritten, which is what the old lede said
 * and what would make it true again.
 *
 * With it on, the sentence now names the two things that make the window a window: the read has to fall
 * inside it *of the first* read on the row, and the row carries both ends of the span. Until T220 the store
 * measured the window from the last read it had absorbed and moved `at` to it, so the window slid and one
 * row could stand for a span of any length while this sentence called it a minute — the page was not
 * overstating the store's claim so much as the store had no bound to state. It has one now (`firstAt`,
 * lib/auditStore.ts `absorbed`), and this is where an admin is told what it is.
 *
 * What does not change either way: verifications, sends and deletions are never coalesced (lib/auditStore.ts
 * says why — each is its own event). The wording keeps that distinction rather than flattening it into one
 * claim about every row.
 */
export function auditCoalescingSentence(coalesceMs: number = READ_COALESCE_MS): string {
  if (!(coalesceMs > 0)) return "Every event is its own row, and a row is never changed once it is written.";
  const window = coalesceWindowWords(coalesceMs);
  return (
    `A repeated identical read within ${window} of the first is counted on the row already there, which keeps ` +
    `the time it began and shows the span up to the latest of them, so no row stands for more than ${window}; ` +
    "verifications, sends and deletions are each their own row."
  );
}

/** How long a row stands for and how many events it counts: `ms` the true gap in milliseconds, `seconds` the
 *  gap a reader of the row's two printed stamps counts (`auditSpanSeconds`), `words` that second count as a
 *  cell prints it, `reads` the row's own `detail.count`.
 *
 *  `ms` and `seconds` are two different facts about one pair of instants and are meant to differ: `ms` is the
 *  gap the record holds and the bound of T220 is about, `seconds` is the gap the cell is able to show. Only
 *  `seconds` may be put into words, because the words sit between the two stamps they are counting.
 *
 *  `words` is `null` on a row whose two stamps *print* out of order — `at` before `firstAt`, a clock that
 *  moved between the first write and an absorb. There is no span a reader of those two stamps could check,
 *  so the cell states none; `auditSpanClause` is what it says instead, and `auditSpanWords` says why. */
export type AuditRowSpan = { ms: number; seconds: number; words: string | null; reads: number };

/**
 * The span a row stands for: the gap between the first event counted on it and the last. Null when the row
 * is one event at one moment, which is every row but a coalesced read — there is no span to report and an
 * admin should not be shown a zero.
 *
 * Here rather than in the page for the reason the labels and the sentence are (T205, T219): what a cell
 * claims about the record is a decision, and §12.1 can ask about it without rendering anything. `reads`
 * comes from `detail.count`, so a row that counted events faster than the clock can resolve still says how
 * many it stands for instead of looking like a single read.
 */
export function auditRowSpan(entry: Pick<AuditEntry, "at" | "firstAt" | "detail">): AuditRowSpan | null {
  const ended = Date.parse(entry.at);
  const began = Date.parse(entry.firstAt);
  const counted = entry.detail?.count;
  const reads = typeof counted === "number" && Number.isFinite(counted) && counted > 1 ? Math.floor(counted) : 1;
  if (!Number.isFinite(ended) || !Number.isFinite(began)) return null;
  // A clock that went backwards between two writes is the one case where `at` precedes `firstAt`. Report the
  // count and no span rather than a negative one: the row is still evidence of N reads. `auditSpanWords`
  // withholds the words when the two *printed* stamps are out of order, which is the only disorder a reader
  // can see, and `auditSpanClause` says what the cell prints in their place (T222).
  const ms = Math.max(0, ended - began);
  if (ms === 0 && reads === 1) return null;
  return { ms, seconds: auditSpanSeconds(began, ended), words: auditSpanWords(began, ended), reads };
}

/**
 * The gap between two instants in whole seconds, counted the way a reader of the cell counts it: by
 * subtracting the two stamps the cell prints (T222).
 *
 * `toLocaleString()` *truncates* to the second, so the only gap a reader can see is the gap between the two
 * truncations — and the difference of two truncated-to-the-second times is the difference of their floors,
 * whatever the local offset, because the offset is the same on both and cancels. Rounding the true gap
 * instead is what made the cell contradict itself: `.800` to `.100` across two seconds is a real 1.3s, which
 * rounds to one second while the two stamps print two apart, and `.600` to `.000` across one second is a real
 * 0.4s, which rounds to nothing at all while the stamps print a second apart. The round and the truncate
 * disagree whenever the fractional parts straddle a boundary, and the cell showed both answers at once.
 *
 * So the span is a fact about the pair of stamps rather than about the duration, and a caller has to name
 * both ends to get it. That is also why `auditSpanWords` takes two instants and not a duration: there is no
 * correct wording of a bare gap, since the words are read next to the stamps and not next to the milliseconds
 * (the exported CSV keeps those at full precision — `AUDIT_CSV_HEADER` — and is where the real figure lives).
 *
 * A clock that moved backwards between two writes is floored at zero here, as it is in `auditRowSpan`.
 */
export function auditSpanSeconds(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor(toMs / 1000) - Math.floor(fromMs / 1000));
}

/**
 * Whether the two stamps a cell prints are in the order the cell presents them — the first after "from", the
 * second on the line above it. The question is about the *printed* stamps and not about the instants, because
 * that is the only order a reader can see: `toLocaleString()` truncates to the second, so a pair 5ms out of
 * order prints as one second twice and is in no visible disorder at all, while a pair a second out of order
 * prints two stamps a reader can put the wrong way round.
 *
 * False for an unparsable end, which `auditRowSpan` has already turned into "no span" by the time it asks.
 */
export function auditStampsOrdered(fromMs: number, toMs: number): boolean {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
  return Math.floor(toMs / 1000) >= Math.floor(fromMs / 1000);
}

/**
 * The span between two instants in words, as a cell prints it between the two stamps it is counting. Zero
 * is "under a second" rather than "0 seconds": two reads inside one second are a real pair of reads and the
 * row should not read as rounding them away — and the two stamps print identically, so there is no visible
 * gap for those words to deny. Takes the two ends, never a duration: `auditSpanSeconds` says why.
 *
 * `null` when the two stamps print out of order, which is the second half of T222 and a decision rather than
 * a correction. `auditSpanSeconds` floors such a pair at zero, and wording *that* is how "under a second"
 * came to be printed over two stamps 42 seconds apart — the ticket's own worst reading, at 42s instead of at
 * one, denying a gap it was printing beside the denial.
 *
 * Three things could be done with it, and only one of them is honest about the record:
 *
 *   - **Order the two stamps before wording them.** The sentence comes out coherent and checkable, but "from"
 *     would then name the stamp of the *last* absorb as the moment the row began. That is a false claim about
 *     the record, and a false claim is worse than a missing one on the one page whose job is to be trusted.
 *   - **Word the visible gap and drop the "from" framing.** The gap is real, but with `firstAt` off the
 *     screen the reader has nothing to check it against — and the direction the words imply is the one the
 *     record denies.
 *   - **Withhold the span, keep everything that is still true.** What the row actually supports is how many
 *     reads it stands for and the two stamps themselves. So the cell prints the count, prints both stamps,
 *     and says why there is no span instead of asserting one.
 *
 * The third is what this does. It makes T222's criterion 2 absolute — "under a second" cannot appear over
 * stamps that differ, because no span words are produced for such a pair at all — with no exception carved
 * out for a clock that moved. The full-precision pair survives either way in `AUDIT_CSV_HEADER`, which is
 * where the real figure lives and where an admin can do the subtraction the screen declines to.
 */
export function auditSpanWords(fromMs: number, toMs: number): string | null {
  if (!auditStampsOrdered(fromMs, toMs)) return null;
  const seconds = auditSpanSeconds(fromMs, toMs);
  if (seconds < 1) return "under a second";
  if (seconds === 1) return "1 second";
  if (seconds % 60 !== 0 || seconds < 60) return `${seconds} seconds`;
  return coalesceWindowWords(seconds * 1000);
}

/** What the span line of a `When` cell reads, and what its `title` holds: the whole clause, decided here so
 *  that §12.1 can ask what a cell claims about a record without rendering anything (T205, T219, T222 AC3).
 *  The caller supplies `firstAt` already formatted, because the locale belongs to the page and the wording
 *  does not.
 *
 *  `line` stays about as short as the ordered one it sits in for, because it is a table cell at 375px as
 *  well as on a laptop; `title` is where the whole of why there is no span goes. */
export type AuditSpanClause = { line: string; title: string };

export function auditSpanClause(span: AuditRowSpan, firstAt: string): AuditSpanClause {
  if (span.words === null)
    return {
      line: `${span.reads} reads, first stamped ${firstAt} — later than this row, so no span is shown`,
      title:
        `${span.reads} identical reads. The first is stamped ${firstAt}, which is later than this row's own ` +
        "time, so the clock moved between the two writes and the span between them cannot be stated. The " +
        "exported CSV carries both stamps at full precision.",
    };
  return {
    line: `${span.reads} reads over ${span.words}, from ${firstAt}`,
    title: `${span.reads} identical reads, the first at ${firstAt}`,
  };
}

/** The lede over the audit table, as the page prints it: §10.2's scope, then what a row holds, then what the
 *  store does to a row that is already there. */
export const auditLede = (coalesceMs: number = READ_COALESCE_MS): string =>
  `${AUDIT_LEDE_SCOPE} ${auditRowSentence()} ${auditCoalescingSentence(coalesceMs)}`;

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
  "method",    // how something was proved or done: one_time_code
  "provider",  // which sender or storage backend: ses | sns | twilio | resend | dev | s3 | fs
  "sent",
  "code",      // a short failure constant, never a message
  "count",     // how many identical events this row stands for (lib/auditStore.ts, coalescing)
  "rows",      // how many rows the action itself touched: uploads removed, readings parsed
  "hours",     // how long something lasts: the verified patient session's 24 (§5.3)
  "bytes",
  "summaries",
  "visitType", // one of lib/visits.ts's five ids, or "other"
  // §10.4, §10.5: what a purge removed. Counts and one boolean, so a deletion records its size and never
  // what was in it (lib/retention.ts PurgeCounts).
  "visits",
  "uploads",
  "turns",    // chat rows removed. Not "messages": §4.8's guard refuses a field that could pass for one
  "objects",  // stored files removed from S3 or the local backend
  "orphans",  // objects the storage backend would not remove, so an admin can see bytes were left behind
  "prefixes", // how many storage prefixes a later pass re-attempted (§10.5, T70)
  "dexcom",   // whether the patient's encrypted Dexcom tokens were among the things deleted (§4.10)
  "days",     // the practice's retention window, on a sweep row
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
  /** When the row's *first* event happened, which is `at` on every row except one read coalescing has
   *  absorbed into. `firstAt` is written once and never again, so the pair is the span the row stands for
   *  and `at - firstAt` is bounded by READ_COALESCE_MS (T220, lib/auditStore.ts `absorbed`). */
  firstAt: string;
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

/** `firstAt` sits next to `at` because the two are one fact — the span the row stands for — and the export
 *  may not be weaker than the screen about it (§10.2 "exportable", T220 AC6). */
export const AUDIT_CSV_HEADER = ["at", "firstAt", "actor", "actorType", "actorId", "action", "entityType", "entityId", "detail"] as const;

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
      [e.at, e.firstAt, e.actor, e.actorType, e.actorId, e.action, e.entityType, e.entityId, e.detail ? JSON.stringify(e.detail) : ""]
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
