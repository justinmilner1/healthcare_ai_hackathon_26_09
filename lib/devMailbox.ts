// The local stand-in for an email provider (design §5.1: "SES in production and a console mailer locally").
// Owner: identity.
//
// A sign-in magic link is a bearer credential, and §10.3 forbids link tokens in the application log — the
// allow-list in lib/log.ts would drop or redact the URL anyway, and `npm run lint` plus lib/log.test.ts
// forbid writing to stdout from app code. So the local mailer writes each message to a file instead:
//
//   .mail/2026-10-11T09-14-02-123Z-provider-signin.txt      (gitignored)
//
// `npm run mail` prints the newest one in the terminal, which is the console half of the console mailer, and
// the e2e suite reads the same directory to click the link (e2e/auth.ts). It is reached only where
// `DEV_MAIL_DIR` says so (`divertsMail` below); in production SES sends the mail and nothing is written here.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DevMail = { to: string; subject: string; text: string };
/** Only the one variable matters here, so a test can pass it without building a whole environment. */
export type MailEnv = { DEV_MAIL_DIR?: string | undefined; [key: string]: string | undefined };
export type StoredDevMail = DevMail & { file: string; at: string };

/**
 * Where the mailbox lives. `DEV_MAIL_DIR` is for the e2e suite, which keeps its own under e2e/.
 *
 * The `.mail` fallback is a reader's default — `npm run mail` on a checkout of `.env.example`, which sets
 * the variable to exactly that — and not a place anything is written to by default: nothing writes here
 * unless `divertsMail` said so, and that is the variable being set (T113).
 */
export function devMailDir(env: MailEnv = process.env): string {
  return env.DEV_MAIL_DIR?.trim() || ".mail";
}

/**
 * Whether to divert mail here instead of sending it: one question, with one answer, and `DEV_MAIL_DIR` is
 * it. Setting the variable says so outright, which is what the e2e suite and `npm run dev` on a machine that
 * happens to have AWS credentials in the environment need — otherwise lib/email.ts would pick SES up and try
 * to send a sign-in link through an unverified identity.
 *
 * What it is not, since T113: a fallback for "no backend configured". That arm used to divert here too, so a
 * deployment with no email backend and no `DEV_MAIL_DIR` wrote every patient's six-digit code and every
 * provider's sign-in link into `./.mail/` on the server and reported them sent — an outage whose leftovers
 * are bearer credentials (§10.6), reported as a success, which is the one shape of failure nobody looks for.
 * The deployment that has not set a backend up now gets the senders' own contract instead ("Unconfigured ->
 * { sent: false, error }", lib/email.ts), lib/config.ts refuses to serve on a public URL without one, and
 * the mailbox is a thing a developer opts into by naming a directory.
 */
export function divertsMail(env: MailEnv = process.env): boolean {
  return Boolean(env.DEV_MAIL_DIR?.trim());
}

/** `<sortable timestamp>-<slug>.txt`. The timestamp leads so a plain sort is newest-last. */
export function devMailFilename(subject: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "message";
  return `${stamp}-${slug}.txt`;
}

/** The whole message as a developer wants to read it: headers, a blank line, then the body. */
export function formatDevMail(mail: DevMail, now = new Date()): string {
  return [`Date: ${now.toISOString()}`, `To: ${mail.to}`, `Subject: ${mail.subject}`, "", mail.text, ""].join("\n");
}

/**
 * Write one message and return the path it landed at.
 *
 * The name is the time and the subject, and nothing else — so two messages with one subject written in the
 * same millisecond ask for one filename, and a plain `writeFileSync` would truncate the first away. What is
 * lost that way is a credential: every provider sign-in mail is titled "Your Sweet Spot sign-in link", a
 * magic link is good once (design §5.1), and the suite signs the seeded demo provider in from two workers
 * against one mailbox. Overwriting one leaves a reader waiting for a link that no longer exists anywhere —
 * `e2e/auth.ts` claims each mail it spends, so the loss is permanent and the shortfall is simply passed on
 * until some test gives up with "no sign-in link arrived" (T85).
 *
 * `wx` is the fix: it refuses to open a file that is already there, so a collision takes the next free name
 * instead of a victim. The suffix goes before `.txt`, because that extension is what every reader lists on.
 */
