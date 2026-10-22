import assert from "node:assert/strict";
import test from "node:test";
import {
  codeChannels,
  codeReach,
  codeTemplates,
  deletionTemplates,
  inviteSendability,
  inviteTemplates,
  sendDeletionConfirmation,
  sendIntakeInvite,
  sendSummaryEmails,
  summaryTemplates,
} from "./notify";
import type { Summary } from "./types";

process.env.APP_URL = "https://sweetspot.example/";
process.env.TZ = "UTC";
// No sender, on purpose: the tests below that call a send are about which channels are *attempted*, and an
// environment carrying any sender's settings would otherwise have lib/sms.ts and lib/email.ts reach for a
// backend and report the network's opinion instead. Each backend is selected by the setting it cannot send
// without, so the list is those: SNS_ORIGINATION_NUMBER since T94, EMAIL_FROM since T110. The AWS
// credentials are still cleared — this repo's own cloud sandbox has them ambient — because a client built
// on one is what the two tickets were about, even though neither selects a backend any more.
for (const name of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "SMS_PROVIDER",
  "SNS_ORIGINATION_NUMBER",
  // And the mailbox, which `scripts/agent-check.sh` exports for the whole run: it is a place a verification
  // code can really be read from, so `codeChannels` below counts it (T113) and every case here has to say
  // for itself whether it is there.
  "DEV_MAIL_DIR",
]) {
  delete process.env[name];
}

const APPT = new Date("2026-09-24T16:30:00Z");

/** Design §8.2: no clinical content in any message. This is the shape of what must never appear. */
const summary: Summary = {
  timeInRange: 0.76,
  avgGlucose: 117,
  spikes: [{ start: "2026-09-19T07:00:00Z", peak: "2026-09-19T08:00:00Z", from: 96, to: 214 }],
  patterns: ["Three of four overnight highs followed dinners out after 8pm."],
  questions: ["What changed about breakfast in August?"],
  patientNotes: "Tired in the afternoons, shaky some mornings.",
  flags: ["Glucose below 54 mg/dL on 1 day."],
};

const clinicalStrings = [
  String(summary.avgGlucose),
  "214",
  "76",
  "mg/dL",
  "glucose",
  ...summary.patterns,
  ...summary.questions,
  summary.patientNotes,
  ...(summary.flags ?? []),
];

function assertNoClinicalContent(label: string, text: string) {
  for (const bad of clinicalStrings) {
    assert.equal(text.toLowerCase().includes(bad.toLowerCase()), false, `${label} must not mention ${JSON.stringify(bad)}`);
  }
}

