// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { appUrl } from "./config";
import {
  cannotSendYet,
  DELIVERY_NOT_CHOSEN,
  DELIVERY_NO_EMAIL,
  DELIVERY_NO_PATIENT_EMAIL,
  DELIVERY_NO_PHONE,
  DELIVERY_NO_PROVIDER_EMAIL,
} from "./delivery";
import { demoBlockReason } from "./demo";
import { emailConfig, sendEmail, type SendResult } from "./email";
import { log } from "./log";
import { canSendOrMailbox, sendOrMailbox } from "./mailer";
import { intakeLink, sendSms, smsConfig } from "./sms";
import { allowedChannels, suppressedReason, type NotifyChannel, type SuppressionFacts } from "./suppression";
import type { Summary } from "./types";
import { channelsOf } from "./visitIntake";

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

/**
 * §13.4 Why this channel is not being used, demo practice first: a practice marked synthetic may only
 * message the reserved addresses and numbers nobody can own (lib/demo.ts), and §8.1's suppression after it.
 *
 * Shaped exactly like `suppressed` above, and for the same reason: no `provider` on the result, so the send
 * is recorded as `skipped` and never retried (lib/visitStore.ts statusOf, assertSendable in
 * lib/jobHandlers.ts). A retry would be identical — the practice is still a demo one and the address is
 * still somebody's — so three attempts would buy three identical refusals and a failed job.
 *
 * Demo before suppression because it is the stronger statement: a bounce says this address does not work,
 * and this says we must not try it at all.
 */
function blockedBy(
  p: { demo?: boolean; suppression?: SuppressionFacts | null },
  channel: NotifyChannel,
  to: string | null | undefined,
): SendResult | null {
  const demo = demoBlockReason(Boolean(p.demo), channel, to);
  if (demo) return { sent: false, error: demo };
  return suppressed(p.suppression, channel);
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
  /** §13.4 True when this visit's practice is marked synthetic, which closes every channel whose destination
   *  is not itself synthetic. The code included: a demo practice that cannot deliver a code to a real phone
   *  is the point, not an edge case — the alternative is texting six digits to somebody who did not ask. */
  demo?: boolean;
}): Promise<CodeResult> {
  const t = codeTemplates(p);

  const [sms, email] = await Promise.all([
    blockedBy(p, "sms", p.phone) ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: DELIVERY_NO_PHONE })),
    blockedBy(p, "email", p.email) ??
      (p.email ? sendOrMailbox(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: DELIVERY_NO_EMAIL })),
  ]);

  // The code itself is never a field: logSend records the channel and whether it left, nothing more.
  logSend("code_sent", { visitId: p.visitId, patientId: p.patientId }, { sms, email });
  return { sms, email };
}

/**
 * Which of the ways there are to reach this patient can carry a six-digit code (§2.3, T113).
 *
 * `channelsFor` (lib/patientSession.ts) answers which contact details are on file; this answers which of
 * them this deployment has a sender behind, which is the other half of the same question and the one the
 * code screen was not asking. Without it the patient was told "we sent a 6-digit code to your phone" by a
 * deployment with no SMS backend, and offered a resend that minted a second code into the same silence.
 *
 * Email is `canSendOrMailbox` and not `emailConfig`, because the code is one of the two messages that go
 * through `sendOrMailbox`: a checkout that names `DEV_MAIL_DIR` really can deliver it, to a file the suite
 * and `npm run mail` read (§11.3). SMS has no mailbox, so it is `smsConfig` alone.
 *
 * Settled from the environment, like `inviteSendability` below and for the same reason: a page can ask it
 * while the patient is still in front of it, and it is not a promise the message arrives — a suppressed
 * address or a demo practice closes a channel on facts that live on the row (`blockedBy` above).
 *
 * Which is why no caller asks this one on its own any more: it is the environment's third of `codeReach`
 * below, which is the whole question "can a code reach this patient" and what the two call sites use (T121).
 */
export function codeChannels(channels: readonly NotifyChannel[]): NotifyChannel[] {
  return channels.filter((c) => (c === "sms" ? !("reason" in smsConfig()) : canSendOrMailbox()));
}

/** Whether a code can reach this patient at all, and — when it cannot — which side of the question closed it.
 *  `closedBy` is set only when there was something on file to close: a visit with no phone and no email has
 *  its own answer at both call sites (§2.2) and is not a channel that shut. */
