import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ABSOLUTE_SESSION_SECONDS, authAdapter, isPastAbsoluteCap } from "./authAdapter";
import { devMailFilename, divertsMail, formatDevMail, linkIn, readDevMail, writeDevMail } from "./devMailbox";
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

test("mail is diverted when a directory is named, or when there is no backend to send with", () => {
  assert.equal(divertsMail({ DEV_MAIL_DIR: "e2e/.mail" }, true), true);
  assert.equal(divertsMail({}, false), true);
  assert.equal(divertsMail({}, true), false);
  assert.equal(divertsMail({ DEV_MAIL_DIR: "  " }, true), false);
});

test("a mailbox that does not exist is empty, not an error", () => {
  assert.deepEqual(readDevMail(join(tmpdir(), "devmail-does-not-exist")), []);
});

test("DEV_MAIL_DIR wins over a configured backend, so a sandbox with AWS keys in its environment sends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "devmail-"));
  const env = { ...process.env };
  try {
    process.env.EMAIL_PROVIDER = "ses";
    process.env.DEV_MAIL_DIR = dir;
    setLogSink(() => {});
    const result = await sendSignInLink("maya@practice.com", LINK, 15);
    // The result says where it landed, so a caller can tell a developer where to look for it.
    assert.deepEqual(result, { sent: true, provider: "dev-mailbox", target: dir });
    assert.equal(linkIn(readDevMail(dir)[0].text), LINK);
  } finally {
    setLogSink();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  }
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
    // The result says where it landed, so a caller can tell a developer where to look for it.
    assert.deepEqual(result, { sent: true, provider: "dev-mailbox", target: dir });
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
    delete process.env.DEV_MAIL_DIR;
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

// ---------------------------------------------------------------------------------------------
// The Auth.js configuration itself (T42, design §5.1, §5.2, §13.4).
//
// `lib/auth.ts` is mostly declaration, and what a browser does with it is the e2e suite's job (e2e/auth.ts
// signs in for real). Three things in it are decisions, though, and all three are cheap to pin here: the
// session callback, because §5.2's practice and role reach every page and route through it and nothing else;
// `sendVerificationRequest`, because a send that failed must not look like a link on its way; and the two
// clocks §5.1 names.
//
// `./auth` is imported dynamically so AUTH_SECRET is set before the module reads it — `authConfig.secret` is
// evaluated once, at import. It pulls in the `db` singleton, which is why nothing here asks it for rows: the
// file's other imports have already bound that client to whatever DATABASE_URL said.

describe("authConfig", () => {
  let auth: typeof import("./auth");
  const saved = { secret: process.env.AUTH_SECRET };

  before(async () => {
    process.env.AUTH_SECRET = "auth-test-secret-not-for-deployment";
    auth = await import("./auth");
  });

  after(() => {
    if (saved.secret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = saved.secret;
    setLogSink();
  });

  it("enforces §5.1's idle clock with database sessions, so signing out ends one for real", () => {
    assert.equal(auth.IDLE_SESSION_SECONDS, 12 * 60 * 60);
    assert.equal(auth.SIGN_IN_LINK_SECONDS, 15 * 60);
    assert.equal(auth.authConfig.session?.strategy, "database");
    assert.equal(auth.authConfig.session?.maxAge, auth.IDLE_SESSION_SECONDS);
    // Short enough that the twelve hours mean what they say.
    assert.ok((auth.authConfig.session?.updateAge ?? Infinity) <= 15 * 60);
    assert.equal(auth.authConfig.trustHost, true, "self-hosted, so the host header is the app's own (§3.1)");
    assert.equal(auth.authConfig.secret, "auth-test-secret-not-for-deployment");
  });

  it("has exactly one provider, an email link, and no password anywhere", () => {
    const providers = auth.authConfig.providers as { id?: string; type?: string; maxAge?: number }[];
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "email");
    assert.equal(providers[0].type, "email");
    assert.equal(providers[0].maxAge, auth.SIGN_IN_LINK_SECONDS);
  });

  it("redirects to our own screens, so Auth.js's unstyled ones are never shown", () => {
    assert.deepEqual(auth.authConfig.pages, {
      signIn: "/provider/signin",
      verifyRequest: "/provider/check-email",
      signOut: "/provider/signout",
      error: "/provider/signin",
    });
  });

  it("puts the practice and the role on the session, which is how §5.2 reaches every route", () => {
    const user = { id: "cuser0000000000000000000a", email: "maya@practice.com", name: "Dr Maya", role: "clinician", practiceId: "cprac0000000000000000000a" };
    const session = { user: { email: "stale@practice.com", image: null }, expires: "2026-10-20T09:00:00.000Z" };
    // The default callback returns name, email and image only; a guard needs the id, the practice and the role.
    const out = auth.authConfig.callbacks!.session!({ session, user, token: {}, newSession: {}, trigger: "update" } as never) as unknown as { user: typeof user };
    assert.equal(out.user.id, user.id);
    assert.equal(out.user.role, "clinician");
    assert.equal(out.user.practiceId, user.practiceId);
    assert.equal(out.user.email, "maya@practice.com", "the row wins over whatever was on the session");
  });

  it("logs a sign-in and a sign-out by user id and nothing else (§10.3)", async () => {
    const lines: Record<string, unknown>[] = [];
    setLogSink((_level, line) => lines.push(JSON.parse(line)));
    try {
      await auth.authConfig.events!.signIn!({ user: { id: "cuser0000000000000000000a", email: "maya@practice.com" } } as never);
      await auth.authConfig.events!.signOut!({ session: Promise.resolve({ userId: "cuser0000000000000000000a" }) } as never);
    } finally {
      setLogSink();
    }
    assert.deepEqual(lines.map((l) => l.event), ["provider_signed_in", "provider_signed_out"]);
    assert.deepEqual(lines.map((l) => l.userId), ["cuser0000000000000000000a", "cuser0000000000000000000a"]);
    assert.equal(JSON.stringify(lines).includes("maya@practice.com"), false, "an address is never a field");
  });

  it("sends the link through the mailer, and says nothing about where it went", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devmail-auth-"));
    const env = { ...process.env };
    const provider = auth.authConfig.providers[0] as unknown as { sendVerificationRequest: (p: { identifier: string; url: string }) => Promise<void> };
    try {
      process.env.DEV_MAIL_DIR = dir;
      setLogSink(() => {});
      await provider.sendVerificationRequest({ identifier: "maya@practice.com", url: LINK });
      assert.equal(linkIn(readDevMail(dir)[0].text), LINK);
    } finally {
      setLogSink();
      process.env = env;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the link could not be sent, so sign-in shows an error instead of check-email", async () => {
    const env = { ...process.env };
    const provider = auth.authConfig.providers[0] as unknown as { sendVerificationRequest: (p: { identifier: string; url: string }) => Promise<void> };
    try {
      process.env.EMAIL_PROVIDER = "ses";
      delete process.env.DEV_MAIL_DIR;
      delete process.env.EMAIL_FROM; // SES with no verified sender fails before any network call
      setLogSink(() => {});
      await assert.rejects(provider.sendVerificationRequest({ identifier: "maya@practice.com", url: LINK }), /EMAIL_FROM/);
    } finally {
      setLogSink();
      process.env = env;
    }
  });

  it("refuses to mint a demo sign-in link with no secret to sign it with (§13.4)", async () => {
    // NODE_ENV is typed read-only, and lib/auth.ts reads process.env rather than taking an env object the
    // way lib/config.ts does, so this is the only way to ask it what a deployment would answer.
    const env = process.env as Record<string, string | undefined>;
    const saved = { secret: env.AUTH_SECRET, other: env.NEXTAUTH_SECRET, env: env.NODE_ENV };
    try {
      delete env.AUTH_SECRET;
      delete env.NEXTAUTH_SECRET;
      env.NODE_ENV = "production";
      // A production deployment has no development fallback, and a link signed with a known constant is not
      // signed. It fails before writing the VerificationToken row, so this needs no database.
      await assert.rejects(auth.mintSignInUrl("demo@sweetspot.local", new URL("https://sweetspot.example")), /AUTH_SECRET is not set/);
    } finally {
      if (saved.secret === undefined) delete env.AUTH_SECRET;
      else env.AUTH_SECRET = saved.secret;
      if (saved.other === undefined) delete env.NEXTAUTH_SECRET;
      else env.NEXTAUTH_SECRET = saved.other;
      if (saved.env === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = saved.env;
    }
  });
});
