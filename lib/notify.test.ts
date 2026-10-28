import assert from "node:assert/strict";
import test from "node:test";
import {
  canHandOver,
  codeChannels,
  codeReach,
  codeSenders,
  codeTemplates,
  deletionTemplates,
  inviteFaultByChannel,
  inviteFaults,
  inviteReach,
  inviteSendability,
  inviteTemplates,
  sendDeletionConfirmation,
  sendIntakeInvite,
  sendSummaryEmails,
  summaryTemplates,
} from "./notify";
import { cannotSendYet, DELIVERY_NO_EMAIL, DELIVERY_NO_PHONE, NO_CONTACT_ON_FILE } from "./delivery";
import { DEMO_ONLY_TEST_ADDRESSES } from "./demo";
import { channelsFor } from "./patientSession";
import type { SuppressionFacts } from "./suppression";
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
// T135 The same question about a file of rows rather than one visit: §2.2's CSV import is the bulk path,
// and what staff need before they press the button is one sentence per distinct reason rather than one per
// row. The set is the whole of it; the rest is `inviteSendability` above, row by row.

test("a file of invites nothing can send is one sentence, not one per row (T135)", () => {
  // Twenty-five texted rows in an office with no SMS backend is one fact about the deployment, which is the
  // reason this answers with a set: the sentence the import screen prints is about the office and not about
  // any patient in the file.
  assert.deepEqual(inviteFaults(Array(25).fill("sms")), ["Sweet Spot cannot send texts yet — ask whoever set it up for your office"]);
  assert.deepEqual(inviteFaults([]), [], "a file with no creatable row promises nothing");
});

test("two channels nothing can send are two sentences, because each names its own", () => {
  // `cannotSendYet` names the channel staff chose (lib/delivery.ts), so a file holding both kinds has two
  // things to say and the Invite column beside them says which rows each is about.
  assert.deepEqual(inviteFaults(["sms", "email", "sms"]), [
    "Sweet Spot cannot send texts yet — ask whoever set it up for your office",
    "Sweet Spot cannot send email yet — ask whoever set it up for your office",
  ]);
  // "both" is neither of the two, and the line that names no channel is the true one when neither can send.
  assert.deepEqual(inviteFaults(["both"]), ["Sweet Spot cannot send this message yet — ask whoever set it up for your office"]);
});

test("a row that chose to message nobody is not a gap in the deployment (T120)", () => {
  // §2.2's blank `channel` column, which the CSV parser reads as "none" (lib/visitIntake.ts). Lines 3 and 4
  // of the example file are this case: they must stay clean on a screen full of faults, because nothing is
  // wrong with them and `NO_CONSENT_TO_MESSAGE` is their sentence.
  assert.deepEqual(inviteFaults(["none", "none"]), []);
  assert.deepEqual(inviteFaults(["none", "sms"]), ["Sweet Spot cannot send texts yet — ask whoever set it up for your office"], "and it hides nothing beside it");
});

test("a configured deployment reports no fault for a file at all (T135)", () => {
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, () => {
    assert.deepEqual(inviteFaults(["email", "email", "none"]), []);
    // One backend of the two still sends, so "both" is a narrower invite and not a refused one — the same
    // judgement `inviteSendability` makes one row at a time.
    assert.deepEqual(inviteFaults(["both"]), []);
    assert.deepEqual(inviteFaults(["sms", "email"]), ["Sweet Spot cannot send texts yet — ask whoever set it up for your office"], "the channel with no backend is still named");
  });
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    assert.deepEqual(inviteFaults(["sms", "email", "both", "none"]), [], "nothing to say about a deployment that can send");
  });
});

// T140 The same question asked of all four of §2.2's channels at once, because step 3 of the booking wizard
// has to say it while the radio is still being chosen. The record is the faults and nothing else: a channel
// with a sender behind it and "Do not message" are both absent, for different reasons that the step keeps
// apart (lib/booking.ts `bookingPlan`).

test("an office with no backend at all has a sentence for every channel it could choose (T140)", () => {
  const faults = inviteFaultByChannel();
  assert.deepEqual(faults, {
    both: "Sweet Spot cannot send this message yet — ask whoever set it up for your office",
    sms: "Sweet Spot cannot send texts yet — ask whoever set it up for your office",
    email: "Sweet Spot cannot send email yet — ask whoever set it up for your office",
  });
  // Not a key with an undefined value: "Do not message" is the practice's own choice, and the step reads
  // the absence of a key as "nothing is wrong here" (T120).
  assert.equal("none" in faults, false);
});

