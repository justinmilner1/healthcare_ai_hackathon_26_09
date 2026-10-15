// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { appUrl } from "./config";
import { sendEmail, type SendResult } from "./email";
import { log } from "./log";
import { sendOrMailbox } from "./mailer";
import { intakeLink, sendSms } from "./sms";
import { suppressedReason, type NotifyChannel, type SuppressionFacts } from "./suppression";
import type { Summary } from "./types";

export type InviteResult = {
  link: string;
  sms: SendResult;
  email: SendResult;
};

/** Subject and body of one message. Templates are pure so they can be read in a test (design §8.2). */
export type EmailTemplate = { subject: string; text: string };

/**
 * §8.1 A channel the provider told us is closed — a bounced or complained-about address, a number that
 * texted STOP — as the `SendResult` of the send that was therefore not made.
 *
 * No `provider` on the result, deliberately: `provider` is what the rest of the app reads as "a backend
 * really tried" (assertSendable in lib/jobHandlers.ts, statusOf in lib/visitStore.ts), so a suppressed
 * channel is recorded as `skipped` and never retried. Retrying is the one thing that must not happen: the
 * next attempt is identical and SES counts it against the practice's sending domain.
 */
function suppressed(facts: SuppressionFacts | null | undefined, channel: NotifyChannel): SendResult | null {
  const reason = suppressedReason(facts, channel);
  return reason ? { sent: false, error: reason } : null;
}

const firstName = (name: string) => name.split(" ")[0];
const onDate = (at?: Date | null) => (at ? ` on ${at.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` : "");

/** The invite templates. Practice name, first name, date and the link; nothing clinical (design §8.2). */
export function inviteTemplates(p: { name: string; token: string; providerName: string; apptAt?: Date | null }): {
  link: string;
  sms: string;
  email: EmailTemplate;
} {
  const link = intakeLink(p.token);
  const first = firstName(p.name);
  const when = onDate(p.apptAt);
  return {
    link,
    sms: `${p.providerName}'s office: hi ${first}, take 5 minutes before your visit${when} so your doctor is ready for you. Tap to chat with Sweetie: ${link}`,
    email: {
      subject: `Get ready for your visit with ${p.providerName}`,
      text: [
        `Hi ${first},`,
        ``,
        `Before your visit with ${p.providerName}${when}, we'd like to prepare a short summary so your appointment starts with your story already told.`,
        ``,
        `Open this link on your phone or computer. We'll text or email you a six-digit code to check it's you:`,
        link,
        ``,
        `Sweetie will ask you to share your glucose data, where you've been, and a few quick questions. It takes about five minutes.`,
        ``,
        `${p.providerName}'s office`,
      ].join("\n"),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The verification code (design §2.3, §5.3, §8.2). The one message in the product that is a credential
// rather than a link, so: it goes only to the phone or email already on file, it names the practice and
// nothing else, and it says out loud that nobody from the office will ever ask for it.

export type CodeResult = { sms: SendResult; email: SendResult };

/** The code templates. Practice name, the six digits, how long they last; nothing clinical, no link. */
export function codeTemplates(p: { code: string; providerName: string; minutes: number }): { sms: string; email: EmailTemplate } {
  return {
    sms: `${p.providerName}'s office: your code is ${p.code}. It expires in ${p.minutes} minutes. We will never call to ask you for it.`,
    email: {
      subject: `Your code is ${p.code}`,
      text: [
        `Your one-time code for ${p.providerName}'s office is:`,
        ``,
        p.code,
        ``,
        `Type it into the page you just opened. It expires in ${p.minutes} minutes and can be used once.`,
        ``,
        `If you did not open the link, you can ignore this message — the code alone does nothing. Nobody from`,
        `the office will ever call or write to ask you for it.`,
        ``,
        `${p.providerName}'s office`,
      ].join("\n"),
    },
  };
}

/**
 * Send one code. Both channels are tried, because the point is that the code reaches the person the practice
 * already has on file and we do not know which of the two they read. Each fails soft; the caller decides
 * whether that is worth a retry (lib/jobHandlers.ts).
 *
 * Email goes through sendOrMailbox, so with nothing configured the code lands in the local mailbox
 * (`npm run mail`) instead of vanishing — otherwise the patient flow could not be walked offline at all.
 */
export async function sendVerificationCode(p: {
  visitId: string;
  patientId: string;
  code: string;
  phone?: string | null;
  email?: string | null;
  providerName: string;
  minutes: number;
  /** §8.1 What a provider has told us about these two channels. The code is suppressed like every other
   *  message, which is worth a sentence because it is the one the patient is waiting for: a bounced address
   *  does not deliver a code either, and the honest answer is the other channel (lib/suppression.ts). */
  suppression?: SuppressionFacts | null;
}): Promise<CodeResult> {
  const t = codeTemplates(p);

  const [sms, email] = await Promise.all([
    suppressed(p.suppression, "sms") ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: "no phone on file" })),
    suppressed(p.suppression, "email") ??
      (p.email ? sendOrMailbox(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: "no email on file" })),
  ]);

  // The code itself is never a field: logSend records the channel and whether it left, nothing more.
  logSend("code_sent", { visitId: p.visitId, patientId: p.patientId }, { sms, email });
  return { sms, email };
}

