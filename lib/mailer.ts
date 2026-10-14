// Where a sign-in magic link goes (design §5.1). Owner: identity.
//
//   DEV_MAIL_DIR is set             -> the local mailbox in lib/devMailbox.ts, read with `npm run mail`
//   an email backend is configured  -> send it (SES in production and staging; Resend locally if someone has
//                                      a key, see lib/email.ts)
//   neither                         -> the local mailbox again; there is nothing to send with
//
// The log line records that a link was sent and through what. Never the address and never the URL: the URL is
// a bearer credential and §10.3 keeps link tokens out of the log.

import { emailProvider, sendEmail, type SendResult } from "./email";
import { devMailDir, divertsMail, writeDevMail } from "./devMailbox";
import { log } from "./log";

export const SIGN_IN_SUBJECT = "Your Sweet Spot sign-in link";

/**
 * Send one message, or write it to the local mailbox when there is nothing to send with. For the two
 * messages the flow cannot continue without — a provider's sign-in link (§5.1) and a patient's verification
 * code (§5.3) — "not configured" has to still deliver somewhere a developer and the e2e suite can read, or
 * neither sign-in works offline at all. Everything else (invites, summary links) fails soft instead and the
 * UI shows the link.
 */
export async function sendOrMailbox(to: string, subject: string, text: string): Promise<SendResult> {
  if (divertsMail(process.env, Boolean(emailProvider()))) {
    writeDevMail({ to, subject, text });
    // The directory, not the filename: scrub() reads a timestamped filename as a phone number and redacts it.
    return { sent: true, provider: "dev-mailbox", target: devMailDir() };
  }
  return sendEmail(to, subject, text);
}

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
  const result = await sendOrMailbox(to, SIGN_IN_SUBJECT, signInEmailText(url, minutes));
  log.info("signin_link_sent", { channel: "email", provider: result.provider, sent: result.sent, target: result.target, error: result.error });
  return result;
}