export type CodeReach = {
  /** The channels a code can really be sent on, in the order they were given (the patient's own order). */
  channels: NotifyChannel[];
  /** Why `channels` is empty although contact details are on file. `"environment"`: this deployment has no
   *  sender behind them (T113). `"row"`: the facts on the patient's row closed them — §8.1's bounce, spam
   *  report or STOP, or §13.4's demo practice with a destination that is not synthetic. Nothing the patient
   *  is told distinguishes the two (§2.3); the log does (app/api/verify/route.ts). */
  closedBy?: "environment" | "row";
};

/**
 * Can a six-digit code reach this patient (§2.3, §5.3, T121)?
 *
 * `codeChannels` above is one of the three filters this applies, and on its own it was half an answer: it
 * asks whether the *deployment* has a sender behind each channel, and its own doc comment says what it is
 * not asking — "a suppressed address or a demo practice closes a channel on facts that live on the row". The
 * send reads those facts (`blockedBy` above) and nothing upstream of the code screen did, so a patient whose
 * only address had bounced was told a code was on its way, `POST /api/verify` answered `sent: true`, and the
 * `notify.code` job refused both channels and logged `code_nothing_to_send`. §2.3 makes the code the only
 * way in, so that is where the visit stopped.
 *
 * So this is the one question both call sites ask — the code screen (components/VerifyGate.tsx) and
 * `POST /api/verify` — rather than three filters spelled out at each of them:
 *
 *   §13.4  `demoBlockReason` — a demo practice may only write to a reserved address or number (lib/demo.ts)
 *   §8.1   `allowedChannels` — a bounce, a spam report or a STOP closes the channel (lib/suppression.ts)
 *   T113   `codeChannels`    — and then, is there a sender behind what is left
 *
 * The row's two filters run before the environment's, which is what makes `closedBy` honest rather than an
 * order of evaluation: `"row"` means the facts on the row alone close every channel on file, so no amount of
 * configuration reopens one and the front desk has to telephone. `"environment"` means something on the row
 * is still open and this deployment cannot serve it, which is somebody's to fix.
 *
 * `channels` is what is on file (`channelsFor`, lib/patientSession.ts); `phone` and `email` are the same two
 * details again, because §13.4's rule is about the destination and not about the channel.
 */
export function codeReach(p: {
  channels: readonly NotifyChannel[];
  phone?: string | null;
  email?: string | null;
  suppression?: SuppressionFacts | null;
  demo?: boolean;
}): CodeReach {
  const open = allowedChannels(p.channels, p.suppression).filter(
    (c) => !demoBlockReason(Boolean(p.demo), c, c === "sms" ? p.phone : p.email),
  );
  const channels = codeChannels(open);
  if (channels.length || p.channels.length === 0) return { channels };
  return { channels, closedBy: open.length === 0 ? "row" : "environment" };
}

/**
 * Which of the channels staff chose this deployment can actually send on, and what staff read when the
 * answer is none of them (T111). The fallback is the senders' own contract — "Unconfigured -> { sent:
 * false, error } with no `provider`, and the UI shows the link instead" (lib/email.ts, lib/sms.ts) — which
 * is what §8.1's two backends amount to for a deployment that has not set them up.
 *
 * `sendIntakeInvite` below finds this out one channel at a time, inside a job, minutes after the staff
 * member who booked the visit has been told what to expect. Both sender modules can answer the same question
 * synchronously, with no client built and no network call — `smsConfig` (lib/sms.ts, T94) and `emailConfig`
 * (lib/email.ts, T110) — so a booking route can ask it while that person is still on the screen.
 *
 * What it is deliberately *not* is a prediction that the message will arrive. A configured backend can still
 * bounce, and a suppressed address or a demo practice closes a channel on facts that live on the row rather
 * than in the environment (`blockedBy` above). Those belong to the delivery row, which reports what actually
 * happened (§8.3). This answers the narrower question the wizard needs and can have straight away: is there
 * a sender behind the channel staff chose at all.
 */
export type InviteSendability = {
  /** The chosen channels with a backend behind them, in `channelsOf` order. */
  channels: NotifyChannel[];
  /** What staff read when `channels` is empty although they chose one — lib/delivery.ts's words, so it names
   *  neither a variable nor a backend (§3.7, §10.6). Undefined when something can go out, and when staff
   *  chose to message nobody, which is not a gap in the deployment and has its own sentence. */
  reason?: string;
};

