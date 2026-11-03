import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  actionLabel,
  auditCoalescingSentence,
  auditCsv,
  auditCsvFilename,
  auditDetail,
  auditDetailJson,
  auditLede,
  auditRowSentence,
  auditRowSpan,
  auditSpanClause,
  auditSpanSeconds,
  auditStampsOrdered,
  auditSpanWords,
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_COLUMNS,
  AUDIT_LEDE_SCOPE,
  coalesceWindowWords,
  detailWarns,
  ORPHANS_WARNING,
  AUDIT_CSV_HEADER,
  AUDIT_DETAIL_FIELDS,
  AUDIT_LIMITS,
  DEFAULT_AUDIT_LIMIT,
  parseAuditDetail,
  parseAuditFilter,
  readAction,
  READ_COALESCE_MS,
  visitPartsRead,
  VISIT_PARTS,
  type AuditEntry,
} from "./auditLog";

// Design §4.8 and §10.2, which between them say what a row may contain and what has to produce one.

test("every part of a visit §10.2 counts as a read has an action, and nothing is spelled twice", () => {
  for (const part of VISIT_PARTS) {
    const action = readAction(part);
    assert.ok(action in AUDIT_ACTIONS, `${part} has no ${action} action, so that read could not be recorded`);
  }
  const labels = AUDIT_ACTION_NAMES.map((a) => actionLabel(a));
  assert.equal(new Set(labels).size, labels.length, "two actions read the same on the page");
  for (const [action, label] of Object.entries(AUDIT_ACTIONS)) {
    assert.ok(label.length > 3 && label !== action, `${action} needs a label an admin can read`);
  }
});

test("§10.2's four categories are all in the vocabulary", () => {
  // Reads, patient-link verification, sends, deletions — the sentence, item by item.
  assert.deepEqual(AUDIT_ACTION_NAMES.filter((a) => a.endsWith(".read")).length, VISIT_PARTS.length);
  for (const action of [
    "patient.verified",
    "invite.sent",
    "code.sent",
    "summary.sent",
    "upload.deleted",
    "summary.deleted",
    // §10.4's nightly sweep and §10.5's staff action are deletions too, and the sentence says every one.
    "patient.deleted",
    "retention.swept",
    // T70: a deletion the object store refused, finished by a later pass. The bytes going is the deletion;
    // without a row for it the trail says the request was unfinished and never says it stopped being.
    "storage.orphans_purged",
  ]) {
    assert.ok(AUDIT_ACTION_NAMES.includes(action as never), `${action} is missing`);
  }
});

test("§2.4's consent screen is in the vocabulary, both ways it can be answered (T51)", () => {
  // The two rows app/api/consent/route.ts writes. Before T51 they were written straight to the table and
  // were not keys here, so the audit page printed the raw string and the Action dropdown — which is
  // AUDIT_ACTION_NAMES — could not select them at all.
  for (const action of ["patient.consent_accepted", "patient.consent_declined"] as const) {
    assert.ok(action in AUDIT_ACTIONS, `${action} is missing, so the audit page cannot name or filter it`);
    assert.ok(AUDIT_ACTION_NAMES.includes(action), `${action} is not offered in the Action filter`);
    assert.notEqual(actionLabel(action), action, `${action} reads as its raw stored string`);
  }
  // Two answers, told apart on the page: an admin reading the trail must not have to guess which it was.
  assert.notEqual(AUDIT_ACTIONS["patient.consent_accepted"], AUDIT_ACTIONS["patient.consent_declined"]);
  // What the decline records is the sessions it closed, and §4.8's gate takes it as a count.
  assert.deepEqual(auditDetail({ rows: 1 }), { rows: 1 });
  // The hand-rolled detail it used to carry is not representable: neither name is allow-listed.
  assert.deepEqual(auditDetail({ screen: "intake_consent", section: "2.4" }), { droppedFields: ["screen", "section"] });
});

test("§10.5's later pass can say how much of the backlog it walked (T70)", () => {
  // The three counts a `storage.orphans_purged` row carries. All numbers, so §4.8's gate takes them whole.
  assert.deepEqual(auditDetail({ prefixes: 2, objects: 5, orphans: 1 }), { prefixes: 2, objects: 5, orphans: 1 });
});

test("an unfinished deletion is read as a warning on the audit page, and a finished one is not (T70)", () => {
  // The row an admin opens /provider/audit to confirm a deletion request with. `orphans: 0` is the ordinary
  // case and must not shout; above zero the rows are gone and the bytes are not, which is the whole point of
  // looking. Same pill, same column, so the colour is the only thing that can carry it.
  assert.equal(detailWarns("orphans", 1), true);
  assert.equal(detailWarns("orphans", 0), false);
  assert.equal(detailWarns("objects", 12), false, "how much went is a count, not a problem");
  assert.equal(detailWarns("droppedFields", ["screen"]), true, "§4.8 refusing a field is the other warning");
  // A stored row is JSON, so a hand-edited one can hold anything; nothing but a positive number warns.
  assert.equal(detailWarns("orphans", "1"), false);
  assert.equal(detailWarns("orphans", -1), false);
  assert.ok(ORPHANS_WARNING.length > 20, "and the hover says what the admin should do about it");
});

