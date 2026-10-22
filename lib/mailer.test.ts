import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { devMailDir } from "./devMailbox";
import { canSendOrMailbox, INVITE_SUBJECT, inviteEmailText, sendOrMailbox, signInEmailText, signInUrlFor, SIGN_IN_SUBJECT } from "./mailer";

// Where the two messages the flow cannot continue without go: a provider's sign-in link (design §5.1) and a
// patient's six-digit code (§2.3, §5.3). Both go through `sendOrMailbox`, so this is about the one decision
// it makes — divert, send, or neither — and in particular about the answer a caller gets for "neither".
//
// That third case is T113. `sendOrMailbox` used to treat "no backend configured" as a second reason to
// divert, so a deployment that had set nothing up wrote both credentials to ./.mail/ on the server and
// returned `{ sent: true, provider: "dev-mailbox" }`. The templates themselves are lib/auth.test.ts's.

/** Everything that can decide what this module does — the cloud sandbox has the AWS pair ambient, and the
 *  check script exports DEV_MAIL_DIR for the whole run, so neither is any case's input unless it says so. */
const KEYS = ["DEV_MAIL_DIR", "EMAIL_PROVIDER", "EMAIL_FROM", "RESEND_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const before = KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    return run();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A mailbox in a throwaway directory. Awaited before it is removed, or the cleanup races the send. */
async function mailbox(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mailer-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with nothing configured and nowhere to divert to, a sign-in link is not sent and does not claim to be (T113)", async () => {
  const result = await withEnv({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" }, () =>
    sendOrMailbox("someone@practice.test", SIGN_IN_SUBJECT, signInEmailText("https://sweetspot.example/signin?token=abc", 15)),
  );

  assert.equal(result.sent, false);
  // No `provider`, which is the load-bearing half: `assertSendable` (lib/jobHandlers.ts) counts the job done
  // rather than spending three attempts on an error no attempt can fix, and `statusOf` (lib/visitStore.ts)
  // records `skipped` rather than `failed`. It is the senders' own contract (lib/email.ts, lib/sms.ts).
  assert.equal(result.provider, undefined, "nothing was reached, so there is no backend to name or to retry");
  assert.equal(result.target, undefined, "and nothing was written anywhere, so there is nowhere to point at");
  assert.match(result.error!, /not configured/);
  // The ambient AWS pair is not an email backend (T110) and is not a mailbox either, so it changes nothing.
});

test("nothing is written to disk by a send that had nowhere to go", async () => {
  // The directory to watch is the one the regression wrote to: `devMailDir`'s own default, `./.mail`
  // relative to the process's cwd (lib/devMailbox.ts), which is where a `!hasBackend` arm would put the
  // code with `DEV_MAIL_DIR` unset. A throwaway directory nothing can name stays empty whatever this
  // module does, so watching one would assert nothing about the thing this test is named for.
  const fallback = devMailDir({});
  const before = existsSync(fallback) ? readdirSync(fallback) : null;
  const result = await withEnv({}, () => sendOrMailbox("maya@practice.test", "Your code is 480913", "480913"));
  assert.equal(result.sent, false);
  const after = existsSync(fallback) ? readdirSync(fallback) : null;
  assert.deepEqual(after, before, "the code is not in the mailbox a fallback would have written it to");
});

test("naming a directory is what diverts, and the result says where it landed", async () => {
  await mailbox(async (dir) => {
    const result = await withEnv({ DEV_MAIL_DIR: dir }, () => sendOrMailbox("maya@practice.test", "Your code is 480913", "480913"));
    assert.deepEqual(result, { sent: true, provider: "dev-mailbox", target: dir });
    // The directory and not the filename: scrub() in lib/log.ts reads a timestamped name as a phone number.
    const [file] = readdirSync(dir);
    assert.match(file, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-your-code-is-480913\.txt$/);
  });
});

test("a named directory still wins over a configured backend, so a key in the environment sends nothing", async () => {
  // The other half of the rule, unchanged by T113: this is what `npm run dev` on a machine with AWS
  // credentials needs, and what keeps the e2e suite from mailing a sign-in link through SES (§8.1).
  await mailbox(async (dir) => {
    const result = await withEnv({ DEV_MAIL_DIR: dir, EMAIL_FROM: "clinic@sweetspot.example" }, () =>
      sendOrMailbox("maya@practice.test", INVITE_SUBJECT, inviteEmailText({ practiceName: "Bay Endocrine", invitedBy: "Dr Reed", role: "clinician", url: signInUrlFor("maya@practice.test") })),
    );
    assert.equal(result.provider, "dev-mailbox");
    assert.equal(readdirSync(dir).length, 1);
  });
});

test("canSendOrMailbox is the question a screen asks before it promises anything", () => {
  // A mailbox counts, because a code written to a file really is readable — `npm run mail`, e2e/patient.ts —
  // which is what makes the product walkable with no backend at all (§11.3). This is the whole difference
  // from `emailConfig`, and it is why the code screen and the booking wizard ask different questions: an
  // invite goes straight to `sendEmail` (lib/notify.ts), so for that one the mailbox is not an answer.
  assert.equal(withEnv({ DEV_MAIL_DIR: ".mail" }, canSendOrMailbox), true);
  assert.equal(withEnv({ EMAIL_FROM: "clinic@sweetspot.example" }, canSendOrMailbox), true, "a verified identity is a backend");
  assert.equal(withEnv({ RESEND_API_KEY: "re_test" }, canSendOrMailbox), true);
  assert.equal(withEnv({}, canSendOrMailbox), false);
  // T110's case, which is the one this ticket is downstream of: a credential selects no backend, so an
  // environment carrying only the sandbox's ambient pair has nowhere to put a message.
  assert.equal(withEnv({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" }, canSendOrMailbox), false);
  // Forced to a backend whose own setting is missing is unconfigured, not an attempt (lib/email.ts).
  assert.equal(withEnv({ EMAIL_PROVIDER: "ses" }, canSendOrMailbox), false);
  assert.equal(withEnv({ EMAIL_PROVIDER: "resend" }, canSendOrMailbox), false);
});