export function inviteSendability(channel: string | null | undefined): InviteSendability {
  const wanted = channelsOf(channel);
  const channels = wanted.filter((c) => !("reason" in (c === "sms" ? smsConfig() : emailConfig())));
  if (channels.length || !wanted.length) return { channels };
  return { channels, reason: cannotSendYet(channel ?? "") };
}

/**
 * The same question about a *batch* of invites rather than one (§2.2, §8.1, T135): the distinct reasons
 * nothing can go out, one per reason however many rows ran into it.
 *
 * §2.2's CSV import is the bulk path, and the fact is about the deployment rather than about any row — a
 * file of 25 texts in an office with no SMS backend is one sentence, not 25. The set is what makes that
 * true, and the channel is what keeps the sentences apart: a file holding both an `sms` row and an `email`
 * row in a deployment that has configured neither has two things to say, because `cannotSendYet` names the
 * channel staff chose (lib/delivery.ts).
 *
 * A row that chose to message nobody adds nothing, the way `inviteSendability` returns no reason for
 * `"none"`: that is the practice's own choice and `NO_CONSENT_TO_MESSAGE` is its sentence (T120). A blank
 * `channel` column is that same choice — the CSV parser reads it as `"none"` (lib/visitIntake.ts) — so the
 * two "Do not message" lines of the example file stay clean on a screen full of faults.
 *
 * Settled from the environment with no client and no network call, like everything else here, which is why
 * `POST /api/visits/import` can answer it on the preview — before a single row is written — as cheaply as it
 * answers it afterwards.
 */
export function inviteFaults(channels: Iterable<string | null | undefined>): string[] {
  const faults = new Set<string>();
  for (const channel of channels) {
    if (channel === "none") continue;
    const reason = inviteSendability(channel).reason;
    if (reason) faults.add(reason);
  }
  return [...faults];
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
  /** §13.4 The practice is a demo one, so only a reserved address or number is written to (lib/demo.ts). */
  demo?: boolean;
}): Promise<InviteResult> {
  const t = inviteTemplates(p);
  const wanted = (channel: "sms" | "email") => !p.channels || p.channels.includes(channel);
  const notChosen = { sent: false, error: DELIVERY_NOT_CHOSEN };

  const [sms, email] = await Promise.all([
    !wanted("sms")
      ? Promise.resolve(notChosen)
      : blockedBy(p, "sms", p.phone) ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: DELIVERY_NO_PHONE })),
    !wanted("email")
      ? Promise.resolve(notChosen)
      : blockedBy(p, "email", p.email) ??
        (p.email ? sendEmail(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: DELIVERY_NO_EMAIL })),
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
  /** §13.4 A demo practice tells nobody at a real address that a synthetic summary is ready — the clinician
   *  included. The clinician's address is the practice's own, but a demo practice's clinician is a seeded row
   *  as synthetic as its patients, and a message to a colleague about a patient who does not exist is still a
   *  message about a patient. */
  demo?: boolean;
}): Promise<SummaryNotifyResult> {
  const t = summaryTemplates(p);

  const [provider, patient] = await Promise.all([
    blockedBy({ demo: p.demo }, "email", p.provider.email) ??
      (p.provider.email
        ? sendEmail(p.provider.email, t.provider.subject, t.provider.text)
        : Promise.resolve({ sent: false, error: DELIVERY_NO_PROVIDER_EMAIL })),
    blockedBy({ demo: p.demo, suppression: p.patient }, "email", p.patient.email) ??
      (p.patient.email
        ? sendEmail(p.patient.email, t.patient.subject, t.patient.text)
        : Promise.resolve({ sent: false, error: DELIVERY_NO_PATIENT_EMAIL })),
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
  /** §13.4 As every other message: a demo practice confirms a deletion to a reserved address or to nobody.
   *  The deletion itself has already happened, which is what makes a blocked confirmation harmless here. */
  demo?: boolean;
}): Promise<DeletionResult> {
  const t = deletionTemplates(p);

  const [sms, email] = await Promise.all([
    blockedBy(p, "sms", p.phone) ?? (p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: DELIVERY_NO_PHONE })),
    blockedBy(p, "email", p.email) ??
      (p.email ? sendEmail(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: DELIVERY_NO_EMAIL })),
  ]);

  // No visitId: the visits are gone, which is the point. The patient id still resolves — §4.3 keeps the
  // scrubbed row so the audit record of the deletion has something to point at.
  logSend("deletion_notified", { patientId: p.patientId }, { sms, email });
  return { sms, email };
}
