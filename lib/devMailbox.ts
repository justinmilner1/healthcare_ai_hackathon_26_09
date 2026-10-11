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
// the e2e suite reads the same directory to click the link (e2e/auth.ts). It is only ever reached when no
// email backend is configured (lib/mailer.ts decides); in production SES sends the mail and nothing is
// written here.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DevMail = { to: string; subject: string; text: string };
export type StoredDevMail = DevMail & { file: string; at: string };

/** Where the mailbox lives. `DEV_MAIL_DIR` is for the e2e suite, which keeps its own under e2e/. */
export function devMailDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEV_MAIL_DIR?.trim() || ".mail";
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

/** Write one message and return the path it landed at. */
export function writeDevMail(mail: DevMail, dir = devMailDir(), now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, devMailFilename(mail.subject, now));
  writeFileSync(file, formatDevMail(mail, now), "utf8");
  return file;
}

/** The messages in the mailbox, oldest first. Missing directory means an empty mailbox, not an error. */
export function readDevMail(dir = devMailDir()): StoredDevMail[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = join(dir, name);
    const raw = readFileSync(file, "utf8");
    return { file, at: header(raw, "Date"), to: header(raw, "To"), subject: header(raw, "Subject"), text: raw.split("\n\n").slice(1).join("\n\n") };
  });
}

function header(raw: string, name: string): string {
  return raw.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1]?.trim() ?? "";
}

/** The first http(s) URL in a message body. What the e2e suite and `npm run mail` need from a sign-in mail. */
export function linkIn(text: string): string | null {
  return text.match(/https?:\/\/\S+/)?.[0] ?? null;
}
