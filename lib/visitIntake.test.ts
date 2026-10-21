import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import {
  channelLabel,
  channelOf,
  channelsOf,
  cleanPatientName,
  cleanReason,
  CSV_TEMPLATE,
  MAX_CSV_ROWS,
  MAX_REASON,
  normalizePhone,
  parseScheduledAt,
  parseVisitCsv,
  parseVisitDraft,
  parseVisitType,
  splitCsvLine,
  warningsFor,
} from "./visitIntake";

// design §2.2: the rules the Add-visit form and the CSV import share. Pure, so no database here.
// The fixture's own timestamps carry no offset, like a scheduler's export, so the zone is pinned first.
pinUtcTimeZone();

const good = { name: "Sam Taylor", phone: "+14155550100", email: "sam@example.com", visitType: "follow_up", channel: "both", consentMethod: "phone" };

test("a complete visit passes and comes back normalised", () => {
  const parsed = parseVisitDraft({ ...good, phone: "(415) 555-0100", email: " SAM@Example.com ", reason: "  mornings   running high ", scheduledAt: "2026-10-15 09:30" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.draft, {
    name: "Sam Taylor",
    // No `+`: a bare national number is stored as typed rather than guessed into a country (normalizePhone).
    phone: "4155550100",
    email: "sam@example.com",
    scheduledAt: new Date("2026-10-15T09:30:00Z").toISOString(),
    visitType: "follow_up",
    reason: "mornings running high",
    channel: "both",
    consentMethod: "phone",
    consentAt: null,
  });
});

test("a visit needs a name", () => {
  const parsed = parseVisitDraft({ ...good, name: "   " });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.errors[0], /name is required/i);
});

test("a date and a visit type are optional, an unreadable one is not", () => {
  const blank = parseVisitDraft({ ...good, scheduledAt: "", visitType: "" });
  assert.equal(blank.ok, true);
  if (blank.ok) assert.deepEqual([blank.draft.scheduledAt, blank.draft.visitType], [null, null]);

  const junk = parseVisitDraft({ ...good, scheduledAt: "next tuesday" });
  assert.equal(junk.ok, false);
  if (!junk.ok) assert.match(junk.errors.join(" "), /date and time could not be read/i);

  const unknownType = parseVisitDraft({ ...good, visitType: "screening" });
  assert.equal(unknownType.ok, false);
  if (!unknownType.ok) assert.match(unknownType.errors.join(" "), /Visit type must be one of/);
});

test("a visit type is accepted by id or by the label a scheduler exports", () => {
  assert.equal(parseVisitType("follow_up"), "follow_up");
  assert.equal(parseVisitType("Follow-up"), "follow_up");
  assert.equal(parseVisitType("MEDICATION"), "medication");
  assert.equal(parseVisitType("After a hospital or ER visit"), "post_hospital");
  assert.equal(parseVisitType(""), null);
  assert.equal(parseVisitType("screening"), undefined);
});

