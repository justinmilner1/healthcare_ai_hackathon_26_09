import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDevMail } from "./devMailbox";
import { setLogSink } from "./log";
import { INVITE_SUBJECT, inviteEmailText, sendTeamInvite, signInUrlFor } from "./mailer";
import {
  cleanPersonName,
  cleanPracticeName,
  cleanRetentionDays,
  MAX_PERSON_NAME,
  MAX_PRACTICE_NAME,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  normalizeEmail,
  parseRole,
} from "./team";

// The validators every value passes before it reaches a Practice or User row (design §2.1, §4.1, §4.2), and
// the invite email (§8.2). lib/teamStore.ts is the database half and is exercised end to end by
// e2e/roles.spec.ts, which signs two colleagues in with their own magic links.

// ---------------------------------------------------------------------------------------------
// Addresses. `User.email` is unique on the stored form, so normalizing is what makes "already in this
// practice" and "already belongs to another" reliable answers rather than near-misses.

test("an address is stored trimmed and lower-cased, which is what uniqueness is checked on", () => {
  assert.equal(normalizeEmail("  Maya@Northstar-Endo.COM "), "maya@northstar-endo.com");
  assert.equal(normalizeEmail("nurse+desk@practice.co.uk"), "nurse+desk@practice.co.uk");
});

test("what is not an address is refused rather than stored", () => {
  // `nobody@localhost` is the one the browser's own type=email check lets through (e2e/signin.spec.ts).
  for (const bad of ["nobody@localhost", "", "   ", "no-at-sign.com", "two@@at.com", "spaces in@practice.com", "@practice.com", "maya@", 42, null, undefined, {}]) {
    assert.equal(normalizeEmail(bad), null, `${JSON.stringify(bad)} is not an address`);
  }
  assert.equal(normalizeEmail(`${"a".repeat(320)}@practice.com`), null, "an address longer than the column");
});

// ---------------------------------------------------------------------------------------------
// Names. A practice always has one (§4.1); a person's is filled in by Auth.js on first sign-in, so blank
// has to mean null rather than "".

test("a name is collapsed, trimmed and capped, and blank is null", () => {
  assert.equal(cleanPersonName("  Dr   Maya\tChen "), "Dr Maya Chen");
  assert.equal(cleanPersonName(""), null);
  assert.equal(cleanPersonName("   "), null);
  assert.equal(cleanPersonName(undefined), null);
  assert.equal(cleanPersonName("x".repeat(400))?.length, MAX_PERSON_NAME);
});

test("a practice name follows the same rules, so a rename cannot blank it", () => {
  assert.equal(cleanPracticeName(" Northstar   Endocrinology "), "Northstar Endocrinology");
  assert.equal(cleanPracticeName("  "), null);
  assert.equal(cleanPracticeName(7), null);
  assert.equal(cleanPracticeName("y".repeat(400))?.length, MAX_PRACTICE_NAME);
});

// ---------------------------------------------------------------------------------------------
// Retention (§10.4). The sweep reads this number, so "keep nothing" and "keep for ever" are both out, and a
// value that is not a whole number of days is a refusal rather than a rounding.

test("retention takes whole days inside the bounds, from a number or the string a form sends", () => {
  assert.equal(cleanRetentionDays(90), 90);
  assert.equal(cleanRetentionDays(" 365 "), 365);
  assert.equal(cleanRetentionDays(MIN_RETENTION_DAYS), MIN_RETENTION_DAYS);
  assert.equal(cleanRetentionDays(MAX_RETENTION_DAYS), MAX_RETENTION_DAYS);
});

test("retention refuses anything that is not a whole number of days in range", () => {
  for (const bad of [MIN_RETENTION_DAYS - 1, MAX_RETENTION_DAYS + 1, 0, -30, 90.5, "ninety", "", "  ", NaN, Infinity, null, undefined, {}]) {
    assert.equal(cleanRetentionDays(bad), null, `${JSON.stringify(bad)} is not a retention window`);
  }
});

// ---------------------------------------------------------------------------------------------
// Roles on the way in (§5.2). An invite with no role said is the least privileged one; an invite with a role
// that is not a role is a 400, never a silent downgrade to staff.

test("an invite with no role said gets the default, and a role that is not one is undefined", () => {
  assert.equal(parseRole(undefined), "staff");
  assert.equal(parseRole(null), "staff");
  assert.equal(parseRole(""), "staff");
  assert.equal(parseRole("clinician"), "clinician");
  assert.equal(parseRole("admin"), "admin");
  for (const bad of ["owner", "Admin", "superuser", 1, {}]) {
    assert.equal(parseRole(bad), undefined, `${JSON.stringify(bad)} must be reported, not downgraded`);
  }
});

