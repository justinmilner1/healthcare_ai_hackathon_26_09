// Where a sign-in magic link, and an invite into a practice, go (design §5.1, §2.1). Owner: identity.
//
//   DEV_MAIL_DIR is set             -> the local mailbox in lib/devMailbox.ts, read with `npm run mail`
//   an email backend is configured  -> send it (SES in production and staging; Resend locally if someone has
//                                      a key, see lib/email.ts)
//   neither                         -> the local mailbox again; there is nothing to send with
//
// The log line records that a link was sent and through what. Never the address and never the URL: the URL is
// a bearer credential and §10.3 keeps link tokens out of the log.

import { roleDescription, roleLabel, type Role } from "./access";
import { emailProvider, sendEmail, type SendResult } from "./email";
import { devMailDir, divertsMail, writeDevMail } from "./devMailbox";
import { log } from "./log";

export const SIGN_IN_SUBJECT = "Your Sweet Spot sign-in link";
export const INVITE_SUBJECT = "You have been added to a Sweet Spot workspace";

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
  if (divertsMail(process.env, Boolean(emailProvider()))) {
    writeDevMail({ to, subject: SIGN_IN_SUBJECT, text });
    // The directory, not the filename: scrub() reads a timestamped filename as a phone number and redacts it.
    log.info("signin_link_sent", { channel: "email", provider: "dev-mailbox", sent: true, target: devMailDir() });
    return { sent: true, provider: "dev-mailbox" };
  }
  const result = await sendEmail(to, SIGN_IN_SUBJECT, text);
  log.info("signin_link_sent", { channel: "email", provider: result.provider, sent: result.sent, error: result.error });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Joining a practice (§2.1). The invite is the User row (lib/team.ts); this is only the nudge that tells
// someone to go and sign in. It carries no token of its own, so forwarding it gives nothing away — whoever
// opens it still has to receive a magic link at the invited address.

/** Where an invited person goes: the normal sign-in form, with their address already in the box. */
export function signInUrlFor(email: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/provider/signin?email=${encodeURIComponent(email)}`;
}

/** The body of the invite email. Who added them, what they can do, where to go. Nothing clinical (§8.2). */
export function inviteEmailText(p: { practiceName: string; invitedBy: string; role: Role; url: string }): string {
  return [
    `${p.invitedBy} added you to ${p.practiceName} on Sweet Spot as ${roleLabel(p.role).toLowerCase()}.`,
    "",
    roleDescription(p.role),
    "",
    "Sign in here with this address and we will email you a one-time link:",
    p.url,
    "",
    "There is no password to pick. If you were not expecting this, ignore the email — this message on its own",
    "does not sign anyone in.",
    "",
    "Sweet Spot",
  ].join("\n");
}

export async function sendTeamInvite(to: string, p: { practiceName: string; invitedBy: string; role: Role }): Promise<SendResult> {
  const text = inviteEmailText({ ...p, url: signInUrlFor(to) });
  if (divertsMail(process.env, Boolean(emailProvider()))) {
    writeDevMail({ to, subject: INVITE_SUBJECT, text });
    log.info("team_invite_sent", { channel: "email", provider: "dev-mailbox", sent: true, role: p.role, target: devMailDir() });
    return { sent: true, provider: "dev-mailbox" };
  }
  const result = await sendEmail(to, INVITE_SUBJECT, text);
  log.info("team_invite_sent", { channel: "email", provider: result.provider, sent: result.sent, role: p.role, error: result.error });
  return result;
}