test("the invite names the practice, the patient and the date, and carries the link", () => {
  const t = inviteTemplates({ name: "Sam Sample", token: "tok_abc123", providerName: "Dr. Ada Bell", apptAt: APPT });
  assert.equal(t.link, "https://sweetspot.example/s/tok_abc123");
  assert.match(t.sms, /^Dr\. Ada Bell's office: hi Sam,/);
  assert.ok(t.sms.includes(t.link));
  assert.equal(t.sms.includes("Sample"), false, "only the first name goes out");
  assert.equal(t.email.subject, "Get ready for your visit with Dr. Ada Bell");
  assert.match(t.email.text, /^Hi Sam,\n/);
  assert.ok(t.email.text.includes(t.link));
  assert.match(t.email.text, / on Thursday, Sep 24[,.]? /);
  assert.match(t.email.text, /Dr\. Ada Bell's office$/);
});

test("an invite with no appointment date simply leaves it out", () => {
  const t = inviteTemplates({ name: "Sam Sample", token: "tok_abc123", providerName: "Dr. Ada Bell" });
  assert.match(t.sms, /before your visit so your doctor is ready/);
  assert.equal(/\bon (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(t.email.text), false);
  assert.deepEqual(inviteTemplates({ name: "Sam Sample", token: "tok_abc123", providerName: "Dr. Ada Bell", apptAt: null }), t);
});

test("the invite link follows APP_URL and never doubles the slash", () => {
  assert.equal(inviteTemplates({ name: "Sam", token: "t", providerName: "P" }).link, "https://sweetspot.example/s/t");
  process.env.APP_URL = "https://sweetspot.example";
  try {
    assert.equal(inviteTemplates({ name: "Sam", token: "t", providerName: "P" }).link, "https://sweetspot.example/s/t");
  } finally {
    process.env.APP_URL = "https://sweetspot.example/";
  }
});

test("the invite says nothing clinical", () => {
  const t = inviteTemplates({ name: "Sam Sample", token: "tok_abc123", providerName: "Dr. Ada Bell", apptAt: APPT });
  // "glucose data" is the one mention of the word, and it is about what the patient may share, not a reading.
  assert.match(t.email.text, /share your glucose data/);
  assertNoClinicalContent("invite SMS", t.sms);
  for (const bad of clinicalStrings.filter((s) => s !== "glucose")) {
    assert.equal(t.email.text.toLowerCase().includes(bad.toLowerCase()), false, `invite email must not mention ${JSON.stringify(bad)}`);
  }
});

test("the summary-ready emails are a link each, provider and patient", () => {
  const t = summaryTemplates({
    visit: { id: "vis_7", token: "tok_abc123", apptAt: APPT },
    patient: { name: "Sam Sample" },
    provider: { id: "usr_9", name: "Dr. Ada Bell" },
  });
  assert.equal(t.providerLink, "https://sweetspot.example/provider/usr_9?visit=vis_7");
  assert.equal(t.patientLink, "https://sweetspot.example/patient/tok_abc123");
  assert.equal(t.provider.subject, "Sour: a pre-visit summary is ready (Thursday, Sep 24)");
  assert.ok(t.provider.text.includes(t.providerLink));
  assert.match(t.provider.text, /This email carries no patient data\./);
  assert.equal(t.patient.subject, "Your summary is ready, Sam");
  assert.ok(t.patient.text.includes(t.patientLink));
  // T08: the link alone is not the credential any more, and the copy has to stop saying it is (§2.3).
  assert.match(t.patient.text, /Opening it sends you a six-digit code, so it only works for you\. Dr\. Ada Bell's office$/);
});

test("the provider email names no patient, and neither email carries the summary", () => {
  const t = summaryTemplates({
    visit: { id: "vis_7", token: "tok_abc123", apptAt: APPT },
    patient: { name: "Sam Sample" },
    provider: { id: "usr_9", name: "Dr. Ada Bell" },
  });
  // The provider's own mailbox is not a safe place for a patient's name; the visit id in the link is enough.
  assert.equal(t.provider.subject.includes("Sam"), false);
  assert.equal(t.provider.text.includes("Sam"), false);
  assertNoClinicalContent("provider summary email", `${t.provider.subject}\n${t.provider.text}`);
  assertNoClinicalContent("patient summary email", `${t.patient.subject}\n${t.patient.text}`);
  // The patient's own link appears nowhere in the provider's mail, and vice versa.
  assert.equal(t.provider.text.includes("tok_abc123"), false);
  assert.equal(t.patient.text.includes("usr_9"), false);
});

test("a summary with no appointment date drops the date from both subjects", () => {
  const t = summaryTemplates({
    visit: { id: "vis_7", token: "tok_abc123", apptAt: null },
    patient: { name: "Sam Sample" },
    provider: { id: "usr_9", name: "Dr. Ada Bell" },
  });
  assert.equal(t.provider.subject, "Sour: a pre-visit summary is ready");
  assert.match(t.provider.text, /^A Sour pre-visit summary is ready\.\n/);
  assert.match(t.patient.text, /^Hi Sam,\n\nYour summary is ready\.\n/);
});

// Design §2.3, §5.3, §8.2: the verification code. The one message that is a credential rather than a link.
test("the code message carries the digits, the practice and nothing else", () => {
  const t = codeTemplates({ code: "480913", providerName: "Dr. Ada Bell", minutes: 10 });

  assert.ok(t.sms.includes("480913"));
  assert.ok(t.sms.includes("Dr. Ada Bell"));
  assert.match(t.sms, /10 minutes/);
  assert.equal(t.email.subject, "Your code is 480913");
  assert.ok(t.email.text.includes("480913"));

  const everything = `${t.sms}\n${t.email.subject}\n${t.email.text}`;
  // No patient name, because the template is never given one, and no link: a code screen the patient is
  // already looking at needs no second way in, and a link plus a code in one message is a phishing lesson.
  assert.equal(everything.includes("Sam"), false);
  assert.equal(/https?:\/\//.test(everything), false, "a code message carries no link");
  assertNoClinicalContent("code message", everything);

  // Both channels say it outright, because this is the message an attacker would ask someone to read out.
  assert.match(t.sms, /never call to ask you for it/i);
  assert.match(t.email.text, /ask you for it/i);
  // An SMS segment is 160 characters; two is the practical limit before carriers start charging per part.
  assert.ok(t.sms.length <= 320, `the code SMS is ${t.sms.length} characters`);
});

// ---------------------------------------------------------------------------------------------
// §8.2's fifth template, and §8.1's rule applied to all of them.

test("the deletion confirmation says what was deleted, names the office, and carries no link", () => {
  const t = deletionTemplates({ name: "Sam Sample", providerName: "Sweet Spot Endocrinology" });
  for (const [label, text] of [["sms", t.sms], ["email", t.email.text]] as const) {
    assert.match(text, /Sweet Spot Endocrinology/, `${label} should name the practice`);
    assert.match(text, /Sam/, `${label} should greet them by first name`);
    assert.equal(/https?:\/\//.test(text), false, `${label} must carry no link: there is nothing left to open`);
    assertNoClinicalContent(`deletion ${label}`, text);
  }
  // The thing a patient most needs to know is that the record of the appointment itself is the practice's.
  assert.match(t.email.text, /practice keeps its own record/);
  assert.match(t.email.subject, /deleted/i);
});

test("the deletion confirmation uses the full name only as a first name", () => {
  // The surname is contact detail the purge has just removed; the greeting should not put it back.
  const t = deletionTemplates({ name: "Sam Sample", providerName: "Dr. Demo Endo" });
  assert.equal(t.sms.includes("Sample"), false);
});

test("a closed channel is skipped, with a reason and no backend, so the job does not retry it", async () => {
  // §8.1: the invite goes out on both channels staff chose, and the address bounced last week. The
  // suppressed result must carry no `provider`, which is what lib/jobHandlers.ts reads as "a backend really
  // tried" — a retry would send the same message to the same dead address and cost the practice its
  // sending reputation. No backend is configured in this test, so the open channel refuses on its own terms.
  const result = await sendIntakeInvite({
    name: "Sam Sample",
    phone: "+14155550100",
    email: "sam@example.com",
    token: "tok",
    providerName: "Sweet Spot Endocrinology",
    channels: ["sms", "email"],
    suppression: { emailUndeliverableAt: new Date("2026-10-08T00:00:00Z"), emailUndeliverableReason: "bounce" },
  });
  assert.equal(result.email.sent, false);
  assert.equal(result.email.provider, undefined);
  assert.match(result.email.error!, /bounced/);
  // The other channel is untouched by the suppression: it failed for its own reason, which is configuration.
  assert.match(result.sms.error!, /not configured/);
});

test("a channel staff never chose stays unsent for that reason, not for a suppression one", async () => {
  const result = await sendIntakeInvite({
    name: "Sam Sample",
    phone: "+14155550100",
    email: "sam@example.com",
    token: "tok",
    providerName: "Sweet Spot Endocrinology",
    channels: ["email"],
    suppression: { smsOptOutAt: new Date() },
  });
  assert.match(result.sms.error!, /consented/);
});

// ---------------------------------------------------------------------------------------------
// §13.4 A demo practice never messages a real address

test("a demo practice's invite goes to a reserved address and not to a real one", async () => {
  // Both channels are chosen and both have something on file. The email is reserved (`.local`, lib/demo.ts)
  // so it is attempted and fails on configuration like any other; the phone is an assignable 555 number, so
  // it is not attempted at all. That asymmetry is the rule: synthetic destinations only.
  const result = await sendIntakeInvite({
    name: "Sam Sample",
    phone: "+14155551234",
    email: "sam.sample@sweetspot.local",
    token: "tok",
    providerName: "Sweet Spot Endocrinology",
    channels: ["sms", "email"],
    demo: true,
  });
  assert.equal(result.sms.sent, false);
  assert.equal(result.sms.provider, undefined, "no backend tried, so lib/jobHandlers.ts will not retry it");
  assert.match(result.sms.error!, /demo practice/);
  assert.equal(result.sms.error!.includes("4155551234"), false, "the reason is shown to staff (§8.3), so no number in it");
  assert.match(result.email.error!, /not configured/, "a reserved address is attempted like any other");
});

test("a demo practice blocks a real address even on the channel staff chose", async () => {
  const result = await sendIntakeInvite({
    name: "Sam Sample",
    phone: "+14155550100",
    email: "someone@gmail.com",
    token: "tok",
    providerName: "Sweet Spot Endocrinology",
    channels: ["sms", "email"],
    demo: true,
  });
  assert.match(result.email.error!, /demo practice/);
  assert.equal(result.email.provider, undefined);
  // And the reserved number is fine: 555-0100 is the fictitious range.
  assert.match(result.sms.error!, /not configured/);
});

test("demo mode changes nothing for a practice that is not one", async () => {
  const result = await sendIntakeInvite({
    name: "Sam Sample",
    phone: "+14155551234",
    email: "someone@gmail.com",
    token: "tok",
    providerName: "Northstar Endocrinology",
    channels: ["sms", "email"],
  });
  for (const channel of [result.sms, result.email]) {
    assert.match(channel.error!, /not configured/);
    assert.equal(channel.error!.includes("demo"), false);
  }
});

test("a demo practice's deletion confirmation and summary notice obey the same rule", async () => {
  const deletion = await sendDeletionConfirmation({
    patientId: "c0000000000000000000000de",
    name: "Sam Sample",
    phone: "+14155550100",
    email: "someone@gmail.com",
    providerName: "Sweet Spot Endocrinology",
    demo: true,
  });
  assert.match(deletion.email.error!, /demo practice/);
  assert.match(deletion.sms.error!, /not configured/, "the reserved number is attempted");

  // The clinician's own address is gated too: a demo practice's clinician is a seeded row like its patients.
  const notified = await sendSummaryEmails({
    visit: { id: "c0000000000000000000000vi", token: "tok", apptAt: APPT },
    patient: { id: "c0000000000000000000000pa", name: "Sam Sample", email: "sam.sample@sweetspot.local" },
    provider: { id: "c0000000000000000000000pr", name: "Dr. Demo Endo", email: "doctor@realclinic.com", practice: "Sweet Spot Endocrinology" },
    providerSummary: summary,
    patientSummary: summary,
    demo: true,
  });
  assert.match(notified.provider.error!, /demo practice/);
  assert.match(notified.patient.error!, /not configured/, "the patient's reserved address is attempted");
});

// ---------------------------------------------------------------------------------------------
// T111 Whether there is a sender behind the channel staff chose, asked before anything is queued. The
// environment this file runs in has no sender at all (the deletions at the top), which is also the
// environment `scripts/agent-check.sh` and a fresh `.env` are in, so the unconfigured case is the default
// here and a configured one is set for the length of one test.

/** Set these for one call and put the environment back, whichever way the assertion goes. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const before = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// T113 The same question for the one message that is a credential rather than a link: which of the ways
// there are to reach this patient can carry a six-digit code (§2.3). `channelsFor` (lib/patientSession.ts)
// answers what is on file; this answers what has a sender behind it.

test("a contact detail with no sender behind it cannot carry a code (T113)", () => {
  // The environment of this file, of `scripts/agent-check.sh` with its mailbox unset, and of a deployment
  // that has configured nothing: a phone number and an address on file, and nowhere for the digits to go.
  assert.deepEqual(codeChannels(["sms", "email"]), []);
  assert.deepEqual(codeChannels(["sms"]), []);
  assert.deepEqual(codeChannels(["email"]), []);
  assert.deepEqual(codeChannels([]), [], "nothing on file is still nothing to send on");
});

test("the mailbox can carry a code, which is what makes the product walkable offline (§11.3)", () => {
  // The difference from `inviteSendability` below, and the reason the two ask different questions: the code
  // goes through `sendOrMailbox`, so a checkout naming DEV_MAIL_DIR really does deliver it — to a file
  // `npm run mail` and e2e/patient.ts read. An invite goes straight to `sendEmail` and has no such place.
  withEnv({ DEV_MAIL_DIR: "e2e/.mail" }, () => {
    assert.deepEqual(codeChannels(["sms", "email"]), ["email"]);
    assert.deepEqual(codeChannels(["sms"]), [], "a mailbox is not a phone");
    assert.deepEqual(inviteSendability("email").channels, [], "and it is not an invite's answer either");
  });
});

test("each backend answers for its own channel, and the order on file is kept", () => {
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, () => assert.deepEqual(codeChannels(["sms", "email"]), ["email"]));
  withEnv({ SNS_ORIGINATION_NUMBER: "+15550100" }, () => assert.deepEqual(codeChannels(["sms", "email"]), ["sms"]));
  withEnv({ SNS_ORIGINATION_NUMBER: "+15550100", EMAIL_FROM: "clinic@sweetspot.example" }, () => {
    assert.deepEqual(codeChannels(["sms", "email"]), ["sms", "email"]);
    assert.deepEqual(codeChannels(["email", "sms"]), ["email", "sms"], "the caller's order, which is the patient's");
  });
  // A forced backend missing the setting it cannot send without is unconfigured, not an attempt (T94, T110).
  withEnv({ SMS_PROVIDER: "twilio" }, () => assert.deepEqual(codeChannels(["sms"]), []));
  withEnv({ EMAIL_PROVIDER: "ses" }, () => assert.deepEqual(codeChannels(["email"]), []));
});

test("with no backend at all, no channel staff chose can send, and the reason is the practice's", () => {
  for (const channel of ["both", "sms", "email", null, undefined]) {
    const can = inviteSendability(channel);
    assert.deepEqual(can.channels, [], `${channel} has nothing to send on`);
    assert.match(can.reason!, /^Sweet Spot cannot send/, `${channel} says so in staff's words`);
    // §3.7, §10.6: the deployment's internals stay off a practice's screen. The same shape lib/delivery.ts's
    // own tests use, so a new sentence in that family cannot smuggle a variable name onto this screen.
    assert.doesNotMatch(can.reason!, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
  }
});

test("the channel staff chose names which of the two sentences they get", () => {
  assert.match(inviteSendability("email").reason!, /cannot send email yet/);
  assert.match(inviteSendability("sms").reason!, /cannot send texts yet/);
  // "both" is the wizard's default and neither of the two: the line that names no channel is the true one
  // when neither can send.
  assert.match(inviteSendability("both").reason!, /cannot send this message yet/);
});

test("staff choosing to message nobody is not a gap in the deployment", () => {
  // `channel: "none"` is a legitimate row (§2.2) and POST /api/book has its own sentence for it. Nothing to
  // send is not the same statement as nothing to send *with*, so this reports no reason at all.
  const can = inviteSendability("none");
  assert.deepEqual(can.channels, []);
  assert.equal(can.reason, undefined);
});

test("a configured backend is reported as sendable, with no reason", () => {
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, () => {
    const can = inviteSendability("email");
    assert.deepEqual(can.channels, ["email"]);
    assert.equal(can.reason, undefined);
  });
  withEnv({ SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    assert.deepEqual(inviteSendability("sms").channels, ["sms"]);
  });
});

test("one backend of the two is a narrower invite, not a refused one", () => {
  // The case the wizard used to be wrong about in the other direction: staff chose "Text and email", the
  // deployment can only text, and "on its way by text and email" is half false. The answer is the subset,
  // so the sentence can name the channel that is really going out.
  withEnv({ SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    const can = inviteSendability("both");
    assert.deepEqual(can.channels, ["sms"]);
    assert.equal(can.reason, undefined);
  });
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, () => {
    assert.deepEqual(inviteSendability("both").channels, ["email"]);
  });
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    assert.deepEqual(inviteSendability("both").channels, ["sms", "email"]);
  });
});

// ---------------------------------------------------------------------------------------------
// T121 The whole of "can a code reach this patient": the environment's third above, plus the two filters
// that live on the patient's own row. `codeChannels` was half an answer, and the other half closed a
// channel just as completely — a bounced address, a number that texted STOP, a demo practice whose patient
// has an address somebody could own — so the code screen promised digits the `notify.code` job then refused.

const MAILBOX = { DEV_MAIL_DIR: "e2e/.mail" };
const BOTH = { DEV_MAIL_DIR: "e2e/.mail", SNS_ORIGINATION_NUMBER: "+14155550199" };
const SAM = { phone: "+14155550100", email: "sam.sample@sweetspot.local" };
const BOUNCED = { emailUndeliverableAt: new Date("2026-10-08T00:00:00Z"), emailUndeliverableReason: "bounce" };
const STOPPED = { smsOptOutAt: new Date("2026-10-08T00:00:00Z") };

test("with every channel open and a sender behind it, a code can reach the patient (T121)", () => {
  withEnv(BOTH, () => {
    const reach = codeReach({ channels: ["sms", "email"], ...SAM });
    assert.deepEqual(reach.channels, ["sms", "email"]);
    assert.equal(reach.closedBy, undefined, "nothing closed, so there is nothing to attribute");
    // The caller's order is the patient's, the same promise `codeChannels` makes.
    assert.deepEqual(codeReach({ channels: ["email", "sms"], ...SAM }).channels, ["email", "sms"]);
  });
});

test("a bounced address cannot carry a code, and the open channel still can (§8.1)", () => {
  withEnv(BOTH, () => {
    const reach = codeReach({ channels: ["sms", "email"], ...SAM, suppression: BOUNCED });
    assert.deepEqual(reach.channels, ["sms"], "the honest answer is the other channel");
    assert.equal(reach.closedBy, undefined);
  });
});

test("a patient whose only channel the row has closed cannot be reached at all (§8.1, T121)", () => {
  // The ticket's own two arms, each with one channel on file. Both are addresses and numbers this
  // environment really could send to — the mailbox and a number behind an originator — so what closes them
  // is the fact on the row and nothing else.
  withEnv(BOTH, () => {
    const bounced = codeReach({ channels: ["email"], email: SAM.email, suppression: BOUNCED });
    assert.deepEqual(bounced.channels, []);
    assert.equal(bounced.closedBy, "row", "no amount of configuration reopens a dead address");

    const stopped = codeReach({ channels: ["sms"], phone: SAM.phone, suppression: STOPPED });
    assert.deepEqual(stopped.channels, []);
    assert.equal(stopped.closedBy, "row");

    // Both at once, which is the state the front desk has to telephone about.
    const neither = codeReach({ channels: ["sms", "email"], ...SAM, suppression: { ...BOUNCED, ...STOPPED } });
    assert.deepEqual(neither.channels, []);
    assert.equal(neither.closedBy, "row");
  });
});

test("a demo practice cannot send a code to a destination somebody could own (§13.4)", () => {
  withEnv(BOTH, () => {
    // The reserved address and the fictitious number are reachable from a demo practice, which is what makes
    // the seeded demo walkable at all (lib/demo.ts).
    assert.deepEqual(codeReach({ channels: ["sms", "email"], ...SAM, demo: true }).channels, ["sms", "email"]);

    // And a real one is not: §13.4 is an allow-list, so this patient's only channel is closed by the row.
    const real = codeReach({ channels: ["email"], email: "patient@example-endo.com", demo: true });
    assert.deepEqual(real.channels, []);
    assert.equal(real.closedBy, "row");
    const realPhone = codeReach({ channels: ["sms"], phone: "+14155551234", demo: true });
    assert.deepEqual(realPhone.channels, []);
    assert.equal(realPhone.closedBy, "row");

    // The same two destinations at a practice that is not a demo one are untouched by any of it.
    assert.deepEqual(codeReach({ channels: ["email"], email: "patient@example-endo.com" }).channels, ["email"]);
    assert.deepEqual(codeReach({ channels: ["sms"], phone: "+14155551234" }).channels, ["sms"]);
  });
});

test("the row's filters run before the environment's, so `closedBy` says who can fix it (T121)", () => {
  // T113's answer must not regress through this: a channel the row leaves open and this deployment cannot
  // serve is still the deployment's gap, and saying "row" would send staff to the telephone over a sender
  // nobody has configured.
  withEnv(MAILBOX, () => {
    // Email is sendable here (the mailbox) and SMS is not. The bounce closes the one that works.
    const bounced = codeReach({ channels: ["sms", "email"], ...SAM, suppression: BOUNCED });
    assert.deepEqual(bounced.channels, []);
    assert.equal(bounced.closedBy, "environment", "the phone is still open; nothing here can text it");

    // And with the row closing nothing, it is T113's own answer.
    const configured = codeReach({ channels: ["sms"], phone: SAM.phone });
    assert.deepEqual(configured.channels, []);
    assert.equal(configured.closedBy, "environment");
  });

  // Every channel closed on both counts is still the row's: it is the stronger statement, and the one that
  // no configuration undoes.
  const nothing = codeReach({ channels: ["email"], email: SAM.email, suppression: BOUNCED });
  assert.deepEqual(nothing.channels, []);
  assert.equal(nothing.closedBy, "row");
});

test("a visit with nothing on file is not a channel that closed (§2.2, T121)", () => {
  // §2.2's own gap, which both call sites answer before they ask this — and which the dashboard must not
  // report as "call them": there is no number to call.
  for (const env of [{}, BOTH] as Record<string, string>[]) {
    withEnv(env, () => {
      const reach = codeReach({ channels: [] });
      assert.deepEqual(reach.channels, []);
      assert.equal(reach.closedBy, undefined);
    });
  }
});

test("a credential is not a sender, so it does not make a channel sendable (T94, T110)", () => {
  // The inference both of those tickets removed: an ambient AWS key says nothing about whether this
  // deployment texts or mails anybody, and this sandbox has them. Asked before the send, it must give the
  // same answer `sendEmail` and `sendSms` give during it.
  withEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" }, () => {
    assert.deepEqual(inviteSendability("both").channels, []);
    assert.match(inviteSendability("email").reason!, /cannot send email yet/);
  });
});