// §2.2's consent, which is the rule that makes this more than field cleaning: a channel that will be messaged
// needs a recorded consent *and* something to reach the patient on.
test("a channel that will be messaged needs a consent and a way to reach the patient", () => {
  const noConsent = parseVisitDraft({ ...good, consentMethod: "" });
  assert.equal(noConsent.ok, false);
  if (!noConsent.ok) assert.match(noConsent.errors.join(" "), /Record how the patient's consent/i);

  const noPhone = parseVisitDraft({ ...good, phone: "", channel: "sms" });
  assert.equal(noPhone.ok, false);
  if (!noPhone.ok) assert.match(noPhone.errors.join(" "), /text message needs a mobile number/i);

  const noEmail = parseVisitDraft({ ...good, email: "", channel: "email" });
  assert.equal(noEmail.ok, false);
  if (!noEmail.ok) assert.match(noEmail.errors.join(" "), /emailed invite needs an email address/i);

  // "both" wants both, which is the case a form with only a phone number falls into.
  const onlyPhone = parseVisitDraft({ ...good, email: "" });
  assert.equal(onlyPhone.ok, false);
});

test("a visit nobody will message needs no consent and no contact details at all", () => {
  const parsed = parseVisitDraft({ name: "Walk In", channel: "none" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual([parsed.draft.channel, parsed.draft.consentMethod, parsed.draft.phone], ["none", null, null]);
});

test("an unrecognised channel or consent method is refused rather than defaulted", () => {
  const badChannel = parseVisitDraft({ ...good, channel: "carrier pigeon" });
  assert.equal(badChannel.ok, false);
  if (!badChannel.ok) assert.match(badChannel.errors.join(" "), /Contact channel must be one of/);

  const badConsent = parseVisitDraft({ ...good, consentMethod: "they seemed fine with it" });
  assert.equal(badConsent.ok, false);
  if (!badConsent.ok) assert.match(badConsent.errors.join(" "), /Consent must be recorded as one of/);

  // A missing channel is the one default: the form's own, and what every pre-T07 row behaved as.
  const noChannel = parseVisitDraft({ ...good, channel: undefined });
  assert.equal(noChannel.ok, true);
  if (noChannel.ok) assert.equal(noChannel.draft.channel, "both");
});

test("consent can be backdated to when it was actually taken", () => {
  const parsed = parseVisitDraft({ ...good, consentAt: "2026-10-13 16:05" });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.draft.consentAt, new Date("2026-10-13T16:05:00Z").toISOString());
});

test("a phone number is stored as digits, and nonsense is not a phone number", () => {
  assert.equal(normalizePhone("(415) 555-0100"), "4155550100"); // no country is guessed in front of it
  assert.equal(normalizePhone("+1 415-555-0100"), "+14155550100");
  assert.equal(normalizePhone("not-a-number"), null);
  assert.equal(normalizePhone("12345"), null); // too short to be anyone's number
  assert.equal(normalizePhone("1".repeat(16)), null); // longer than E.164 allows
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(undefined), null);
});

test("names and reasons are collapsed and capped", () => {
  assert.equal(cleanPatientName("  Sam   Taylor \n"), "Sam Taylor");
  assert.equal(cleanPatientName(""), null);
  assert.equal(cleanPatientName(42), null);
  assert.equal(cleanReason("x".repeat(MAX_REASON + 50))?.length, MAX_REASON);
  assert.equal(cleanReason("   "), null);
});

test("an ISO date and a scheduler's space-separated one read the same", () => {
  assert.equal(parseScheduledAt("2026-10-15T09:30:00Z"), "2026-10-15T09:30:00.000Z");
  assert.equal(parseScheduledAt("2026-10-15 09:30"), "2026-10-15T09:30:00.000Z");
  assert.equal(parseScheduledAt(null), null);
  assert.equal(parseScheduledAt("rubbish"), undefined);
  assert.equal(parseScheduledAt(42), undefined);
});

test("a channel says which senders run", () => {
  assert.deepEqual(channelsOf("both"), ["sms", "email"]);
  assert.deepEqual(channelsOf("sms"), ["sms"]);
  assert.deepEqual(channelsOf("email"), ["email"]);
  assert.deepEqual(channelsOf("none"), []);
  // A visit created before T07 has no channel and behaved as "both", so that is what null reads as.
  assert.deepEqual(channelsOf(null), ["sms", "email"]);
});

test("a CSV line keeps a quoted comma together", () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ["a", "b", "c"]);
  assert.deepEqual(splitCsvLine('Sam,"new dose, feels shaky",both'), ["Sam", "new dose, feels shaky", "both"]);
  assert.deepEqual(splitCsvLine('"she said ""fine""",x'), ['she said "fine"', "x"]);
  assert.deepEqual(splitCsvLine("a,,c"), ["a", "", "c"]);
});

