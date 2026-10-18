import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findDevMail, readDevMail, readDevMailFile, writeDevMail } from "./devMailbox";

// The mailbox is the local stand-in for an email provider, and it is shared: `npm run mail`, the e2e suite's
// code reader (e2e/patient.ts) and its sign-in claimer (e2e/auth.ts) all walk the same directories, and the
// claimer renames the file it takes so one single-use magic link cannot be redeemed twice (design §5.1).
// These tests are about what that costs every other reader — a listed name whose file is already gone (T65).
//
// The round trip of one message (names, headers, body) is lib/auth.test.ts's, next to the mailer that writes
// it. What is here is the walk.

const PATIENT = "maya.7f3a@example.test";
const PROVIDER = "demo@sweetspot.local";
const SIGN_IN = "http://localhost:3100/api/auth/callback/email?token=abc123&email=demo%40sweetspot.local";

/** latestCode's predicate (e2e/patient.ts), so these tests walk for what the suite actually walks for. */
const codeIn = (raw: string) => raw.match(/^Subject: Your code is (\d{6})$/m)?.[1] ?? null;

/** A mailbox in a throwaway directory, with the message times spaced so the sort is predictable. */
function mailbox(run: (dir: string, at: (seconds: number) => Date) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "devmail-walk-"));
  const start = new Date("2026-10-15T15:53:31.874Z").getTime();
  try {
    run(dir, (seconds) => new Date(start + seconds * 1000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a mail claimed between the listing and the read is skipped, and the walk goes on to find the code (T65)", () => {
  mailbox((dir, at) => {
    // Newest last in time, so the walk sees these in reverse: the decoy, then the sign-in mail, then the code.
    writeDevMail({ to: PATIENT, subject: "Your code is 480913", text: "Use it within 10 minutes." }, dir, at(0));
    const claimed = writeDevMail({ to: PROVIDER, subject: "Your Sweet Spot sign-in link", text: SIGN_IN }, dir, at(1));
    writeDevMail({ to: PATIENT, subject: "Sweet Spot", text: "no code in this one" }, dir, at(2));

    // The race, run on purpose rather than waited for: the decoy's turn comes first, and while the walk is
    // holding it another worker claims the sign-in mail — exactly what e2e/auth.ts's claimSignInLink does to
    // this directory. The walk has already listed that name, so its read is the one that would throw ENOENT.
    const code = findDevMail([dir], PATIENT, (raw) => {
      if (raw.includes("no code in this one")) renameSync(claimed, `${claimed}.claimed`);
      return codeIn(raw);
    });

    assert.equal(code, "480913");
  });
});

test("a mail that vanishes reads as absent, not as an error", () => {
  mailbox((dir) => {
    assert.equal(readDevMailFile(join(dir, "2026-10-15T15-53-31-874Z-gone.txt")), null);
    // A dangling link is a name a listing still offers after the file behind it has moved on.
    symlinkSync(join(dir, "already-claimed.txt"), join(dir, "2026-10-15T15-53-32-000Z-dangling.txt"));
    assert.equal(readDevMailFile(join(dir, "2026-10-15T15-53-32-000Z-dangling.txt")), null);
  });
});

test("a message that is there but will not open is news, not a claim", () => {
  mailbox((dir, at) => {
    writeDevMail({ to: PATIENT, subject: "Your code is 480913", text: "Use it within 10 minutes." }, dir, at(0));
    // Unreadable rather than gone. A mailbox hands out credentials, so answering "claimed" here would hand
    // back the older code and say nothing about the mailbox nobody can open.
    mkdirSync(join(dir, "2026-10-15T15-54-31-874Z-unreadable.txt"));

    assert.throws(() => findDevMail([dir], PATIENT, codeIn), /EISDIR/);
    assert.throws(() => readDevMail(dir), /EISDIR/);
    assert.throws(() => readDevMailFile(join(dir, "2026-10-15T15-54-31-874Z-unreadable.txt")), /EISDIR/);
  });
});

test("readDevMail returns the mail it can read instead of throwing on the one it cannot", () => {
  mailbox((dir, at) => {
    writeDevMail({ to: PROVIDER, subject: "Your Sweet Spot sign-in link", text: SIGN_IN }, dir, at(0));
    symlinkSync(join(dir, "already-claimed.txt"), join(dir, "2026-10-15T15-53-40-000Z-claimed-mid-read.txt"));
    writeDevMail({ to: PATIENT, subject: "Your code is 112233", text: "Use it within 10 minutes." }, dir, at(60));

    assert.deepEqual(
      readDevMail(dir).map((m) => m.subject),
      ["Your Sweet Spot sign-in link", "Your code is 112233"],
    );
  });
});

test("the newest addressed mail wins, across every mailbox the walk is given", () => {
  mailbox((dir, at) => {
    // A code is written by whichever server drains the `notify.code` job, into that server's own box, which
    // is why e2e/patient.ts hands the walk all of them (its MAIL_DIRS).
    const other = join(dir, "degraded");
    writeDevMail({ to: PATIENT, subject: "Your code is 111111", text: "older" }, dir, at(0));
    writeDevMail({ to: PATIENT, subject: "Your code is 222222", text: "newer, in the other box" }, other, at(30));
    // A claim renames the newest one out of the way, and `.claimed` does not end in .txt, so it is not offered.
    const spent = writeDevMail({ to: PATIENT, subject: "Your code is 333333", text: "newest, already claimed" }, dir, at(60));
    renameSync(spent, `${spent}.claimed`);

    // A box that was passed twice is walked once, and a box no server has written to is an empty one.
    assert.equal(findDevMail([dir, other, dir, join(dir, "never-written-to")], PATIENT, codeIn), "222222");
  });
});

test("an address is not a pattern, and a walk that finds nothing says so", () => {
  mailbox((dir, at) => {
    writeDevMail({ to: `nurse+${PATIENT}`, subject: "Your code is 999999", text: "somebody else's" }, dir, at(0));

    assert.equal(findDevMail([dir], PATIENT, codeIn), null);
    // A mailbox no server has written to is an empty one, which is the one listing failure that is expected.
    assert.equal(findDevMail([join(dir, "no-such-mailbox")], PATIENT, codeIn), null);
    assert.deepEqual(readDevMail(join(dir, "no-such-mailbox")), []);
    assert.equal(findDevMail([dir], `nurse+${PATIENT}`, codeIn), "999999");
  });
});

test("two messages with one subject in one millisecond are both kept, so neither link is lost (T85)", () => {
  mailbox((dir, at) => {
    // The e2e suite signs the one seeded provider in from two workers against one mailbox, and every one of
    // those mails is titled "Your Sweet Spot sign-in link" (lib/mailer.ts). The filename is the time and the
    // subject, so a shared millisecond asks twice for one name — and a magic link is good once (design
    // §5.1), so the message that loses is a credential nobody can get back. e2e/auth.ts claims each link it
    // spends, so the shortfall is permanent: it is handed on until a test gives up waiting for a link that
    // was overwritten before it ever looked.
    const first = writeDevMail({ to: PROVIDER, subject: "Your Sweet Spot sign-in link", text: `${SIGN_IN}&n=first` }, dir, at(0));
    const second = writeDevMail({ to: PROVIDER, subject: "Your Sweet Spot sign-in link", text: `${SIGN_IN}&n=second` }, dir, at(0));
    assert.notEqual(first, second, "the second message took the first one's filename");

    // Both are in the mailbox, and claiming one the way e2e/auth.ts does still leaves the other to be found.
    const tokens = new Set(readDevMail(dir).map((mail) => mail.text.match(/&n=(\w+)/)?.[1]));
    assert.deepEqual(tokens, new Set(["first", "second"]));

    const claim = (raw: string, path: string) => {
      const n = raw.match(/&n=(\w+)/)?.[1];
      if (!n) return null;
      try {
        renameSync(path, `${path}.claimed`);
      } catch {
        return null;
      }
      return n;
    };
    const one = findDevMail([dir], PROVIDER, claim);
    const other = findDevMail([dir], PROVIDER, claim);
    assert.ok(one && other, "a second claimer found nothing left to claim");
    assert.notEqual(one, other, "both claimers were handed the same single-use link");
  });
});
