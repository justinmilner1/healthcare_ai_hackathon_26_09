// Where a sign-in magic link, and an invite into a practice, go (design §5.1, §2.1). Owner: identity.
//
//   DEV_MAIL_DIR is set             -> the local mailbox in lib/devMailbox.ts, read with `npm run mail`
//   an email backend is configured  -> send it (SES in production and staging; Resend locally if someone has
//                                      a key, see lib/email.ts)
//   neither                         -> nothing is sent: `{ sent: false, error }` with no `provider`, which
//                                      is the senders' own contract for an environment that cannot send
//                                      (lib/email.ts). The mailbox is not a fallback this lands in — it
//                                      would be a patient's code and a provider's sign-in link written to
//                                      disk on a deployment and reported sent (T113, §10.6).
//
// The log line records that a link was sent and through what. Never the address and never the URL: the URL is
// a bearer credential and §10.3 keeps link tokens out of the log.

import { roleDescription, roleLabel, type Role } from "./access";
import { demoBlockReason } from "./demo";
import { emailConfig, sendEmail, type SendResult } from "./email";
import { devMailDir, divertsMail, writeDevMail } from "./devMailbox";
import { log } from "./log";

export const SIGN_IN_SUBJECT = "Your Sweet Spot sign-in link";
export const INVITE_SUBJECT = "You have been added to a Sweet Spot workspace";

/**
 * Send one message, or write it to the local mailbox where this environment has asked for that.
 *
 * The two messages the flow cannot continue without go through here — a provider's sign-in link (§5.1) and a
 * patient's verification code (§5.3) — so that naming `DEV_MAIL_DIR` makes both of them readable offline and
 * the whole product walkable with no backend at all (§11.3). Everything else (invites, summary links) fails
 * soft and the UI shows the link.
 *
 * With neither a directory to divert to nor a backend to send with, this answers the way every other sender
 * does: `{ sent: false, error }` and no `provider`, so `assertSendable` (lib/jobHandlers.ts) counts the job
 * done rather than retrying an error no attempt can fix, and `statusOf` (lib/visitStore.ts) records
 * `skipped` rather than `failed`. It used to write to `./.mail/` and answer `sent: true` instead (T113).
 */
export async function sendOrMailbox(to: string, subject: string, text: string): Promise<SendResult> {
  if (divertsMail()) {
    writeDevMail({ to, subject, text });
    // The directory, not the filename: scrub() reads a timestamped filename as a phone number and redacts it.
    return { sent: true, provider: "dev-mailbox", target: devMailDir() };
  }
  return sendEmail(to, subject, text);
}

/**
 * Whether `sendOrMailbox` has anywhere to put a message: a mailbox to divert to, or a backend to send with.
 *
 * Settled from the environment, with no client built and no network call — the shape `emailConfig` and
 * `smsConfig` already have (lib/email.ts, lib/sms.ts, T94/T110) — so a screen can ask it while the patient
 * is still looking at it. It is deliberately a different question from `emailConfig`'s: the mailbox is a
 * place a code really can be read from (`npm run mail`, e2e/patient.ts), so an offline checkout is sendable
 * on this path and is not sendable on the invite's, which goes straight to `sendEmail` (§8.1).
 *
 * Not a prediction that the message arrives: a configured backend can still bounce, and a suppressed
 * address or a demo practice closes a channel on facts that live on the row (§8.1, §13.4). This is the
 * narrower question — is there anywhere at all for it to go.
 */
export function canSendOrMailbox(): boolean {
  return divertsMail() || !("reason" in emailConfig());
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

/**
 * `demo` is §13.4: a practice marked synthetic may only write to a reserved address (lib/demo.ts), so an
 * admin who seeds a demo practice and then invites a colleague's real work address does not email it. The
 * row is still created — an invite *is* the User row (lib/team.ts) — so they sign in by asking for their own
 * link; this is the nudge, not the credential.
 *
 * The sign-in link itself (sendSignInLink above) is not gated, because nobody sends it: it goes only to an
 * address that has just asked for it, from the form, and gating it would lock a demo practice's own admin out
 * of the practice they made.
 */
export async function sendTeamInvite(to: string, p: { practiceName: string; invitedBy: string; role: Role; demo?: boolean }): Promise<SendResult> {
  const blocked = demoBlockReason(Boolean(p.demo), "email", to);
  if (blocked) {
    log.info("team_invite_sent", { channel: "email", sent: false, role: p.role, error: blocked, demo: true });
    return { sent: false, error: blocked };
  }
  const text = inviteEmailText({ ...p, url: signInUrlFor(to) });
  if (divertsMail()) {
    writeDevMail({ to, subject: INVITE_SUBJECT, text });
    log.info("team_invite_sent", { channel: "email", provider: "dev-mailbox", sent: true, role: p.role, target: devMailDir() });
    return { sent: true, provider: "dev-mailbox" };
  }
  const result = await sendEmail(to, INVITE_SUBJECT, text);
  log.info("team_invite_sent", { channel: "email", provider: result.provider, sent: result.sent, role: p.role, error: result.error });
  return result;
}
