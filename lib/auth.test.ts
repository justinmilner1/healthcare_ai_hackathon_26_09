import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ABSOLUTE_SESSION_SECONDS, authAdapter, isPastAbsoluteCap } from "./authAdapter";
import { devMailFilename, formatDevMail, linkIn, readDevMail, writeDevMail } from "./devMailbox";
import { setLogSink } from "./log";
import { SIGN_IN_SUBJECT, sendSignInLink, signInEmailText } from "./mailer";
import { practiceNameFor } from "./practice";

const LINK = "http://localhost:3000/api/auth/callback/email?token=abc123&email=maya%40practice.com";

// ---------------------------------------------------------------------------------------------
// The absolute cap (design §5.1): 12 hours idle is Auth.js's job, 7 days absolute is ours.

test("the absolute cap is seven days", () => {
  assert.equal(ABSOLUTE_SESSION_SECONDS, 7 * 24 * 60 * 60);
});

test("a session is past the cap seven days after it was created, not before", () => {
  const created = new Date("2026-10-01T09:00:00Z");
  const at = (hours: number) => new Date(created.getTime() + hours * 3600_000);
  assert.equal(isPastAbsoluteCap(created, at(0)), false);
  assert.equal(isPastAbsoluteCap(created, at(167)), false); // hour 167: still inside the window
  assert.equal(isPastAbsoluteCap(created, at(168)), true); // exactly seven days
  assert.equal(isPastAbsoluteCap(created, at(200)), true);
});

/** Enough of Prisma for the adapter: one session row, one user row, and a record of what was deleted. */
function fakePrisma(session: { sessionToken: string; userId: string; expires: Date; createdAt: Date } | null, now = new Date()) {
  const deleted: string[] = [];
  const created: Record<string, unknown>[] = [];
  const user = { id: "cuser0000000000000000000a", email: "maya@practice.com", name: "Dr Maya", role: "clinician", practiceId: "cprac0000000000000000000a" };
  const prisma = {
    session: {
      findUnique: async () => (session ? { ...session, user } : null),
      delete: async ({ where }: { where: { sessionToken: string } }) => {
        deleted.push(where.sessionToken);
        return session;
      },
    },
    user: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...user, ...data, id: "cnew00000000000000000000a", practiceId: "cnewprac000000000000000a" };
      },
    },
  };
  return { adapter: authAdapter(prisma as unknown as PrismaClient, () => now), deleted, created, user };
}

test("a session inside both windows is returned untouched", async () => {
  const now = new Date("2026-10-02T09:00:00Z");
  const { adapter, deleted } = fakePrisma(
    {
      sessionToken: "token-1",
      userId: "cuser0000000000000000000a",
      expires: new Date(now.getTime() + 3600_000),
      createdAt: new Date(now.getTime() - 3600_000),
    },
    now,
  );
  const found = await adapter.getSessionAndUser!("token-1");
  assert.equal(found?.user.email, "maya@practice.com");
  assert.deepEqual(deleted, []);
});

test("a session past the absolute cap is deleted and reads as no session, however fresh its idle clock is", async () => {
  const now = new Date("2026-10-20T09:00:00Z");
  const { adapter, deleted } = fakePrisma(
    {
      sessionToken: "token-2",
      userId: "cuser0000000000000000000a",
      // Someone kept the tab open: expires is in the future, because Auth.js rolled it forward all week.
      expires: new Date(now.getTime() + 12 * 3600_000),
      createdAt: new Date(now.getTime() - 8 * 24 * 3600_000),
    },
    now,
  );
  const found = await adapter.getSessionAndUser!("token-2");
  assert.equal(found, null);
  assert.deepEqual(deleted, ["token-2"]);
});

test("a missing session is still a missing session", async () => {
  const { adapter } = fakePrisma(null);
  assert.equal(await adapter.getSessionAndUser!("nope"), null);
});