export function writeDevMail(mail: DevMail, dir = devMailDir(), now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const name = devMailFilename(mail.subject, now);
  const body = formatDevMail(mail, now);
  // Bounded only so a filesystem refusing every name cannot spin here; one millisecond never holds this many
  // messages, and the throw below says what happened rather than looping in silence.
  for (let n = 0; n < 1000; n++) {
    const file = join(dir, n === 0 ? name : name.replace(/\.txt$/, `-${n}.txt`));
    try {
      writeFileSync(file, body, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`dev mailbox: no free filename for ${name} after 1000 tries`);
}

/**
 * One message's raw text, or null when the file has gone between a listing and this read.
 *
 * A mailbox is shared and something in it moves: e2e/auth.ts renames the sign-in mail a test claims, so two
 * tests cannot redeem one single-use magic link (design §5.1). Every other walker of the same directory can
 * therefore list a name whose file is already `.claimed` by the time it reads it, and an unguarded
 * `readFileSync` throws ENOENT over a message it did not even want (T65).
 *
 * Only ENOENT, though. A mailbox hands out credentials — `npm run mail` prints a sign-in link — so a message
 * that is there but unreadable (a permission change, a bad disk) must not read as one that was claimed: that
 * would quietly answer with an older link, or with no mail at all, and leave a caller to time out against a
 * mailbox nobody can open. The disappearance is the one expected failure; everything else is news.
 */
export function readDevMailFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Gone, as opposed to unreadable — the one failure a shared mailbox produces on its own. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * The newest message in these mailboxes addressed to `to` that `pick` makes something of, or null.
 *
 * One walk for every reader of a mailbox, so the guard above is in one place rather than in each of them.
 * The order is newest first, across all the directories at once: a mailbox file is named for the time it was
 * written (devMailFilename), so one sort over the names interleaves several boxes correctly. A directory no
 * server has written to yet simply is not there, which is an empty mailbox rather than a failure.
 *
 * `pick` is handed the message text and its path, and answers what the caller wanted out of it or null to
 * keep looking. Returning null is also how a claim that lost a race declines a message: `pick` may rename
 * the file it is offered, and answer null when the rename fails because someone else got there first.
 */
export function findDevMail<T>(dirs: string[], to: string, pick: (raw: string, path: string) => T | null): T | null {
  const files: { name: string; path: string }[] = [];
  for (const dir of new Set(dirs)) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".txt")) files.push({ name, path: join(dir, name) });
      }
    } catch (error) {
      // A mailbox a server has not written to yet simply is not there. One that is there and will not open
      // is not an empty mailbox, and saying it is would lose every message in it in silence.
      if (!isMissing(error)) throw error;
    }
  }
  files.sort((a, b) => b.name.localeCompare(a.name));
  // An address is not a pattern: `nurse+demo@...` would otherwise match half the mailbox.
  const addressed = `To: ${to}`;
  for (const file of files) {
    const raw = readDevMailFile(file.path);
    if (raw === null) continue; // claimed and renamed between the listing and the read
    if (!raw.split("\n").includes(addressed)) continue;
    const found = pick(raw, file.path);
    if (found !== null) return found;
  }
  return null;
}

/** The messages in the mailbox, oldest first. Missing directory means an empty mailbox, not an error. */
export function readDevMail(dir = devMailDir()): StoredDevMail[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
  } catch (error) {
    if (!isMissing(error)) throw error;
    return [];
  }
  const mail: StoredDevMail[] = [];
  for (const name of names) {
    const file = join(dir, name);
    // `npm run mail` reads this while the e2e suite is claiming links out of the same directory, so a listed
    // name can be gone already (readDevMailFile). One message short beats the whole mailbox throwing.
    const raw = readDevMailFile(file);
    if (raw === null) continue;
    mail.push({ file, at: header(raw, "Date"), to: header(raw, "To"), subject: header(raw, "Subject"), text: raw.split("\n\n").slice(1).join("\n\n") });
  }
  return mail;
}

function header(raw: string, name: string): string {
  return raw.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
}

/** The first http(s) URL in a message body. What the e2e suite and `npm run mail` need from a sign-in mail. */
export function linkIn(text: string): string | null {
  return text.match(/https?:\/\/\S+/)?.[0] ?? null;
}