test("an action from a newer build is shown as stored rather than blank", () => {
  assert.equal(actionLabel("export.downloaded"), "export.downloaded");
  assert.equal(actionLabel("summary.read"), AUDIT_ACTIONS["summary.read"]);
  assert.equal(actionLabel("retention.swept"), AUDIT_ACTIONS["retention.swept"], "but one this build knows reads in words");
});

// ---------------------------------------------------------------------------------------------
// §4.8: "detail JSON without PHI".

test("what a deletion recorded is counts, and §4.8's gate takes them (§10.4, §10.5)", () => {
  // Every field lib/retentionStore.ts writes, in the two shapes it writes them.
  assert.deepEqual(auditDetail({ days: 365, uploads: 2, turns: 11, summaries: 2, objects: 2, orphans: 0 }), {
    days: 365,
    uploads: 2,
    turns: 11,
    summaries: 2,
    objects: 2,
    orphans: 0,
  });
  assert.deepEqual(auditDetail({ visits: 3, uploads: 4, turns: 20, summaries: 6, objects: 4, orphans: 1, dexcom: true }), {
    visits: 3,
    uploads: 4,
    turns: 20,
    summaries: 6,
    objects: 4,
    orphans: 1,
    dexcom: true,
  });
});

test("the allow-listed fields go through as they are", () => {
  const detail = auditDetail({ part: "summary", kind: "dexcom", channel: "sms", provider: "ses", sent: true, count: 3, rows: 288, bytes: 10240 });
  assert.deepEqual(detail, { part: "summary", kind: "dexcom", channel: "sms", provider: "ses", sent: true, count: 3, rows: 288, bytes: 10240 });
});

test("a field nobody allow-listed is reported by name and never by value", () => {
  const detail = auditDetail({ kind: "dexcom", patientName: "Sam Sample", note: "felt dizzy after dinner" })!;
  assert.deepEqual(detail, { kind: "dexcom", droppedFields: ["note", "patientName"] });
  assert.ok(!JSON.stringify(detail).includes("Sam"));
  assert.ok(!JSON.stringify(detail).includes("dizzy"));
});

test("PHI does not reach the detail column, whatever it is called on the way in", () => {
  // The heart of §4.8. Every one of these is a real value from somewhere in the app — a patient's name,
  // their phone and email, what they told Sweetie, a summary line, the reason the visit was booked, the
  // filename they picked, their invite token (a credential, §5.3) — offered under both its own name and an
  // allow-listed one, which is the mistake a careless caller actually makes.
  const phi = {
    name: "Sam Sample",
    phone: "+1 415-555-0132",
    email: "sam.sample@example.com",
    message: "I ate late at Tony's and woke up at 240",
    summary: "3 of 4 overnight highs followed dinners out after 8pm",
    reason: "mornings running high",
    filename: "Clarity_Export_Sample.csv",
    token: "8Kd0_zqY1nQ2vF4rT6sL9w",
    dob: "1984-07-02",
    mrn: "0042194771",
    // The same values again, under names that *are* allow-listed.
    kind: "Sam Sample",
    channel: "sam.sample@example.com",
    provider: "+1 415-555-0132",
    code: "I ate late at Tony's",
    part: "1984-07-02",
    visitType: "0042194771",
    parts: ["Sam Sample", "mornings running high"],
  };
  const json = auditDetailJson(phi) ?? "";
  for (const [field, value] of Object.entries(phi)) {
    for (const text of Array.isArray(value) ? value : [value]) {
      assert.ok(!json.includes(text), `${field} put ${JSON.stringify(text)} in the detail column`);
    }
  }
  // The names are there, so a caller passing the wrong thing is visible rather than silently fine.
  const detail = parseAuditDetail(json)!;
  assert.deepEqual(Object.keys(detail), ["droppedFields"]);
  assert.deepEqual(detail.droppedFields, Object.keys(phi).sort());
});

test("an allow-listed field still has to be the right shape", () => {
  // A token with no spaces is what a constant looks like; a sentence, an address and a phone number are not.
  for (const value of ["two words", "sam@example.com", "415-555-0132", "0042194771", "", " dexcom"]) {
    assert.deepEqual(auditDetail({ kind: value }), { droppedFields: ["kind"] }, JSON.stringify(value));
  }
  for (const value of ["dexcom", "post_hospital", "notify.invite", "s3", "c0abcdefghijklmnopqrstuvw"]) {
    assert.deepEqual(auditDetail({ kind: value }), { kind: value }, JSON.stringify(value));
  }
  // Not a scalar at all: an object is a place to hide a whole patient.
  assert.deepEqual(auditDetail({ kind: { name: "Sam" } }), { droppedFields: ["kind"] });
  assert.deepEqual(auditDetail({ count: Number.NaN }), { droppedFields: ["count"] });
  assert.deepEqual(auditDetail({ count: Infinity }), { droppedFields: ["count"] });
});

test("a list keeps the safe items and says that it dropped the rest", () => {
  assert.deepEqual(auditDetail({ parts: ["intake", "summary"] }), { parts: ["intake", "summary"] });
  assert.deepEqual(auditDetail({ kinds: ["dexcom", "a whole sentence"] }), { kinds: ["dexcom"], droppedFields: ["kinds"] });
  // Capped, so a long list is not a hiding place.
  const long = auditDetail({ parts: Array.from({ length: 50 }, (_, i) => `p${i}`) })!;
  assert.equal((long.parts as string[]).length, 20);
});

