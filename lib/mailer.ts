// Where a sign-in magic link goes (design §5.1). Owner: identity.
//
//   an email backend is configured  -> send it (SES in production and staging; Resend locally if someone has
//                                      a key, see lib/email.ts)
//   nothing is configured           -> the local mailbox in lib/devMailbox.ts, read with `npm run mail`
//
// The log line records that a link was sent and through what. Never the address and never the URL: the URL is
// a bearer credential and §10.3 keeps link tokens out of the log.

import { emailProvider, sendEmail, type SendResult } from "./email";
import { devMailDir, writeDevMail } from "./devMailbox";
import { log } from "./log";

export const SIGN_IN_SUBJECT = "Your Sweet Spot sign-in link";

/** The body of the sign-in email. Plain text; no clinical content, a link only (§8.2). */
export function signInEmailText(url: string, minutes: number): string {
  return [
    "Someone asked for a sign-in link to the Sweet Spot provider workspace with this address.",
    "",
    "Open this link to sign in:",
    url,
    "",
    `The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email —`,
    "nobody can sign in without the link.",
    "",
    "Sweet Spot",
  ].join("\n");
}

export async function sendSignInLink(to: string, url: string, minutes: number): Promise<SendResult> {
  const text = signInEmailText(url, minutes);
  if (!emailProvider()) {
    writeDevMail({ to, subject: SIGN_IN_SUBJECT, text });
    // The directory, not the filename: scrub() reads a timestamped filename as a phone number and redacts it.
    log.info("signin_link_sent", { channel: "email", provider: "dev-mailbox", sent: true, target: devMailDir() });
    return { sent: true, provider: "dev-mailbox" };
  }
  const result = await sendEmail(to, SIGN_IN_SUBJECT, text);
  log.info("signin_link_sent", { channel: "email", provider: result.provider, sent: result.sent, error: result.error });
  return result;
}