export async function sendIntakeInvite(p: {
  visitId?: string;
  patientId?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  token: string;
  providerName: string;
  apptAt?: Date | null;
  /** The channels staff chose for this visit (design §2.2). Anything not in here is not sent, however much
   *  contact detail the patient has on file: a patient who consented to a text only gets a text. */
  channels?: ("sms" | "email")[];
  /** §8.1 A bounce, a spam report or a STOP on one of those channels closes it, whatever staff chose. The two
   *  are different statements and both are honored: consent is the practice's record of permission, this is
   *  the provider's record of what happens when we try. */
  suppression?: SuppressionFacts | null;
}): Promise<InviteResult> {
  const t = inviteTemplates(p);
  const wanted = (channel: "sms" | "email") => !p.channels || p.channels.includes(channel);
  const notChosen = { sent: false, error: "not a channel this patient consented to" };

  const [sms, email] = await Promise.all([
    !wanted("sms")
      ? Promise.resolve(notChosen)
      : suppressed(p.suppression, "sms") ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: "no phone on file" })),
    !wanted("email")
      ? Promise.resolve(notChosen)
      : suppressed(p.suppression, "email") ??
        (p.email ? sendEmail(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: "no email on file" })),
  ]);

  logSend("invite_sent", { visitId: p.visitId, patientId: p.patientId }, { sms, email });
  return { link: t.link, sms, email };
}

/** One line per channel: which channel, which backend, whether it left. Never the address or the body. */
function logSend(event: string, ids: { visitId?: string; patientId?: string }, channels: Record<string, SendResult>): void {
  for (const [channel, result] of Object.entries(channels)) {
    log.info(event, { ...ids, channel, sent: result.sent, provider: result.provider, target: result.target, error: result.error });
  }
}

// ---------------------------------------------------------------------------------------------
// Summary notifications. Fired by POST /api/sour once both summaries are saved. Each channel fails soft.
// Deliberately short: no clinical data, no names beyond the patient's own first name in their own email.
// The link is the delivery; the summary lives only on the site. (If a document is ever wanted in email,
// it goes as an attachment, never as body text.)

export type SummaryNotifyResult = { provider: SendResult; patient: SendResult };

/** The summary-ready templates, provider and patient. Links only: the summary itself never leaves the site.
 *  Both links address one visit (design §4.4): the clinician opens it by visit id, the patient by the token. */
export function summaryTemplates(p: {
  visit: { id: string; token: string; apptAt: Date | null };
  patient: { name: string };
  provider: { id: string; name: string };
}): { providerLink: string; patientLink: string; provider: EmailTemplate; patient: EmailTemplate } {
  const base = appUrl();
  const providerLink = `${base}/provider/${p.provider.id}?visit=${p.visit.id}`;
  const patientLink = `${base}/patient/${p.visit.token}`;
  const first = firstName(p.patient.name);
  const when = p.visit.apptAt ? p.visit.apptAt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : null;

  return {
    providerLink,
    patientLink,
    provider: {
      subject: `Sour: a pre-visit summary is ready${when ? ` (${when})` : ""}`,
      text: [
        `A Sour pre-visit summary is ready${when ? ` for a visit on ${when}` : ""}.`,
        ``,
        `Open it here: ${providerLink}`,
        ``,
        `This email carries no patient data. The summary is on the page, with charts and a place to ask Sour follow-up questions.`,
      ].join("\n"),
    },
    patient: {
      subject: `Your summary is ready, ${first}`,
      text: [
        `Hi ${first},`,
        ``,
        `Your summary is ready${when ? ` ahead of your visit on ${when}` : ""}.`,
        ``,
        `See it here: ${patientLink}`,
        ``,
        `Opening it sends you a six-digit code, so it only works for you. ${p.provider.name}'s office`,
      ].join("\n"),
    },
  };
}