test("nothing to say is null, and an absent field is not a drop", () => {
  assert.equal(auditDetail(), null);
  assert.equal(auditDetail({}), null);
  assert.equal(auditDetail({ kind: undefined, count: null }), null);
  assert.equal(auditDetailJson({}), null);
});

test("a stored detail parses back, and an unparsable one reads as nothing", () => {
  assert.deepEqual(parseAuditDetail(auditDetailJson({ kind: "whoop", rows: 7 })), { kind: "whoop", rows: 7 });
  for (const raw of [null, undefined, "", "{oops", "[1,2]", '"text"']) assert.equal(parseAuditDetail(raw), null, JSON.stringify(raw));
});

test("every allow-listed name is one a reader of §4.8 would accept", () => {
  // A guard on the list itself: nothing in it may be named for a person, a place or a piece of text.
  for (const field of AUDIT_DETAIL_FIELDS) {
    assert.doesNotMatch(field, /name|email|phone|address|message|note|text|reason|filename|token|summary$|dob|mrn/i, `${field} is not a field §4.8 allows`);
  }
});

// ---------------------------------------------------------------------------------------------
// The export (§10.2 "exportable").

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "c0aaaaaaaaaaaaaaaaaaaaaaa",
  at: "2026-10-14T09:30:00.000Z",
  firstAt: "2026-10-14T09:29:18.000Z",
  actorType: "user",
  actorId: "c0bbbbbbbbbbbbbbbbbbbbbbb",
  actor: "Dr. Demo Endo",
  action: "summary.read",
  entityType: "visit",
  entityId: "c0ccccccccccccccccccccccc",
  detail: { part: "summary", count: 2 },
  ...over,
});

test("the CSV has the header, one line per row, and CRLF endings", () => {
  const csv = auditCsv([entry()]);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], [...AUDIT_CSV_HEADER].join(","));
  assert.match(lines[1], /^2026-10-14T09:30:00\.000Z,2026-10-14T09:29:18\.000Z,Dr\. Demo Endo,user,/);
  assert.equal(lines[2], "", "the file ends with a line break");
  assert.equal(auditCsv([]), `${[...AUDIT_CSV_HEADER].join(",")}\r\n`);
});

test("a cell with a comma, a quote or a newline survives a round trip", () => {
  const csv = auditCsv([entry({ actor: 'Chen, Maya "Doc"\nSecond line' })]);
  assert.ok(csv.includes('"Chen, Maya ""Doc""\nSecond line"'));
  // The detail is JSON, which is full of commas and quotes, so it is quoted the same way.
  assert.ok(csv.includes('"{""part"":""summary"",""count"":2}"'));
});

test("a value a spreadsheet would run as a formula is defused", () => {
  // `actor` is a name an admin typed, and a CSV export is opened in Excel.
  assert.ok(auditCsv([entry({ actor: "=1+1" })]).includes("'=1+1"));
  assert.ok(auditCsv([entry({ actor: "@SUM(A1)" })]).includes("'@SUM(A1)"));
  assert.ok(auditCsv([entry({ actor: "-2+3" })]).includes("'-2+3"));
});

test("an empty detail or a missing id is an empty cell, not the word null", () => {
  const line = auditCsv([entry({ detail: null, entityId: null, actorId: null })]).split("\r\n")[1];
  assert.equal(line.split(",").filter((cell) => cell === "").length, 3);
  assert.ok(!line.includes("null"));
});

test("the export filename carries the day it was taken", () => {
  assert.equal(auditCsvFilename(new Date("2026-10-14T23:59:00.000Z")), "sweetspot-audit-2026-10-14.csv");
});

// ---------------------------------------------------------------------------------------------
// Filtering (§10.2 "lists and filters entries").

const filter = (query: string) => parseAuditFilter(new URLSearchParams(query));

test("no filter is the newest page of everything", () => {
  assert.deepEqual(filter(""), { action: undefined, actorId: undefined, entityId: undefined, from: undefined, to: undefined, limit: DEFAULT_AUDIT_LIMIT });
});

test("the limit is clamped to what the page offers", () => {
  const biggest = AUDIT_LIMITS[AUDIT_LIMITS.length - 1];
  assert.equal(filter("limit=250").limit, 250);
  assert.equal(filter("limit=100000").limit, biggest);
  for (const bad of ["limit=0", "limit=-5", "limit=abc", "limit=10.5", "limit="]) assert.equal(filter(bad).limit, DEFAULT_AUDIT_LIMIT, bad);
});

