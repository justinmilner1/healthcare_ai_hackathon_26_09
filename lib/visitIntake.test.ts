import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import {
  channelLabel,
  channelNeeds,
  channelOf,
  channelsOf,
  cleanPatientName,
  cleanReason,
  CSV_TEMPLATE,
  csvRowWarnings,
  MAX_CSV_ROWS,
  MAX_REASON,
  normalizePhone,
  parseScheduledAt,
  parseVisitCsv,
  parseVisitDraft,
  parseVisitType,
  splitCsvLine,
  warningsFor,
  type VisitDraft,
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
test("a channel that will be messaged needs a recorded consent", () => {
  const noConsent = parseVisitDraft({ ...good, consentMethod: "" });
  assert.equal(noConsent.ok, false);
  if (!noConsent.ok) assert.match(noConsent.errors.join(" "), /Record how the patient's consent/i);
});

// T177 (design §2.2, §2.3, §5.3, §8.1) And what it no longer needs: a destination on the channel staff
// picked. From T07 until this ticket a booking on "Text and email" with neither field filled — the
// combination the wizard *opens* on — answered 400 with "A text message needs a mobile number." over a step
// that had just said "Nothing is sent", and the only way through was "Do not message" three cards up the
// list, which nothing on the screen pointed at (T168). The step was right; the refusal was about a send the
// step had already stopped promising.
//
// So the channel narrows to nothing, which is what the stored visit has always done — `invitableChannels`
// sends by what there is a destination for (lib/visitStore.ts) and `inviteReach` names the gap in staff's
// words on the card and on the dashboard row (lib/notify.ts). The sentence itself is not gone: step 3's
// forecast reads it from `channelNeeds` before the press (`bookingPlan`, lib/booking.ts).
test("a sending channel with nothing to send to is taken, and narrows to nothing", () => {
  for (const [channel, to] of [
    ["sms", { phone: "", email: "sam@example.com" }],
    ["email", { phone: "+14155550123", email: "" }],
    ["both", { phone: "", email: "" }],
    ["both", { phone: "", email: "sam@example.com" }],
  ] as const) {
    const parsed = parseVisitDraft({ ...good, ...to, channel });
    assert.equal(parsed.ok, true, `${channel} ${JSON.stringify(to)}`);
    if (!parsed.ok) continue;
    // The channel staff chose is what is stored: §8.3's delivery rows are written against it, and the
    // narrowing is the sender's job rather than the parser's.
    assert.equal(parsed.draft.channel, channel);
    assert.equal(parsed.draft.phone, to.phone || null);
    assert.equal(parsed.draft.email, to.email || null);
  }

  // What the visit is created *with* is the whole of the change: the consent rule above is untouched, so a
  // booking on a sending channel with no destination and no recorded consent is still refused, and for the
  // reason that is about the practice rather than about a field on the patient.
  const noConsent = parseVisitDraft({ ...good, phone: "", email: "", consentMethod: "" });
  assert.equal(noConsent.ok, false);
  if (!noConsent.ok) {
    assert.deepEqual(noConsent.errors, ["Record how the patient's consent to be contacted was taken before sending anything."]);
  }
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
  assert.equal(parse.rows.length, 10);

  const ok = parse.rows.filter((r) => r.draft);
  // T177 Yuki Sato joined this list: the last row of the fixture chose "both" with neither cell filled, and
  // the parser refused it until §2.2 started taking a booking on a channel with nothing to send to. The
  // appointment is real either way, so the row is created and the warning below is what it carries.
  // T181 And Mina Okafor is the shape the import had nothing to say about: a number on file and the *other*
  // channel chosen. `warningsFor` is silent on it — there is something on file — and until this ticket the
  // preview was too, so the row was created and the first anyone heard of the gap was the dashboard's
  // delivery cell (§8.3).
  assert.deepEqual(
    ok.map((r) => r.name),
    ["Sam Taylor", "Ada Rivera", "Lee Okonkwo", "Yuki Sato", "Mina Okafor"],
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
  // T177 Every importable row but the last has a number or an address, so only that one warns (§5.3) — and
  // it warns rather than falling silent, which is the half of the old refusal that is still owed to staff:
  // `warningsFor` names the gap and the remedy, and the preview prints it beside the row (lib/visitIntake.ts,
  // app/provider/dashboard.tsx).
  assert.deepEqual(
    ok.map((r) => [r.name, r.warnings.length]),
    [["Sam Taylor", 0], ["Ada Rivera", 0], ["Lee Okonkwo", 0], ["Yuki Sato", 1], ["Mina Okafor", 1]],
  );
  assert.match(ok[3].warnings[0], /^No phone or email on file, /);
  // T181 One line, and it is the wizard's forecast's own clause rather than a second wording of one missing
  // field (`channelNeeds`, lib/visitIntake.ts, read by `bookingPlan` in lib/booking.ts).
  assert.deepEqual(ok[4].warnings, [channelNeeds("email")]);

  const reasons = Object.fromEntries(parse.rows.filter((r) => !r.draft).map((r) => [r.line, r.errors.join(" | ")]));
  assert.match(reasons[5], /name is required/i);
  assert.match(reasons[6], /not look like a phone number/i);
  assert.match(reasons[7], /Visit type must be one of/);
  assert.match(reasons[8], /date and time could not be read/i);
  assert.match(reasons[9], /Record how the patient's consent/i);
  assert.equal(Object.keys(reasons).length, 5, "line 10 is a warning rather than an error since T177, and line 11 since T181");
});

// T08 (§5.3): opening the link sends a code to the phone or email on file, so a visit with neither cannot be
// opened at all. §2.2 still lets staff create one — the number often arrives after the appointment does — so
// this is a warning the screens show, never a refusal.
test("a visit with nothing on file is created, and says what that costs the patient", () => {
  const parsed = parseVisitDraft({ name: "Walk In", channel: "none" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(warningsFor(parsed.draft), [
    "No phone or email on file, so the six-digit code their link needs has nowhere to go and the link will not open. " +
      "Add a phone number or an email address, or take the intake over the telephone.",
  ]);

  // Either one is enough, and "do not message" with an address on file is the deliberate combination: the
  // channel governs the invite, the address is what the code goes to.
  assert.deepEqual(warningsFor({ phone: null, email: "sam@example.com" }), []);
  assert.deepEqual(warningsFor({ phone: "4155550100", email: null }), []);
});

// T168, and the reason the literal above is not the whole test.
//
// The sentence it replaces denied the send and then claimed it one clause later — "this patient cannot open
// their link: opening it sends them a six-digit code" — so the rule worth keeping is not this wording but
// what no wording of it may say. Stated the way lib/teamInvite.ts states `claimsEmail` and lib/inviteNote.ts
// its `MOTION`: one invariant over every line the module can hand a screen, so the next rewording is held to
// it without anyone remembering this ticket.
//
// Deliberately not a bare /code/ — the warning has to name the six-digit code to explain itself, and "has
// nowhere to go" is the denial. What is forbidden is the code in motion towards this patient.
const CODE_IN_MOTION = /sends? (?:them|you|the patient)|(?:we|it)(?:'| wi)ll (?:text|email|send)|code (?:is|will be|was) sent|code (?:is )?on (?:its|the) way/i;

/** Every draft the two §2.2 surfaces can ask about: the wizard's fields and a CSV row both come down to
 *  these four, and the rule below is about all of them rather than about the one that warns today. */
const CONTACT_COMBINATIONS: Pick<VisitDraft, "phone" | "email">[] = [
  { phone: null, email: null },
  { phone: "4155550100", email: null },
  { phone: null, email: "sam@example.com" },
  { phone: "4155550100", email: "sam@example.com" },
];

test("no warning claims a code reaches a patient there is nowhere to send one to", () => {
  for (const draft of CONTACT_COMBINATIONS) {
    for (const warning of warningsFor(draft)) {
      assert.doesNotMatch(warning, CODE_IN_MOTION, `a send this visit cannot make, in: ${warning}`);
    }
  }

  // And the half that was missing: §2.2's gap has no other screen, so the one line that names it names the
  // way out of it too — the two fields staff own, and the telephone.
  const [warning] = warningsFor({ phone: null, email: null });
  assert.match(warning, /add a phone number or an email address/i);
  assert.match(warning, /telephone/i);
  // §3.7, §10.6: staff's words, nothing of the deployment's on a practice's screen.
  assert.doesNotMatch(warning, /SES|SNS|TWILIO|RESEND|_API_KEY|EMAIL_FROM|DEV_MAIL_DIR/);
});

test("a CSV row with no way to reach the patient imports with that warning on it", () => {
  const parse = parseVisitCsv("name,phone,channel\nNo Contact,,none\nReachable,+14155550100,none\n");
  assert.deepEqual(parse.rows.map((r) => r.errors.length), [0, 0]);
  assert.match(parse.rows[0].warnings[0], /the link will not open/);
  assert.deepEqual(parse.rows[1].warnings, []);
});

// T181 (§2.2, §2.3, §5.3). The import preview's own line, and the whole of the rule in one test: the shape
// that was silent now speaks, the shape that already spoke keeps exactly what it had, and the reachable
// shapes stay clean — all three together, because a preview that warned about everything would meet the
// first of those and say nothing.
//
// The sentence is checked against `channelNeeds` rather than against a literal, which is the point of the
// ticket: the wizard's forecast reads the same clause (`bookingPlan`, lib/booking.ts), so one missing field
// cannot come to be worded two ways across §2.2's two ways of creating a visit.
test("a CSV row whose chosen channel has nowhere to send says so, and no other row grows a line", () => {
  const rows = (csv: string) => parseVisitCsv(`name,phone,email,channel,consent\n${csv}`).rows;

  // The shape the ticket was filed for: a number on file, the email channel chosen. `warningsFor` is silent
  // on it — there *is* something on file — and that silence is what sent staff to the dashboard to find out.
  const [emailed] = rows("Mina Okafor,+14155550107,,email,phone\n");
  assert.deepEqual(emailed.errors, []);
  assert.deepEqual(emailed.warnings, [channelNeeds("email")]);
  assert.deepEqual(warningsFor(emailed.draft!), [], "`warningsFor` is not what grew this line (criterion 3)");

  // And the mirror of it, so the clause follows the channel rather than being one sentence about email.
  const [texted] = rows("Ravi Menon,,ravi@example.com,sms,phone\n");
  assert.deepEqual(texted.warnings, [channelNeeds("sms")]);

  // Neither field, "Text and email": `warningsFor`'s line and nothing under it. The link does not open at
  // all, which is the larger fact and is already named with its remedy; a second sentence about the same
  // empty cell is the T170 split this ticket is written to avoid.
  const [nobody] = rows("Yuki Sato,,,both,phone\n");
  assert.equal(nobody.warnings.length, 1);
  assert.match(nobody.warnings[0], /^No phone or email on file, /);

  // Every reachable shape, which is the half that keeps the rule honest. "Text and email" with one field
  // filled is reachable on that one, and a blank `channel` column — what a scheduler's export means — asks
  // for no send at all, so neither has anything to be told.
  for (const row of rows(
    [
      "Sam Taylor,+14155550100,sam@example.com,both,phone",
      "Ada Rivera,+14155550101,,sms,phone",
      "Lee Okonkwo,,lee@example.com,email,portal",
      "Nia Bako,+14155550108,,both,phone",
      "Tom Berg,,tom@example.com,both,phone",
      "Walk In,+14155550109,,,",
      "Quiet Row,,quiet@example.com,none,",
    ].join("\n") + "\n",
  )) {
    assert.deepEqual(row.errors, [], `${row.name} should import`);
    assert.deepEqual(row.warnings, [], `${row.name} is reachable and has nothing to be told`);
  }

  // §3.7, §10.6: staff's words. The missing cell is the front desk's own, and the deployment's senders are
  // the tally line's subject, not this one's (lib/importNote.ts).
  assert.doesNotMatch(emailed.warnings[0], /SES|SNS|TWILIO|RESEND|_API_KEY|EMAIL_FROM|DEV_MAIL_DIR/);
  // And nothing here claims the send it has just said has nowhere to go (T168's invariant, above).
  for (const draft of CONTACT_COMBINATIONS) {
    for (const channel of ["sms", "email", "both", "none"] as const) {
      for (const warning of csvRowWarnings({ ...draft, channel })) {
        assert.doesNotMatch(warning, CODE_IN_MOTION, `a send this visit cannot make, in: ${warning}`);
      }
    }
  }
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