export async function sendSummaryEmails(p: {
  visit: { id: string; token: string; apptAt: Date | null };
  /** §8.1's suppression rides on the patient, because it is the patient's address a provider reports on. The
   *  clinician's address is a colleague's work mailbox and has no such record: a bounce there is the
   *  practice's own mail to fix, and it is not grounds for silently never telling them a summary is ready. */
  patient: { id: string; name: string; email: string | null } & SuppressionFacts;
  provider: { id: string; name: string; email: string | null; practice: string | null };
  providerSummary: Summary;
  patientSummary: Summary;
}): Promise<SummaryNotifyResult> {
  const t = summaryTemplates(p);

  const [provider, patient] = await Promise.all([
    p.provider.email
      ? sendEmail(p.provider.email, t.provider.subject, t.provider.text)
      : Promise.resolve({ sent: false, error: "provider has no email" }),
    suppressed(p.patient, "email") ??
      (p.patient.email
        ? sendEmail(p.patient.email, t.patient.subject, t.patient.text)
        : Promise.resolve({ sent: false, error: "patient has no email" })),
  ]);
  logSend("summary_notified", { visitId: p.visit.id, patientId: p.patient.id }, { provider, patient });
  return { provider, patient };
}

// ---------------------------------------------------------------------------------------------
// §8.2's fifth template: the deletion confirmation.
//
// Sent by the `patient.delete` job (lib/jobHandlers.ts) once §10.5's purge has actually run, so the message
// says what happened rather than what was asked for. That ordering is why the contact details are passed in
// rather than read here: the purge removes the patient's name, phone number and email, which is exactly the
// promise being confirmed, so the only copy of them left is the one the purge handed back.
//
// It carries no link, because there is nothing left to open, and no clinical content — there is none left
// either. It goes on both channels the practice had, and like every other message it honors §8.1: a patient
// who texted STOP does not get a text, even this one.

export type DeletionResult = { sms: SendResult; email: SendResult };

/** The deletion templates. What was deleted, who to ask about it, and nothing else (§8.2). */
export function deletionTemplates(p: { name: string; providerName: string }): { sms: string; email: EmailTemplate } {
  const first = firstName(p.name);
  return {
    sms: `${p.providerName}'s office: the health data you asked us to delete has been deleted, ${first}. Nothing is left in Sweet Spot. Your appointment record stays with the practice.`,
    email: {
      subject: `Your data has been deleted`,
      text: [
        `Hi ${first},`,
        ``,
        `The data you asked ${p.providerName}'s office to delete has been deleted from Sweet Spot: the readings`,
        `and files you shared, your answers, the chat, and the summaries made from them. Your name, phone number`,
        `and email address have been removed with them, so this is the last message we will send you.`,
        ``,
        `The practice keeps its own record that your appointment happened, and a record that this deletion was`,
        `carried out. Your medical record is your practice's and is not affected.`,
        ``,
        `If you did not ask for this, call the office — they can tell you who made the request and when.`,
        ``,
        `${p.providerName}'s office`,
      ].join("\n"),
    },
  };
}

/**
 * Send one deletion confirmation. Both channels, each failing soft: a message nobody can answer is not worth
 * a retry of the deletion job, and the deletion itself has already happened by the time this runs.
 */
export async function sendDeletionConfirmation(p: {
  patientId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  providerName: string;
  suppression?: SuppressionFacts | null;
}): Promise<DeletionResult> {
  const t = deletionTemplates(p);

  const [sms, email] = await Promise.all([
    suppressed(p.suppression, "sms") ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: "no phone on file" })),
    suppressed(p.suppression, "email") ??
      (p.email ? sendEmail(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: "no email on file" })),
  ]);

  // No visitId: the visits are gone, which is the point. The patient id still resolves — §4.3 keeps the
  // scrubbed row so the audit record of the deletion has something to point at.
  logSend("deletion_notified", { patientId: p.patientId }, { sms, email });
  return { sms, email };
}