test("a day given as the upper bound includes that whole day", () => {
  // Otherwise "to: today" shows nothing that happened today, which is the first thing an admin tries.
  const { from, to } = filter("from=2026-10-01&to=2026-10-14");
  assert.equal(from?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(to?.toISOString(), "2026-10-15T00:00:00.000Z");
  // A full timestamp is taken as given: it is already an instant, not a day.
  assert.equal(filter("to=2026-10-14T09:00:00.000Z").to?.toISOString(), "2026-10-14T09:00:00.000Z");
});

test("an unreadable date is no filter rather than an error", () => {
  for (const bad of ["from=yesterday", "from=2026-13-45", "from="]) assert.equal(filter(bad).from, undefined, bad);
});

test("the text filters are trimmed, and capped so a filter cannot be a payload", () => {
  assert.equal(filter("action=%20summary.read%20").action, "summary.read");
  assert.equal(filter("entityId=%20%20").entityId, undefined);
  assert.equal(filter(`entityId=${"x".repeat(500)}`).entityId?.length, 64);
  // An action nobody writes is passed through: it matches no rows, which is the honest answer.
  assert.equal(filter("action=nonsense.action").action, "nonsense.action");
});

// ---------------------------------------------------------------------------------------------
// Which parts of a bundle were read (§10.2).

const bundle = (over: Record<string, unknown> = {}) => ({
  status: { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 0 },
  patient: { notes: null },
  patientMessages: [] as string[],
  providerSummary: null,
  patientSummary: null,
  ...over,
});

test("a bundle with nothing in it is not a read of anything", () => {
  assert.deepEqual(visitPartsRead(bundle()), []);
});

test("each part is recorded only when the response really carried it", () => {
  assert.deepEqual(visitPartsRead(bundle({ status: { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 2 } })), ["intake"]);
  assert.deepEqual(visitPartsRead(bundle({ patient: { notes: "Ate late twice this week." } })), ["messages"]);
  assert.deepEqual(visitPartsRead(bundle({ patient: { notes: "   " } })), [], "blank notes are not a transcript");
  // T154: the provider is handed the chat rows as well as the notes, so either one is §10.2's read. This is
  // the ending that made the distinction matter — a flag on the first message fills no field, so the notes
  // are machine-written and the patient's sentence is the only thing of theirs on the brief.
  assert.deepEqual(
    visitPartsRead(bundle({ patientMessages: ["I had chest pain yesterday evening."] })),
    ["messages"],
    "the patient's own chat rows are a transcript read with no notes behind them",
  );
  assert.deepEqual(visitPartsRead(bundle({ patientMessages: ["  ", ""] })), [], "blank chat rows are not a transcript either");
  assert.deepEqual(visitPartsRead(bundle({ patientSummary: { timeInRange: 0.7 } })), ["summary"]);
  for (const source of ["hasDexcom", "hasLocation", "hasWhoop"]) {
    const status = { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 0, [source]: true };
    assert.deepEqual(visitPartsRead(bundle({ status })), ["uploads"], source);
  }
});

test("a visit a clinician reads during the appointment records all four", () => {
  const full = bundle({
    status: { hasDexcom: true, hasLocation: true, hasWhoop: true, answered: 4 },
    patient: { notes: "Ate out on Tuesday." },
    providerSummary: { timeInRange: 0.62 },
  });
  assert.deepEqual(visitPartsRead(full), [...VISIT_PARTS]);
});

// ---------------------------------------------------------------------------------------------
// The lede over the audit table (§10.2, §10.7, T219).
//
// The sentence claimed entries are never edited, over a store that moves a row's `at` forward and rewrites
// its `detail` for every repeated read, and claimed a row carries "only who, what, and when" over five
// columns. Both halves are now built from the two things that decide them — READ_COALESCE_MS and
// AUDIT_COLUMNS — and these are the tests that stop either drifting from the sentence again.

test("the window is put into words from the number itself", () => {
  assert.equal(coalesceWindowWords(60_000), "a minute");
  assert.equal(coalesceWindowWords(120_000), "2 minutes");
  assert.equal(coalesceWindowWords(600_000), "10 minutes");
  assert.equal(coalesceWindowWords(30_000), "30 seconds");
  assert.equal(coalesceWindowWords(90_000), "90 seconds");
  // Whatever the store is set to, that is the window the sentence names — never a minute written out by
  // hand beside a constant that has moved.
  if (READ_COALESCE_MS > 0) {
    assert.ok(
      auditCoalescingSentence(READ_COALESCE_MS).includes(coalesceWindowWords(READ_COALESCE_MS)),
      `the sentence names some window other than the ${READ_COALESCE_MS}ms the store coalesces by`,
    );
  }
});

test("the sentence follows the coalescing rule rather than describing one setting of it (T219 AC1)", () => {
  const on = auditCoalescingSentence(60_000);
  const off = auditCoalescingSentence(0);
  assert.notEqual(on, off);

  // Coalescing on, which is what lib/auditStore.ts does: a row already on the record is written to again,
  // and the time that survives is the last of the group. Neither of those may be denied.
  assert.match(on, /counted on the row already there/);
  assert.match(on, /latest of them/);
  assert.doesNotMatch(on, /never (edited|changed|removed)/, "the claim this ticket was filed about");

  // Coalescing off is the only setting under which the old sentence was true, and then the sentence says so
  // instead of describing a count nothing keeps.
  assert.match(off, /never changed once it is written/);
  assert.doesNotMatch(off, /counted|latest of them/, "counting described with coalescing off");
  // Negative and non-numeric windows are off, not on: `absorbed` is reached only for a positive one.
  for (const nothing of [0, -1, Number.NaN]) assert.equal(auditCoalescingSentence(nothing), off, String(nothing));

  // And this is the pairing the ticket is about: the sentence the page actually prints describes counting
  // exactly when the store actually counts. Setting READ_COALESCE_MS to 0 and leaving a sentence that still
  // described a running count would fail here, and so would today's store under the old claim.
  assert.equal(
    /counted on the row already there/.test(auditCoalescingSentence(READ_COALESCE_MS)),
    READ_COALESCE_MS > 0,
    "the page's sentence and the store's window disagree about whether a row is ever written twice",
  );

  // The distinction §10.2 rests on is kept rather than flattened into one claim about every row: a second
  // verification is a second session, and a second send is a second message.
  assert.match(on, /verifications, sends and deletions are each their own row/);
  assert.match(off, /Every event is its own row/);

  // T220: the two claims the store had no way of honouring until `firstAt`. The window is measured from the
  // first read on the row, and the span the row covers is bounded by it — so the sentence names the window
  // twice, once as the gate and once as the ceiling.
  assert.match(on, /within a minute of the first/);
  assert.match(on, /keeps the time it began/);
  assert.match(on, /no row stands for more than a minute/);
  // And it says so of whatever window the store is set to, never of a minute written out by hand.
  const half = auditCoalescingSentence(30_000);
  assert.match(half, /within 30 seconds of the first/);
  assert.match(half, /no row stands for more than 30 seconds/);
  assert.ok(!half.includes("minute"), half);
});

test("the lede enumerates the table's columns, in order, and stops there (T219 AC2)", () => {
  const sentence = auditRowSentence();
  // Walked in column order with a moving cursor rather than with `includes`, because "what" is a substring
  // of the `On` column's phrase: an enumeration that had lost a column could still contain every word of it.
  let cursor = 0;
  for (const column of AUDIT_COLUMNS) {
    assert.ok(column.carries.trim(), `the ${column.header} column says nothing about what it carries`);
    const at = sentence.indexOf(column.carries, cursor);
    assert.notEqual(at, -1, `the lede does not say what the ${column.header} column carries, in its turn`);
    cursor = at + column.carries.length;
  }
  // Nothing after the last column but the full stop, so a sentence that enumerated three of five would fail
  // here even if the three it named were the first three.
  assert.equal(sentence.slice(cursor), ".", "the enumeration runs past the last column");

  // A column the table gains is a column the sentence gains, which is the whole point of one list.
  const sixth = auditRowSentence([...AUDIT_COLUMNS, { carries: "the reason" }]);
  assert.ok(sixth.endsWith("and the reason."), sixth);
  assert.ok(!sentence.includes("the reason"));

  // §10.2's two columns the old sentence left out.
  for (const header of ["On", "Detail"] as const) {
    const column = AUDIT_COLUMNS.find((c) => c.header === header);
    assert.ok(column && sentence.includes(column.carries), `${header} is still unaccounted for`);
  }
  // And the half of the old sentence that was true, kept (§4.8).
  assert.match(sentence, /carries no patient details/);
  assert.doesNotMatch(sentence, /only who, what, and when/);
});

test("the whole lede is §10.2's scope, the row, and the rule", () => {
  const lede = auditLede(READ_COALESCE_MS);
  assert.ok(lede.startsWith(AUDIT_LEDE_SCOPE), lede);
  assert.ok(lede.includes(auditRowSentence()), lede);
  assert.ok(lede.includes(auditCoalescingSentence(READ_COALESCE_MS)), lede);
  // §10.2's four read categories, the verification, the send and the deletion: what produces a row at all.
  for (const event of ["read", "patient link accepted", "message sent", "deletion"]) {
    assert.ok(lede.includes(event), `${event} is not in the lede's scope`);
  }
  assert.match(lede, /Admins only/);
  // The default is the store's own window, so the page cannot be passed one and the store another.
  assert.equal(auditLede(), auditLede(READ_COALESCE_MS));
});

// ---------------------------------------------------------------------------------------------
// The span a coalesced row stands for (§10.2, §10.7, T220).
//
// Until `firstAt` the row had one time on it, the latest read absorbed into it, and the window the store
// looked back over was re-dated by every absorb — so the row covered a span of any length while the page
// called it a minute. The store's end of that is held in lib/auditStore.test.ts, against real rows and a
// real clock; these are the words the cell and the export print about it.

/** A stamp as the `When` cell prints it (app/provider/audit/audit.tsx, `when`). `toLocaleString()` has no
 *  sub-second field, so this is a function of `Math.floor(ms / 1000)` and of nothing else — which is what
 *  lets the assertions below subtract two printed stamps without parsing either of them. */
const printed = (ms: number) => new Date(ms).toLocaleString();

/** The reader's own arithmetic, done the only way it can be done locale-independently: if adding the stated
 *  number of seconds to the first printed stamp lands on the second printed stamp, then the two stamps the
 *  cell prints are exactly that many seconds apart. Both directions hold, because each stamp is a function
 *  of its instant's floor to the second and the local offset is the same on both. */
function printedStampsAgree(fromMs: number, toMs: number, seconds: number): boolean {
  return printed(fromMs + seconds * 1_000) === printed(toMs);
}

const iso = (s: string) => Date.parse(s);

test("a span is reported in units a person reads, and never as a zero", () => {
  // Taking both ends rather than a duration is the fix of T222 and not a signature tidy-up: a bare gap has no
  // correct wording, because the words are read between two stamps that are truncated to the second.
  const t = iso("2026-10-14T09:30:00.000Z");
  assert.equal(auditSpanWords(t, t), "under a second");
  assert.equal(auditSpanWords(t, t + 400), "under a second", "same second on both stamps, so no visible gap");
  // Backwards inside one printed second is no *visible* disorder: both ends print the same stamp, so there
  // is nothing for the words to contradict and "under a second" is exactly right (T222, `auditStampsOrdered`).
  assert.equal(auditSpanWords(t + 400, t + 100), "under a second", "one stamp printed twice, whatever order the instants came in");
  // Backwards across a boundary is visible, and then there is no honest wording of it at all. `t` is on the
  // second, so even 5ms back prints the *previous* second — this line used to assert "under a second" over
  // two stamps a second apart, which is the ticket's own bug in the test that was meant to pin the fix.
  assert.equal(auditSpanWords(t, t - 5), null, "9:29:59 under 9:30:00 is a second of visible disorder");
  assert.equal(auditSpanWords(t, t - 1_000), null, "two stamps a reader can put the wrong way round get no span words");
  assert.equal(auditSpanWords(t, t - 42_000), null, 'the reviewer\'s measured row: 42s backwards is not "under a second"');
  assert.equal(auditSpanWords(t, t + 1_000), "1 second");
  assert.equal(auditSpanWords(t, t + 1_400), "1 second");
  assert.equal(auditSpanWords(t, t + 42_000), "42 seconds");
  assert.equal(auditSpanWords(t, t + 60_000), "a minute");
  assert.equal(auditSpanWords(t, t + 90_000), "90 seconds");
  assert.equal(auditSpanWords(t, t + 120_000), "2 minutes");
  // What the old rounding did, now counted off the stamps instead: 59.6s is 59 whole seconds on the clock,
  // not the whole window. A claim of "a minute" needs the stamps to be a minute apart.
  assert.equal(auditSpanWords(t, t + 59_600), "59 seconds");
  assert.equal(auditSpanSeconds(t, t + 59_600), 59);
  assert.equal(auditSpanSeconds(t, t - 5), 0, "a backwards clock floors at zero here as it does in the row");
  assert.equal(auditSpanSeconds(Number.NaN, t), 0);
  assert.equal(auditSpanSeconds(t, Number.NaN), 0);
});

test("the span a cell states is the difference of the two stamps that cell prints (T222 AC1, AC2)", () => {
  // The four pairs the ticket measured, by their millisecond offsets inside the second. The first three
  // straddle a second boundary with a sub-second gap or a 1.3s one; the last is the 0.4s straddle that used
  // to print "under a second" over two stamps a second apart.
  const base = iso("2026-11-02T21:39:20.000Z");
  const pairs: [number, number, string][] = [
    [base + 800, base + 2_100, "2 seconds"], // real 1.3s, stamps :20 and :22 — once "1 second"
    [base + 900, base + 2_000, "2 seconds"], // real 1.1s, stamps :20 and :22 — once "1 second"
    [base + 0, base + 2_000, "2 seconds"], // real 2.0s, stamps :20 and :22 — always agreed
    [base + 600, base + 1_000, "1 second"], // real 0.4s, stamps :20 and :21 — once "under a second"
    [base + 100, base + 500, "under a second"], // real 0.4s, both stamps :20 — nothing visible to deny
  ];
  for (const [from, to, words] of pairs) {
    const seconds = auditSpanSeconds(from, to);
    assert.equal(auditSpanWords(from, to), words, `${printed(from)} to ${printed(to)}`);
    assert.ok(
      printedStampsAgree(from, to, seconds),
      `the cell would claim ${seconds}s over ${printed(from)} and ${printed(to)}, which are not that far apart`,
    );
    // AC2, the two readings a reader can catch in one glance, stated as their own assertions.
    if (seconds === 0) assert.equal(printed(from), printed(to), '"under a second" over two stamps that differ');
    else assert.notEqual(printed(from), printed(to), `${words} over one stamp printed twice`);
  }
});

test("no pair of instants makes the words and the printed stamps disagree (T222 AC1)", () => {
  // Every offset-within-the-second against every other, across gaps from nothing to past the window: the
  // isolation the old test had was that it never put the words next to the stamps, so this is the pairing
  // done exhaustively rather than on the cases that happened to be noticed.
  const base = iso("2026-11-02T21:39:20.000Z");
  const fractions = [0, 1, 100, 400, 499, 500, 501, 600, 800, 900, 999];
  // Backwards whole-second offsets are in the sweep too, which is the hole T222's first pass left: every
  // pair here used to run forwards, so the one direction where the words survived to contradict the stamps
  // was the one direction never swept.
  for (const wholeSeconds of [-42, -2, -1, 0, 1, 2, 3, 41, 59, 60]) {
    for (const from of fractions) {
      for (const to of fractions) {
        const a = base + from;
        const b = base + wholeSeconds * 1_000 + to;
        const seconds = auditSpanSeconds(a, b);
        const words = auditSpanWords(a, b);
        if (words === null) {
          // The only pairs without words are the ones whose stamps a reader can put the wrong way round.
          assert.equal(auditStampsOrdered(a, b), false, `no words for ${printed(a)} to ${printed(b)}, which are in order`);
          assert.notEqual(printed(a), printed(b), "a pair printing one stamp twice is in no visible disorder");
          continue;
        }
        assert.ok(auditStampsOrdered(a, b), `${words} over ${printed(a)} and ${printed(b)}, which print out of order`);
        assert.ok(
          printedStampsAgree(a, b, seconds),
          `${words} is not the gap between ${printed(a)} and ${printed(b)}`,
        );
        if (printed(a) === printed(b)) assert.equal(words, "under a second", `${words} over one stamp printed twice`);
        else assert.notEqual(words, "under a second", `"under a second" over ${printed(a)} and ${printed(b)}`);
        // The property that bites, which the assertion here used to miss by comparing the function with
        // itself: the wording is a function of the printed second count and of nothing else, so the same
        // count reached from two stamps on the second words identically.
        assert.equal(
          words,
          auditSpanWords(base, base + seconds * 1_000),
          `${printed(a)} to ${printed(b)} is ${seconds}s and should word as one`,
        );
      }
    }
  }
});

test("a row whose stamps print out of order states no span, and says so (T222 AC1, AC2)", () => {
  // The reviewer's measured row, and the reason this came back: `absorbed` in lib/auditStore.ts writes
  // `at: new Date()` on every absorb and never rewrites `firstAt`, so a clock that steps backwards between
  // the first write and an absorb persists a row with `at` before `firstAt`. The floor in `auditRowSpan`
  // turns that into a zero, and wording the zero printed "under a second" over two stamps 42 seconds apart.
  const at = "2026-10-14T09:29:18.000Z";
  const firstAt = "2026-10-14T09:30:00.000Z";
  const span = auditRowSpan(entry({ at, firstAt, detail: { count: 3 } }));
  assert.ok(span, "the row is still evidence of three reads");
  assert.equal(span.reads, 3);
  assert.equal(span.ms, 0, "a negative gap is not a span the record holds");
  assert.equal(span.seconds, 0);
  assert.equal(span.words, null, "and no words either: 42 seconds of visible disorder cannot be worded");
  // The stamps really are 42 seconds apart on screen, which is what the old wording denied.
  assert.notEqual(printed(iso(at)), printed(iso(firstAt)));
  assert.equal(auditStampsOrdered(iso(firstAt), iso(at)), false);

  // What the cell prints instead: the count, both stamps, and why there is no span.
  const clause = auditSpanClause(span, printed(iso(firstAt)));
  assert.match(clause.line, /^3 reads, the first stamped /, clause.line);
  assert.ok(clause.line.includes(printed(iso(firstAt))), "the first stamp stays on the screen");
  assert.ok(clause.line.includes("no span is shown"), clause.line);
  assert.ok(!/ over /.test(clause.line), `the clause still claims a span: ${clause.line}`);
  assert.ok(!clause.line.includes("under a second"), 'AC2 is absolute: no "under a second" over stamps that differ');
  assert.ok(!clause.title.includes("under a second"), clause.title);
  assert.ok(clause.title.includes("full precision"), "the title points at the export, which keeps the real figure");
});

test("an ordered row's clause is the sentence it always was (T222 AC3)", () => {
  // The decision only changes the out-of-order row; the ordinary coalesced row reads exactly as T220 left it.
  const firstAt = "2026-10-14T09:29:18.000Z";
  const span = auditRowSpan(entry({ at: "2026-10-14T09:30:00.000Z", firstAt, detail: { count: 3 } }));
  assert.ok(span);
  const stamp = printed(iso(firstAt));
  assert.deepEqual(auditSpanClause(span, stamp), {
    line: `3 reads over 42 seconds, from ${stamp}`,
    title: `3 identical reads, the first at ${stamp}`,
  });
});

test("a coalesced row's own words agree with the stamps the cell prints beside them (T222 AC1, AC5)", () => {
  // The same check one level up, through the function the page actually calls — the ticket's reproduction
  // case, which returned "1 second" over two stamps two seconds apart.
  const row = entry({ at: "2026-11-02T21:39:22.100Z", firstAt: "2026-11-02T21:39:20.800Z", detail: { count: 3 } });
  const span = auditRowSpan(row);
  assert.ok(span);
  assert.equal(span.ms, 1_300, "the record's own gap is kept at full precision");
  assert.equal(span.seconds, 2, "and the gap the cell can show is two seconds, because that is what it prints");
  assert.equal(span.words, "2 seconds");
  assert.ok(
    printedStampsAgree(iso(row.firstAt), iso(row.at), span.seconds),
    `${span.words} over ${printed(iso(row.firstAt))} and ${printed(iso(row.at))}`,
  );
  // The 0.4s straddle, which is the worse reading: the words denied a gap printed beside the denial.
  const straddle = auditRowSpan(entry({ at: "2026-11-02T21:39:21.000Z", firstAt: "2026-11-02T21:39:20.600Z", detail: { count: 2 } }));
  assert.ok(straddle);
  assert.equal(straddle.ms, 400);
  assert.equal(straddle.seconds, 1);
  assert.equal(straddle.words, "1 second");
  assert.notEqual(printed(iso("2026-11-02T21:39:20.600Z")), printed(iso("2026-11-02T21:39:21.000Z")));
});

test("a row that stands for one event at one moment reports no span", () => {
  const at = "2026-10-14T09:30:00.000Z";
  // The ordinary row: `firstAt` is `at`, nothing was coalesced, and an admin is shown one time and no
  // arithmetic about it.
  assert.equal(auditRowSpan(entry({ at, firstAt: at, detail: { part: "summary" } })), null);
  assert.equal(auditRowSpan(entry({ at, firstAt: at, detail: null })), null);
  assert.equal(auditRowSpan(entry({ at, firstAt: at, detail: { part: "summary", count: 1 } })), null);
  // Unparsable times are a hand-edited row (parseAuditDetail's reasoning): no claim rather than NaN.
  assert.equal(auditRowSpan(entry({ at: "not a time", firstAt: at })), null);
  assert.equal(auditRowSpan(entry({ at, firstAt: "not a time" })), null);
});

test("a coalesced row reports the span between its first read and its last (T220 AC1)", () => {
  const span = auditRowSpan(entry({ at: "2026-10-14T09:30:00.000Z", firstAt: "2026-10-14T09:29:18.000Z", detail: { part: "summary", count: 7 } }));
  assert.ok(span, "a row with two times and a count of 7 has a span");
  assert.equal(span.ms, 42_000);
  assert.equal(span.seconds, 42, "whole seconds, and on this pair the two agree because both stamps are on the second");
  assert.equal(span.words, "42 seconds");
  assert.equal(span.reads, 7, "how many reads the row stands for comes from its own count");
});

test("two reads inside one millisecond are a pair of reads, not a single one", () => {
  // The count is the only evidence of the second read, and the row has to carry it rather than round the
  // pair down to one event: `detail.count` is what an admin counts by.
  const at = "2026-10-14T09:30:00.000Z";
  const span = auditRowSpan(entry({ at, firstAt: at, detail: { count: 2 } }));
  assert.ok(span);
  assert.equal(span.ms, 0);
  assert.equal(span.seconds, 0);
  assert.equal(span.words, "under a second");
  assert.equal(span.reads, 2);
});

test("a count that is not a usable number falls back to one read, and a backwards clock to no span", () => {
  const at = "2026-10-14T09:30:00.000Z";
  const earlier = "2026-10-14T09:29:18.000Z";
  for (const count of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "4", null]) {
    const span = auditRowSpan(entry({ at, firstAt: earlier, detail: { count } }));
    assert.ok(span, `count ${String(count)} still has the 42s span between the two times`);
    assert.equal(span.ms, 42_000);
    assert.equal(span.reads, 1, `count ${String(count)} is not a whole number of reads above one`);
  }
  // `at` before `firstAt` can only be a clock that moved between two writes. The row still says how many —
  // and states no span, rather than wording the floored zero as "under a second" over two stamps 42 seconds
  // apart, which is what this assertion pinned as correct until T222's second pass (see the dedicated case
  // above for the whole reading).
  const backwards = auditRowSpan(entry({ at: earlier, firstAt: at, detail: { count: 3 } }));
  assert.ok(backwards);
  assert.equal(backwards.ms, 0);
  assert.equal(backwards.seconds, 0, "and no negative count of seconds either");
  assert.equal(backwards.words, null);
  assert.equal(backwards.reads, 3);
});