test("a user Auth.js creates from a link gets a practice and runs it", async () => {
  const { adapter, created } = fakePrisma(null);
  const user = await adapter.createUser!({ id: "ignored", email: "Maya@Northstar-Endo.com", emailVerified: null });
  assert.equal(user.email, "maya@northstar-endo.com"); // stored lower-case, like lib/practice.ts does
  assert.equal(created.length, 1);
  assert.equal(created[0].role, "admin");
  assert.deepEqual(created[0].practice, { create: { name: "Northstar Endo" } });
});

test("the practice name comes from the domain, with a fallback that is not an email address", () => {
  assert.equal(practiceNameFor("maya@northstar-endo.com"), "Northstar Endo");
  assert.equal(practiceNameFor("demo@sweetspot.local"), "Sweetspot");
  assert.equal(practiceNameFor("nobody"), "New practice");
});

// ---------------------------------------------------------------------------------------------
// The link and where it goes (§5.1, §8.2, §10.3).

test("the sign-in email is a link and nothing else: no clinical content, no patient", () => {
  const text = signInEmailText(LINK, 15);
  assert.ok(text.includes(LINK));
  assert.match(text, /expires in 15 minutes/);
  assert.equal(/glucose|patient|summary|visit/i.test(text), false);
});

test("a mailbox file sorts by time, names itself after the subject, and round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "devmail-"));
  try {
    const at = new Date("2026-10-11T09:14:02.123Z");
    assert.equal(devMailFilename(SIGN_IN_SUBJECT, at), "2026-10-11T09-14-02-123Z-your-sweet-spot-sign-in-link.txt");
    assert.match(formatDevMail({ to: "maya@practice.com", subject: "Hi", text: "body" }, at), /^Date: 2026-10-11T09:14:02\.123Z\nTo: maya@practice\.com\nSubject: Hi\n\nbody\n$/);

    writeDevMail({ to: "a@practice.com", subject: SIGN_IN_SUBJECT, text: signInEmailText(LINK, 15) }, dir, at);
    writeDevMail({ to: "b@practice.com", subject: SIGN_IN_SUBJECT, text: "no link here" }, dir, new Date(at.getTime() + 1000));

    const mail = readDevMail(dir);
    assert.deepEqual(mail.map((m) => m.to), ["a@practice.com", "b@practice.com"]); // oldest first
    assert.equal(mail[0].subject, SIGN_IN_SUBJECT);
    assert.equal(linkIn(mail[0].text), LINK);
    assert.equal(linkIn(mail[1].text), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mailbox that does not exist is empty, not an error", () => {
  assert.deepEqual(readDevMail(join(tmpdir(), "devmail-does-not-exist")), []);
});

test("with no email backend the link goes to the local mailbox, and the log line carries no address or token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devmail-"));
  const lines: string[] = [];
  const env = { ...process.env };
  try {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.RESEND_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    process.env.DEV_MAIL_DIR = dir;
    setLogSink((_level, line) => lines.push(line));

    const result = await sendSignInLink("maya@practice.com", LINK, 15);
    assert.deepEqual(result, { sent: true, provider: "dev-mailbox" });
    assert.equal(linkIn(readDevMail(dir)[0].text), LINK);

    const line = lines.join("\n");
    assert.match(line, /"event":"signin_link_sent"/);
    assert.equal(line.includes("maya@practice.com"), false);
    assert.equal(line.includes("token=abc123"), false);
  } finally {
    setLogSink();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a send that fails is reported as unsent, so sign-in does not pretend a link is on its way", async () => {
  const env = { ...process.env };
  try {
    process.env.EMAIL_PROVIDER = "ses";
    delete process.env.EMAIL_FROM; // SES with no verified sender fails before any network call
    setLogSink(() => {});
    const result = await sendSignInLink("maya@practice.com", LINK, 15);
    assert.equal(result.sent, false);
    assert.match(result.error ?? "", /EMAIL_FROM/);
  } finally {
    setLogSink();
    process.env = env;
  }
});