// ---------------------------------------------------------------------------------------------
// The invite email (§2.1, §8.2, §10.3).

test("the invite is a sign-in page and a role, with nothing clinical and no credential in it", () => {
  const url = signInUrlFor("nurse+desk@practice.com");
  const text = inviteEmailText({ practiceName: "Northstar Endocrinology", invitedBy: "Dr Maya Chen", role: "staff", url });

  assert.match(text, /Dr Maya Chen added you to Northstar Endocrinology/);
  assert.match(text, /as staff\./);
  assert.ok(text.includes(url));
  // Nothing in here signs anyone in; the one-time link comes separately, to their own inbox (§5.1).
  assert.equal(/token=|callback\/email/.test(text), false);
  // Nothing clinical either. The role description says "patient invites" and "summaries", which is the
  // recipient's job rather than anybody's data, so this looks for the data: a person, a number, a condition.
  assert.equal(/glucose|mg\/dL|diabet|reading|spike|sleep/i.test(text), false);
});

test("the sign-in URL follows APP_URL, fills the address in, and escapes it", () => {
  const env = { ...process.env };
  try {
    process.env.APP_URL = "https://sweetspot.example/";
    assert.equal(signInUrlFor("nurse+desk@practice.com"), "https://sweetspot.example/provider/signin?email=nurse%2Bdesk%40practice.com");
    delete process.env.APP_URL;
    assert.match(signInUrlFor("a@b.com"), /^http:\/\/localhost:3000\/provider\/signin\?email=a%40b\.com$/);
  } finally {
    process.env = env;
  }
});

test("with no email backend the invite goes to the local mailbox, and the log line carries no address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devmail-invite-"));
  const lines: string[] = [];
  const env = { ...process.env };
  try {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    process.env.DEV_MAIL_DIR = dir;
    setLogSink((_level, line) => lines.push(line));

    const result = await sendTeamInvite("nurse@practice.com", { practiceName: "Northstar", invitedBy: "Dr Maya Chen", role: "clinician" });
    assert.deepEqual(result, { sent: true, provider: "dev-mailbox" });

    const mail = readDevMail(dir);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].subject, INVITE_SUBJECT);
    assert.match(mail[0].text, /as clinician\./);

    const line = lines.join("\n");
    assert.match(line, /"event":"team_invite_sent"/);
    assert.match(line, /"role":"clinician"/);
    assert.equal(line.includes("nurse@practice.com"), false);
  } finally {
    setLogSink();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invite that could not be sent says so, so the admin can tell the person by hand", async () => {
  const env = { ...process.env };
  try {
    process.env.EMAIL_PROVIDER = "ses";
    delete process.env.DEV_MAIL_DIR;
    delete process.env.EMAIL_FROM; // SES with no verified sender fails before any network call
    setLogSink(() => {});
    const result = await sendTeamInvite("nurse@practice.com", { practiceName: "Northstar", invitedBy: "Dr Maya Chen", role: "staff" });
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /EMAIL_FROM/);
  } finally {
    setLogSink();
    process.env = env;
  }
});

test("a demo practice's invite to a real address is not sent, even to the local mailbox (§13.4)", async () => {
  // §13.4: nothing a demo practice sends may reach an address that is not reserved. The mailbox is not an
  // exception — a diverted message still has the address in its file, and a deployment where the mailbox is
  // on is a deployment where somebody is reading it.
  const dir = mkdtempSync(join(tmpdir(), "devmail-demo-invite-"));
  const lines: string[] = [];
  const env = { ...process.env };
  try {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    process.env.DEV_MAIL_DIR = dir;
    setLogSink((_level, line) => lines.push(line));

    const blocked = await sendTeamInvite("nurse@practice.com", { practiceName: "Sweet Spot Endocrinology", invitedBy: "Dr Demo Endo", role: "clinician", demo: true });
    assert.equal(blocked.sent, false);
    assert.match(blocked.error!, /demo practice/);
    assert.deepEqual(readDevMail(dir), [], "nothing was written for anyone to read");

    const line = lines.join("\n");
    assert.match(line, /"demo":true/, "§11.1's alarms leave a demo practice's lines out");
    assert.equal(line.includes("nurse@practice.com"), false);

    // A reserved address in the same practice is invited as usual: the rule is about the destination.
    const sent = await sendTeamInvite("nurse@practice.test", { practiceName: "Sweet Spot Endocrinology", invitedBy: "Dr Demo Endo", role: "clinician", demo: true });
    assert.equal(sent.sent, true);
    assert.equal(readDevMail(dir).length, 1);
  } finally {
    setLogSink();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});