// §2.2's "preview and per-row errors": the fixture is a scheduler's day with one problem per bad row, and the
// point of the assertions is that each row fails on its own and the good rows still come through.
test("a day of visits parses row by row, each bad row with its own reason", () => {
  const parse = parseVisitCsv(fixture("visit_import.csv"));
  assert.equal(parse.error, undefined);
  assert.equal(parse.rows.length, 9);

  const ok = parse.rows.filter((r) => r.draft);
  assert.deepEqual(
    ok.map((r) => r.name),
    ["Sam Taylor", "Ada Rivera", "Lee Okonkwo"],
  );
  // The header aliases did their job: "Mobile", "Appointment", "Type" and "Called about" all landed.
  assert.deepEqual(ok[0].draft, {
    name: "Sam Taylor",
    phone: "4155550100",
    email: "sam@example.com",
    scheduledAt: new Date("2026-10-15T09:30:00Z").toISOString(),
    visitType: "follow_up",
    reason: "mornings running high",
    channel: "both",
    consentMethod: "phone",
    consentAt: new Date("2026-10-13T16:05:00Z").toISOString(),
  });
  // A quoted comma inside the reason stays one cell rather than shifting every column after it.
  assert.equal(ok[1].draft?.reason, "new dose, feels shaky");
  // Every importable row in the fixture has a number or an address, so none of them warns (§5.3).
  assert.deepEqual(ok.flatMap((r) => r.warnings), []);

  const reasons = Object.fromEntries(parse.rows.filter((r) => !r.draft).map((r) => [r.line, r.errors.join(" | ")]));
  assert.match(reasons[5], /name is required/i);
  assert.match(reasons[6], /not look like a phone number/i);
  assert.match(reasons[7], /Visit type must be one of/);
  assert.match(reasons[8], /date and time could not be read/i);
  assert.match(reasons[9], /Record how the patient's consent/i);
  assert.match(reasons[10], /mobile number/i);
  assert.equal(Object.keys(reasons).length, 6);
});

// T08 (§5.3): opening the link sends a code to the phone or email on file, so a visit with neither cannot be
// opened at all. §2.2 still lets staff create one — the number often arrives after the appointment does — so
// this is a warning the screens show, never a refusal.
test("a visit with nothing on file is created, and says what that costs the patient", () => {
  const parsed = parseVisitDraft({ name: "Walk In", channel: "none" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(warningsFor(parsed.draft), ["No phone or email on file, so this patient cannot open their link: opening it sends them a six-digit code."]);

  // Either one is enough, and "do not message" with an address on file is the deliberate combination: the
  // channel governs the invite, the address is what the code goes to.
  assert.deepEqual(warningsFor({ phone: null, email: "sam@example.com" }), []);
  assert.deepEqual(warningsFor({ phone: "4155550100", email: null }), []);
});

test("a CSV row with no way to reach the patient imports with that warning on it", () => {
  const parse = parseVisitCsv("name,phone,channel\nNo Contact,,none\nReachable,+14155550100,none\n");
  assert.deepEqual(parse.rows.map((r) => r.errors.length), [0, 0]);
  assert.match(parse.rows[0].warnings[0], /cannot open their link/);
  assert.deepEqual(parse.rows[1].warnings, []);
});

test("the columns a file did not map are named rather than silently dropped", () => {
  const parse = parseVisitCsv("Patient Name,Mobile,Clinic Room,MRN\nSam Taylor,+14155550100,3,MRN-1\n");
  assert.deepEqual(parse.columns, ["name", "phone"]);
  assert.deepEqual(parse.ignored, ["Clinic Room", "MRN"]);
  // No channel column and no consent column: the row imports and nothing is sent. A scheduler's export is
  // not consent, so "both" — the form's default — is deliberately not what a silent file means (§2.2).
  assert.equal(parse.rows[0].errors.length, 0);
  assert.equal(parse.rows[0].draft?.channel, "none");
});

test("a row with the wrong number of cells says so before anything else", () => {
  const parse = parseVisitCsv("name,phone,channel\nSam Taylor,+14155550100\n");
  assert.match(parse.rows[0].errors[0], /2 cells and the header has 3/);
});

test("a file that is not an import is refused whole, with the header it wanted", () => {
  assert.match(parseVisitCsv("").error ?? "", /empty/i);
  assert.match(parseVisitCsv("\n  \n").error ?? "", /empty/i);
  assert.match(parseVisitCsv("name,phone\n").error ?? "", /header and no visits/i);
  assert.match(parseVisitCsv("mrn,room\n1,2\n").error ?? "", /No patient name column/);
});

test("blank lines between days are skipped, not reported", () => {
  const parse = parseVisitCsv("name,channel\nSam Taylor,none\n\nAda Rivera,none\n\n");
  assert.equal(parse.rows.length, 2);
  // Lines are counted in the file, so an error names the line the person is looking at.
  assert.deepEqual(parse.rows.map((r) => r.line), [2, 4]);
});

test("a file bigger than a day is cut off with a reason, keeping what it read", () => {
  const rows = Array.from({ length: MAX_CSV_ROWS + 5 }, (_, i) => `Patient ${i},none`).join("\n");
  const parse = parseVisitCsv(`name,channel\n${rows}\n`);
  assert.equal(parse.rows.length, MAX_CSV_ROWS);
  assert.match(parse.error ?? "", /more than 500 rows/);
});

test("the example offered on screen is a file this parser accepts", () => {
  const parse = parseVisitCsv(CSV_TEMPLATE);
  assert.equal(parse.error, undefined);
  assert.equal(parse.rows.length, 2);
  assert.deepEqual(parse.rows.filter((r) => r.errors.length), []);
});

// T111 `channelOf` is `channelsOf` backwards, so a *subset* of the two has a label: what staff chose and
// what the deployment can send on are different questions (lib/notify.ts `inviteSendability`).
test("channelOf names the channel a set of the two amounts to", () => {
  assert.equal(channelOf(["sms", "email"]), "both");
  assert.equal(channelOf(["email", "sms"]), "both", "order is not part of the answer");
  assert.equal(channelOf(["sms"]), "sms");
  assert.equal(channelOf(["email"]), "email");
  assert.equal(channelOf([]), "none");
});

test("channelOf and channelsOf round-trip every channel that sends", () => {
  for (const channel of ["both", "sms", "email", "none"] as const) {
    assert.equal(channelOf(channelsOf(channel)), channel);
  }
  // And each answer is a label staff can read, which is the only reason this function exists.
  assert.equal(channelLabel(channelOf(["email"])), "Email");
  assert.equal(channelLabel(channelOf(["sms", "email"])), "Text and email");
});
