import assert from "node:assert/strict";
import test from "node:test";
import { codeTemplates, inviteTemplates, summaryTemplates } from "./notify";
import type { Summary } from "./types";

process.env.APP_URL = "https://sweetspot.example/";
process.env.TZ = "UTC";

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