test("each channel gets its own sentence, so a half-configured office is not told it can send nothing (T140)", () => {
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, () => {
    // Email sends, so "both" is a narrower invite and not a refused one — the judgement `inviteSendability`
    // already makes one channel at a time, and the wizard's default lands on it.
    assert.deepEqual(inviteFaultByChannel(), {
      sms: "Sweet Spot cannot send texts yet — ask whoever set it up for your office",
    });
  });
  withEnv({ SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    assert.deepEqual(inviteFaultByChannel(), {
      email: "Sweet Spot cannot send email yet — ask whoever set it up for your office",
    });
  });
});

test("a configured deployment has nothing to say on the step at all (T140)", () => {
  withEnv({ EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199" }, () => {
    assert.deepEqual(inviteFaultByChannel(), {});
  });
});

test("every sentence a file can carry stays in staff's words (§3.7, §10.6)", () => {
  // The same shape lib/delivery.ts's own tests use: a new sentence in this family cannot smuggle a variable
  // name or a backend onto a practice's screen, and this is the screen a whole day of patients is decided on.
  for (const fault of inviteFaults(["sms", "email", "both"])) {
    assert.match(fault, /^Sweet Spot cannot send/);
    assert.doesNotMatch(fault, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/);
  }
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

// ---------------------------------------------------------------------------------------------
// T145 The whole of "can an invite reach this patient": `inviteSendability` above, plus the two filters on
// the rows. T121 built that composition for the code path (`codeReach` above) and the invite path never got
// it, so a demo practice booking a prospect's real mobile number was promised the send on step 3 of the
// wizard, told "<name> is on the way." one press later, and contradicted only by the delivery row minutes
// afterwards. Every case here configures a sender, because the gate configures none (§11.3) and without one
// the honest "cannot send yet" wins before §13.4 could matter — which is why the bug survived.

/** An office with a sender behind both channels. Not `BOTH` above, which is the *code* path's pair: an
 *  invite's email goes through `sendEmail` and not `sendOrMailbox`, so a mailbox is not a sender for it
 *  (lib/notify.ts `inviteSendability` against `emailConfig`, lib/email.ts). Neither value is a credential. */
const SENDING = { EMAIL_FROM: "clinic@sweetspot.example", SNS_ORIGINATION_NUMBER: "+14155550199" };

/** A number and an address a demo practice may not write to: neither is in the NANP's 555-01xx range nor
 *  under a reserved domain, so §13.4 treats both as somebody's (lib/demo.ts). The number is the one the
 *  ticket reproduces with. */
const REAL = { phone: "+16505552652", email: "prospect@example-endo.com" };

test("a demo practice booking a real destination is told so before the send (§13.4, T145)", () => {
  withEnv(SENDING, () => {
    for (const channel of ["sms", "email", "both"] as const) {
      const reach = inviteReach({ channel, ...REAL, demo: true });
      assert.deepEqual(reach.channels, [], channel);
      assert.equal(reach.reason, DEMO_ONLY_TEST_ADDRESSES, channel);
      // Never the deployment's sentence: this office has both senders, and configuring a third would not
      // reopen anything. That mix-up is what sends staff to whoever set Sweet Spot up over a rule.
      assert.doesNotMatch(reach.reason!, /cannot send/);
    }
  });
});

test("and a demo practice booking a reserved destination is left exactly as it was (§13.4)", () => {
  withEnv(SENDING, () => {
    // SAM is the seeded patient's own pair: the fictitious number and the `.local` address. This is the
    // walkable demo, so nothing here may close a channel.
    const reach = inviteReach({ channel: "both", ...SAM, demo: true });
    assert.deepEqual(reach.channels, ["sms", "email"]);
    assert.equal(reach.reason, undefined);
    // One of each, so neither destination is carrying the other.
    assert.deepEqual(inviteReach({ channel: "sms", phone: SAM.phone, demo: true }).channels, ["sms"]);
    assert.deepEqual(inviteReach({ channel: "email", email: SAM.email, demo: true }).channels, ["email"]);
  });
});

test("a practice that is not a demo one is untouched by §13.4, whatever it books", () => {
  withEnv(SENDING, () => {
    const reach = inviteReach({ channel: "both", ...REAL });
    assert.deepEqual(reach.channels, ["sms", "email"], "which is nearly every practice");
    assert.equal(reach.reason, undefined);
  });
});

test("a booking inherits the bounce or the STOP on the patient it reuses (§2.2, §8.1, T145)", () => {
  // §2.2 matches an existing patient on phone or email, so the row a new visit lands on can already carry
  // what a provider told us about it. The route is where this is asked, because the patient may not exist
  // yet when step 3 renders — the asymmetry is deliberate.
  withEnv(SENDING, () => {
    const bounced = inviteReach({ channel: "email", ...REAL, suppression: BOUNCED });
    assert.deepEqual(bounced.channels, []);
    assert.equal(bounced.reason, "the address bounced, so email is off (design §8.1)");

    const stopped = inviteReach({ channel: "sms", ...REAL, suppression: STOPPED });
    assert.deepEqual(stopped.channels, []);
    assert.equal(stopped.reason, "the patient texted STOP, so texts are off (design §8.1)");

    // One of the two closed is a narrower invite and not a refused one, like a half-configured deployment.
    const half = inviteReach({ channel: "both", ...REAL, suppression: BOUNCED });
    assert.deepEqual(half.channels, ["sms"]);
    assert.equal(half.reason, undefined);
  });
});

test("the rows are asked before the environment, so the sentence names what configuring cannot fix (T145)", () => {
  // The order `codeReach` settled for the code path. A demo practice in an office with no sender at all is
  // told about §13.4, because that is the fact that survives whatever anybody configures next.
  const unconfigured = inviteReach({ channel: "sms", ...REAL, demo: true });
  assert.equal(unconfigured.reason, DEMO_ONLY_TEST_ADDRESSES);

  withEnv(MAILBOX, () => {
    // And the other way round: the rows leave the phone open and nothing here can text it, which is T111's
    // sentence and somebody's to fix. Email is demo-blocked, so "both" comes down to the phone.
    const reach = inviteReach({ channel: "both", phone: SAM.phone, email: REAL.email, demo: true });
    assert.deepEqual(reach.channels, []);
    assert.equal(reach.reason, cannotSendYet("both"));
  });
});

test("`channel: \"none\"` is still the practice's own choice and not a reason of ours (T120)", () => {
  // POST /api/book answers this one before it asks anything here (`NO_CONSENT_TO_MESSAGE`), and this must
  // not start competing with it: nothing to send is not the same statement as nothing to send with.
  for (const p of [{ demo: true, ...REAL }, { suppression: BOUNCED, ...REAL }, {}]) {
    const reach = inviteReach({ channel: "none", ...p });
    assert.deepEqual(reach.channels, []);
    assert.equal(reach.reason, undefined);
  }
});

test("every sentence an invite can be refused with stays in staff's words (§3.7, §10.6)", () => {
  // The same guard the file applies to `inviteFaults`, over the two new reasons as well: these reach the
  // success card and step 3 of the wizard, which is a practice's screen.
  withEnv(SENDING, () => {
    const reasons = [
      inviteReach({ channel: "both", ...REAL, demo: true }).reason,
      inviteReach({ channel: "email", ...REAL, suppression: BOUNCED }).reason,
      inviteReach({ channel: "sms", ...REAL, suppression: STOPPED }).reason,
    ];
    for (const reason of reasons) {
      assert.ok(reason, "each of these closes every channel");
      assert.doesNotMatch(reason!, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, reason);
      assert.doesNotMatch(reason!, /6505552652|prospect@/, "and names no destination (§10.3)");
      assert.match(reason!, /^[a-z]/, "it is dropped into a sentence of the caller's");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// T150 The same composition asked by the *resend* path (`POST /api/invite`, §13.4, §8.1, §5.5). T145 wired
// `inviteReach` into the booking route, which hands it four fields assembled a moment earlier
// (`InviteReachRows`, lib/visitStore.ts); the resend route has no such assembly and no query of its own —
// it passes the patient row the guard already loaded, whole, as `suppression`. So what is pinned here is
// that shape: a row with the three §8.1 columns on it among everything else a `Patient` carries, and with
// the two of them that are usually empty really empty, which is what a patient nobody has bounced looks
// like.

/** A patient row as Prisma hands it back, pared to what any of this reads: the two destinations, the three
 *  §8.1 columns, and one field that is none of its business, because the route passes the row whole. */
const patientRow = (p: { phone?: string | null; email?: string | null } & Partial<SuppressionFacts>) => ({
  id: "pat_1",
  name: "Demo Prospect",
  phone: p.phone ?? null,
  email: p.email ?? null,
  emailUndeliverableAt: p.emailUndeliverableAt ?? null,
  emailUndeliverableReason: p.emailUndeliverableReason ?? null,
  smsOptOutAt: p.smsOptOutAt ?? null,
});

/** What the route composes, off that row and its practice — the four arguments of `app/api/invite/route.ts`
 *  in one place, so a test reads the same thing the route does. */
const resend = (channel: string, row: ReturnType<typeof patientRow>, demo: boolean) =>
  inviteReach({ channel, phone: row.phone, email: row.email, suppression: row, demo });

test("a resend from a demo practice to a real number is refused by §13.4, not promised (T150)", () => {
  withEnv(SENDING, () => {
    // The bug as the ticket reproduces it: an office that *can* text, a demo practice, a number somebody
    // could own. `inviteSendability` on its own is satisfied by the origination number and said yes.
    const row = patientRow({ phone: REAL.phone });
    assert.deepEqual(inviteSendability("sms").channels, ["sms"], "the third of the question that said yes");
    const reach = resend("sms", row, true);
    assert.deepEqual(reach.channels, []);
    assert.equal(reach.reason, DEMO_ONLY_TEST_ADDRESSES);
    // Both destinations somebody's, which is the "both" resend of the same bug.
    assert.equal(resend("both", patientRow(REAL), true).reason, DEMO_ONLY_TEST_ADDRESSES);
  });
});

test("and a resend the rows leave open reads exactly as it did before T150", () => {
  withEnv(SENDING, () => {
    // The walkable demo: the seeded patient's own fictitious number and `.local` address, on a row with
    // nothing suppressed. Nothing closes, so **Send link** still promises the send.
    const open = resend("both", patientRow(SAM), true);
    assert.deepEqual(open.channels, ["sms", "email"]);
    assert.equal(open.reason, undefined);
    // And the practice that is not a demo one — nearly every practice — with the number §13.4 refused above.
    const ordinary = resend("both", patientRow(REAL), false);
    assert.deepEqual(ordinary.channels, ["sms", "email"]);
    assert.equal(ordinary.reason, undefined);
  });
});

test("a resend reads §8.1 off the row it was handed, dates and all (T150)", () => {
  withEnv(SENDING, () => {
    // The columns are `Date`s on a Prisma row rather than the strings a wire would carry, and they are on
    // the row among its other fields: this is the asymmetry the resend path has and the booking path does
    // not — the patient exists, so what a provider has told us about them is already on it.
    const stopped = resend("sms", patientRow({ phone: SAM.phone, ...STOPPED }), true);
    assert.deepEqual(stopped.channels, []);
    assert.equal(stopped.reason, "the patient texted STOP, so texts are off (design §8.1)");
    // §13.4 before §8.1 within one row, the order `rowBlockReason` fixes: a number we must not try at all
    // is not a number that said stop.
    assert.equal(resend("sms", patientRow({ phone: REAL.phone, ...STOPPED }), true).reason, DEMO_ONLY_TEST_ADDRESSES);
    // One channel closed is a narrower resend and not a refused one.
    const half = resend("both", patientRow({ ...SAM, ...BOUNCED }), true);
    assert.deepEqual(half.channels, ["sms"]);
    assert.equal(half.reason, undefined);
  });
});

test("a resend the rows leave open keeps the deployment's own sentence (T111, T150)", () => {
  // The order that makes the sentence honest, on the route this ticket is about: nothing configured here, so
  // the phone the rows left open is somebody's to fix and says so — and the demo practice's real address in
  // the same booking is not what staff are sent after.
  withEnv(MAILBOX, () => {
    const reach = resend("both", patientRow({ phone: SAM.phone, email: REAL.email }), true);
    assert.deepEqual(reach.channels, []);
    assert.equal(reach.reason, cannotSendYet("both"));
  });
  // And with every channel closed by the rows, the row's own reason wins whatever the environment is.
  assert.equal(resend("sms", patientRow({ phone: REAL.phone }), true).reason, DEMO_ONLY_TEST_ADDRESSES);
});

// ---------------------------------------------------------------------------------------------
// T173 (§2.2, §2.3, §8.1) The fourth filter, and the first: is there a number or an address at all. Every
// case here configures a sender, for the reason the T145 block above gives and one more that is this
// ticket's whole point — with no sender the honest "cannot send yet" empties `channels` for every visit, so
// the bug was *unobservable* in this suite's default environment and in `scripts/agent-check.sh`. The
// configured arm is therefore not an extra case here, it is the case.

/** The patient §2.2 books when the appointment is made today and the number arrives tomorrow. */
const NOBODY = { phone: null, email: null };

test("a visit with no phone and no email yields no channel on any deployment (T173)", () => {
  // The disagreement the ticket was filed for, stated as the identity it should always have been: whatever
  // the deployment and whatever staff chose, `inviteReach` answers what the `notify.invite` job will send
  // (`invitableChannels`, lib/visitStore.ts). `[]` under both environments is that.
  for (const env of [SENDING, MAILBOX, {}]) {
    withEnv(env, () => {
      for (const channel of ["sms", "email", "both"] as const) {
        const reach = inviteReach({ channel, ...NOBODY });
        assert.deepEqual(reach.channels, [], `${channel} with ${JSON.stringify(env)}`);
        assert.equal(reach.reason, NO_CONTACT_ON_FILE, channel);
      }
    });
  }
});

test("and it says so about the patient rather than about the deployment (T173)", () => {
  withEnv(SENDING, () => {
    const reason = inviteReach({ channel: "both", ...NOBODY }).reason!;
    // Not T111's sentence: this office has both senders and configuring a third reopens nothing. Sending
    // the front desk to whoever set Sweet Spot up over two empty fields on their own screen is the mix-up
    // §3.7 and §10.6 exist to stop.
    assert.notEqual(reason, cannotSendYet("both"));
    assert.doesNotMatch(reason, /cannot send|whoever set/i);
    // Nor §13.4's, which is what this case used to be told on a demo practice: `demoBlockReason` reads a
    // null destination as "not provably synthetic" and refused it as though it were somebody's number.
    assert.notEqual(reason, DEMO_ONLY_TEST_ADDRESSES);
    assert.equal(inviteReach({ channel: "both", ...NOBODY, demo: true }).reason, NO_CONTACT_ON_FILE);
  });
});

test("the missing details are asked before the rows and the environment, being the one gap staff can close", () => {
  withEnv(SENDING, () => {
    // A row can carry a bounce or a STOP after the address it was recorded against is gone, and §13.4 is a
    // column on the practice either way. Neither is the thing to say to someone with two empty fields.
    assert.equal(inviteReach({ channel: "email", ...NOBODY, suppression: BOUNCED }).reason, NO_CONTACT_ON_FILE);
    assert.equal(inviteReach({ channel: "sms", ...NOBODY, suppression: STOPPED, demo: true }).reason, NO_CONTACT_ON_FILE);
  });
  withEnv(MAILBOX, () => {
    assert.equal(inviteReach({ channel: "both", ...NOBODY }).reason, NO_CONTACT_ON_FILE);
  });
});

test("one detail on file narrows the invite to it instead of claiming the other half (T173)", () => {
  // The half of the bug that is not the empty row: staff choose "Text and email", step 1 collected only the
  // address, and this used to hand `inviteSendability("both")` a channel with nowhere to send to. An office
  // with both senders was then told the text was on its way to a patient who has no number.
  withEnv(SENDING, () => {
    const emailOnly = inviteReach({ channel: "both", phone: null, email: SAM.email });
    assert.deepEqual(emailOnly.channels, ["email"]);
    assert.equal(emailOnly.reason, undefined);
    const smsOnly = inviteReach({ channel: "both", phone: SAM.phone, email: null });
    assert.deepEqual(smsOnly.channels, ["sms"]);
    assert.equal(smsOnly.reason, undefined);
    // And the channel staff chose with nothing behind it is the refused one, not the other.
    assert.deepEqual(inviteReach({ channel: "sms", phone: null, email: SAM.email }).channels, []);
    assert.deepEqual(inviteReach({ channel: "email", phone: SAM.phone, email: null }).channels, []);
  });
});

test("`channel: \"none\"` with nothing on file is still the practice's own choice (T120, T173)", () => {
  // Two absences, one of which is not ours to report: the route answers "no consent to message" before it
  // asks anything here, and a second reason competing with it is the shape of the bug, not a fix for it.
  for (const env of [SENDING, {}]) {
    withEnv(env, () => {
      const reach = inviteReach({ channel: "none", ...NOBODY });
      assert.deepEqual(reach.channels, []);
      assert.equal(reach.reason, undefined);
    });
  }
});

test("a resend for a patient with nothing on file is refused the same way (T150, T173)", () => {
  // The route that reads a row rather than a draft (`POST /api/invite`): its **Send link** said "Sending
  // now" for this patient on any deployment that can send, because it reads this same answer.
  withEnv(SENDING, () => {
    for (const channel of ["sms", "email", "both"]) {
      const reach = resend(channel, patientRow(NOBODY), false);
      assert.deepEqual(reach.channels, [], channel);
      assert.equal(reach.reason, NO_CONTACT_ON_FILE, channel);
    }
    // Blank strings are the other way a row holds nothing — a CSV cell with a space in it, a field cleared
    // in a form — and `channelsFor` trims, so they are the same case and not a channel with a destination.
    const blank = resend("both", patientRow({ phone: "  ", email: "" }), false);
    assert.deepEqual(blank.channels, []);
    assert.equal(blank.reason, NO_CONTACT_ON_FILE);
  });
});

test("every refusal for this patient stays in staff's words (§3.7, §10.6, T173)", () => {
  withEnv(SENDING, () => {
    const reason = inviteReach({ channel: "both", ...NOBODY, demo: true }).reason!;
    assert.doesNotMatch(reason, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, reason);
    assert.match(reason, /^[a-z]/, "it is dropped into a sentence of the caller's");
  });
});

// ---------------------------------------------------------------------------------------------
// T176 (§2.2, §8.1, §13.4) The same filter, told apart from itself: "no phone or email on file" is one
// sentence about two different gaps, and for the patient who has one of the two it is false about them.

test("one detail on file is not no detail on file (T176)", () => {
  // The ticket's own case, both ways round. The number is on the row one column to the left of the sentence,
  // so the gap is the half staff picked the channel for — and that is the clause `sendIntakeInvite` would
  // have written on the delivery row for the same cause, which is why it is the same constant.
  withEnv(SENDING, () => {
    assert.equal(inviteReach({ channel: "email", phone: SAM.phone, email: null }).reason, DELIVERY_NO_EMAIL);
    assert.equal(inviteReach({ channel: "sms", phone: null, email: SAM.email }).reason, DELIVERY_NO_PHONE);
    // Neither is the other, and neither is the sentence for the patient who has nothing: three gaps, three
    // clauses, none of them claiming a detail the patient has not got or denying one they have.
    for (const reason of [DELIVERY_NO_EMAIL, DELIVERY_NO_PHONE]) assert.notEqual(reason, NO_CONTACT_ON_FILE);
    assert.equal(inviteReach({ channel: "email", ...NOBODY }).reason, NO_CONTACT_ON_FILE);
  });
  // Whatever the deployment is: this is a fact about the patient's row, so configuring a sender reopens
  // nothing and the unconfigured gate answers the same thing (§11.3).
  for (const env of [MAILBOX, {}]) {
    withEnv(env, () => {
      assert.equal(inviteReach({ channel: "email", phone: SAM.phone, email: null }).reason, DELIVERY_NO_EMAIL);
    });
  }
});

test("the missing half is still asked before the rows and the deployment (T173, T176)", () => {
  withEnv(SENDING, () => {
    // A bounce recorded against an address that is now blank, and §13.4 as a column on the practice: neither
    // is the thing to say to someone whose chosen channel has no destination, for T173's own reason one
    // field along. The number here is one §13.4 refuses, so the demo rule would have answered if it were
    // asked first.
    assert.equal(inviteReach({ channel: "email", phone: REAL.phone, email: null, demo: true }).reason, DELIVERY_NO_EMAIL);
    assert.equal(
      inviteReach({ channel: "email", phone: SAM.phone, email: null, suppression: BOUNCED }).reason,
      DELIVERY_NO_EMAIL,
    );
    // And it is not the deployment's sentence either, on an office that has both senders.
    const reason = inviteReach({ channel: "sms", phone: null, email: SAM.email }).reason!;
    assert.notEqual(reason, cannotSendYet("sms"));
    assert.doesNotMatch(reason, /cannot send|whoever set/i);
    assert.notEqual(reason, DEMO_ONLY_TEST_ADDRESSES);
    // Staff's words, dropped into a sentence of the caller's, naming no variable and no backend.
    assert.doesNotMatch(reason, /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bSNS\b|\bAWS\b|Twilio|Resend/, reason);
    assert.match(reason, /^[a-z]/);
  });
});

test("the half that can send still sends, so the narrowing is not a refusal (T176)", () => {
  // The other direction: "Text and email" with one detail on file is a narrower invite and not a refused
  // one, which is T173's own assertion above — this ticket must not have turned it into a reason.
  withEnv(SENDING, () => {
    for (const to of [{ phone: SAM.phone, email: null }, { phone: null, email: SAM.email }]) {
      const reach = inviteReach({ channel: "both", ...to });
      assert.equal(reach.channels.length, 1, JSON.stringify(to));
      assert.equal(reach.reason, undefined, JSON.stringify(to));
    }
  });
});

test("`channel: \"none\"` says nothing about a missing half either (T120, T176)", () => {
  // The practice's own choice is answered before this function is asked, and a second reason competing with
  // it is the shape of the bug rather than a fix for it — the same point T173 makes for the empty row.
  withEnv(SENDING, () => {
    assert.equal(inviteReach({ channel: "none", phone: SAM.phone, email: null }).reason, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// T175 (§2.3, §5.3, §8.1) The second way to have nowhere to send a code, and the one `handover` was not
// asking about: a deployment with no sender behind the channel the patient does have.
//
// T173's `handover` was `channelsFor(row).length > 0` in both routes — the first of `codeReach`'s four
// filters. The dashboard row has read all four since T121, so one row could carry `NO_CODE_CAN_REACH` ("No
// code can reach this patient, so their link will not open") and, one press later, a note offering **Copy
// intake**. `canHandOver` is that question asked once, and what is pinned here is that it and `codeReach`
// cannot answer one patient differently — including in the mailbox environment the gate itself runs in.

/** Every pair of contact details a patient row can hold, which is lib/booking.test.ts's
 *  `CONTACT_COMBINATIONS`: the rule is about all four and not only about the empty one T173 closed. */
const EVERY_CONTACT = [
  { phone: null, email: null },
  { phone: SAM.phone, email: null },
  { phone: null, email: SAM.email },
  { phone: SAM.phone, email: SAM.email },
  // And the pair §13.4 refuses from a demo practice, so the `demo` arm below has a closing destination too.
  { phone: REAL.phone, email: null },
  { phone: null, email: REAL.email },
  { phone: REAL.phone, email: REAL.email },
] as const;

/** An office with one sender and not the other, which is the arm this ticket exists for: neither `SENDING`
 *  nor the file's own senderless default can tell the two questions apart, because with both senders every
 *  channel is open and with neither every channel is closed. `DEV_MAIL_DIR` is absent from both, which is
 *  what makes them deployments rather than checkouts. */
const SMS_ONLY = { SNS_ORIGINATION_NUMBER: "+14155550199" };
const EMAIL_ONLY = { EMAIL_FROM: "clinic@sweetspot.example" };

test("`canHandOver` is `codeReach` over what is on file, on every deployment and every row (T175)", () => {
  // The identity criterion 7 asks for. `withEnv` here only sets, so each arm is reached from the file's
  // senderless default and the mailbox is only present in the arm that names it.
  for (const [arm, env] of [
    ["an office with both senders", SENDING],
    ["one that can only text", SMS_ONLY],
    ["one that can only email", EMAIL_ONLY],
    ["the gate's own mailbox", MAILBOX],
    ["a deployment with nothing configured", {}],
  ] as const) {
    withEnv(env, () => {
      for (const to of EVERY_CONTACT) {
        for (const demo of [false, true]) {
          for (const suppression of [null, BOUNCED, STOPPED]) {
            const where = `${arm}, demo=${demo}, to=${JSON.stringify(to)}, suppression=${JSON.stringify(suppression)}`;
            const reach = codeReach({ channels: channelsFor(to), ...to, demo, suppression });
            assert.equal(canHandOver({ ...to, demo, suppression }), reach.channels.length > 0, where);
          }
        }
      }
    });
  }
});

test("the mailbox the gate runs in still carries a code, so the handover is still a way in there (T175)", () => {
  // Criterion 7's other half, and the reason this ticket could not be seen in `scripts/agent-check.sh`: the
  // code's email goes through `sendOrMailbox`, so `DEV_MAIL_DIR` really is somewhere for one to go (§11.3,
  // T113). Nothing here may change, because the suite's own screens read it.
  withEnv(MAILBOX, () => {
    assert.equal(canHandOver({ phone: null, email: SAM.email }), true, "the address this checkout can write to a file");
    assert.equal(canHandOver({ phone: SAM.phone, email: SAM.email }), true, "and the pair, by that same address");
    // The number is the half the mailbox is not: no SMS backend and no mailbox for one, which is the arm
    // the e2e suite photographs and needs no new configuration to reach.
    assert.equal(canHandOver({ phone: SAM.phone, email: null }), false, "a number this checkout cannot text");
  });
  // And a deployment, where the mailbox is gone and the address is in the same position as the number.
  assert.equal(canHandOver({ phone: null, email: SAM.email }), false, "no sender at all");
  withEnv(EMAIL_ONLY, () => assert.equal(canHandOver({ phone: null, email: SAM.email }), true));
  withEnv(EMAIL_ONLY, () => assert.equal(canHandOver({ phone: SAM.phone, email: null }), false));
});

test("the row's own facts close the handover as completely as the environment does (§8.1, §13.4, T175)", () => {
  withEnv({ ...SENDING, ...MAILBOX }, () => {
    // §8.1: the only address on file has bounced, so there is nowhere for a code to go and the link will
    // not open — which is `NO_CODE_CAN_REACH` on the row and must be the handover's answer too.
    assert.equal(canHandOver({ phone: null, email: SAM.email, suppression: BOUNCED }), false);
    assert.equal(canHandOver({ phone: SAM.phone, email: null, suppression: STOPPED }), false);
    assert.equal(canHandOver({ ...SAM, suppression: { ...BOUNCED, ...STOPPED } }), false);
    // One of the two closed is still a way in, by the other.
    assert.equal(canHandOver({ ...SAM, suppression: BOUNCED }), true);
    // §13.4: a demo practice may write only to a reserved destination, the code included.
    assert.equal(canHandOver({ phone: REAL.phone, email: null, demo: true }), false);
    assert.equal(canHandOver({ phone: REAL.phone, email: REAL.email, demo: true }), false);
    assert.equal(canHandOver({ phone: REAL.phone, email: SAM.email, demo: true }), true, "the reserved half is a way in");
    // And nothing on file at all, which is T173's case and still answers the same way.
    assert.equal(canHandOver({ phone: "  ", email: "" }), false, "blank fields are not destinations");
  });
});

test("`codeSenders` asks the code's senders and not the invite's (T175)", () => {
  // The prop step 3 of the booking wizard reads (app/provider/page.tsx). It is `codeChannels` over both
  // channels, and the pair it must not be confused with is `inviteFaultByChannel`: in the mailbox the code
  // has somewhere to go by email and the invite has not, which is the state the gate runs in.
  withEnv(MAILBOX, () => {
    assert.deepEqual(codeSenders(), ["email"]);
    assert.ok(inviteFaultByChannel().email, "while no invite can be emailed from the same checkout");
  });
  withEnv(SMS_ONLY, () => assert.deepEqual(codeSenders(), ["sms"]));
  withEnv({ ...SMS_ONLY, ...MAILBOX }, () => assert.deepEqual(codeSenders(), ["sms", "email"]));
  assert.deepEqual(codeSenders(), [], "a deployment with neither sender");
});
