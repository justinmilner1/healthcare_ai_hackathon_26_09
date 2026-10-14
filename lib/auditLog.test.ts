import assert from "node:assert/strict";
import test from "node:test";
import {
  actionLabel,
  auditCsv,
  auditCsvFilename,
  auditDetail,
  auditDetailJson,
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_CSV_HEADER,
  AUDIT_DETAIL_FIELDS,
  AUDIT_LIMITS,
  DEFAULT_AUDIT_LIMIT,
  parseAuditDetail,
  parseAuditFilter,
  readAction,
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
  for (const action of ["patient.verified", "invite.sent", "code.sent", "summary.sent", "upload.deleted", "summary.deleted"]) {
    assert.ok(AUDIT_ACTION_NAMES.includes(action as never), `${action} is missing`);
  }
});

test("an action from a newer build is shown as stored rather than blank", () => {
  assert.equal(actionLabel("retention.swept"), "retention.swept");
  assert.equal(actionLabel("summary.read"), AUDIT_ACTIONS["summary.read"]);
});

// ---------------------------------------------------------------------------------------------
// §4.8: "detail JSON without PHI".

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
  assert.match(lines[1], /^2026-10-14T09:30:00\.000Z,Dr\. Demo Endo,user,/);
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