test("the export carries the span as a field of its own (T220 AC6)", () => {
  // §10.2 says "exportable", and an export that dropped `firstAt` would be a weaker record than the screen
  // it was taken from — which is the whole of this ticket, one step downstream.
  assert.ok(AUDIT_CSV_HEADER.includes("firstAt"), AUDIT_CSV_HEADER.join(","));
  assert.equal([...AUDIT_CSV_HEADER].indexOf("firstAt"), [...AUDIT_CSV_HEADER].indexOf("at") + 1, "the two ends of the span are next to each other");
  const line = auditCsv([entry({ at: "2026-10-14T09:30:00.000Z", firstAt: "2026-10-14T09:29:18.000Z" })]).split("\r\n")[1];
  assert.ok(line.startsWith("2026-10-14T09:30:00.000Z,2026-10-14T09:29:18.000Z,"), line);
});

test("the audit page prints the span from this module rather than deciding it (T220 AC3)", () => {
  const page = readFileSync(path.join(import.meta.dirname, "..", "app", "provider", "audit", "audit.tsx"), "utf8");
  // The words and the "is there a span at all" decision are `auditRowSpan`'s, so the bound the sentence
  // over the table promises and the span the cell prints come from one place.
  assert.match(page, /auditRowSpan\(entry\)/);
  assert.ok(!/firstAt\)\.getTime\(\)|Date\.parse\(entry\.firstAt/.test(page), "the page is doing the arithmetic itself");
  // And the sentence as well as the span (T222 AC3): which clause a record deserves is this module's
  // decision, so the page may not assemble one of its own around the words.
  assert.match(page, /auditSpanClause\(span, when\(entry\.firstAt\)\)/);
  assert.ok(!/reads over/.test(page), "the page is wording the span line itself");
  // And no sixth column was added to carry it: the span rides in `When`, which the column list already has.
  assert.equal(AUDIT_COLUMNS.length, 5);
});

test("the audit page takes both the sentence and its columns from this module (T219 AC3)", () => {
  const page = readFileSync(path.join(import.meta.dirname, "..", "app", "provider", "audit", "audit.tsx"), "utf8");
  // No header written into the JSX: every `<th>` and every `data-label` is the column list, so a sixth
  // column cannot reach the table without the sentence above it enumerating it. This is the test that would
  // have caught the ticket — five columns under three nouns, with nothing in lib/ to ask.
  assert.doesNotMatch(page, /<th[^>]*>\s*[A-Za-z]/, "a <th> whose text is written into the JSX");
  assert.doesNotMatch(page, /data-label="/, 'a data-label whose text is written into the JSX');
  assert.match(page, /AUDIT_COLUMNS\.map/);
  assert.match(page, /auditLede\(READ_COALESCE_MS\)/);
  // And neither claim is a literal any more.
  for (const gone of ["never edited", "never be edited", "only who, what, and when"]) {
    assert.ok(!page.includes(gone), `the page still says "${gone}"`);
  }
});
