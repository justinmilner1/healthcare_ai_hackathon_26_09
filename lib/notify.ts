// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { appUrl } from "./config";
import { sendEmail, type SendResult } from "./email";
import { log } from "./log";
import { intakeLink, sendSms } from "./sms";
import type { Summary } from "./types";

export type InviteResult = {
  link: string;
  sms: SendResult;
  email: SendResult;
};

/** Subject and body of one message. Templates are pure so they can be read in a test (design §8.2). */
export type EmailTemplate = { subject: string; text: string };

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
        `Open this link on your phone or computer. It's yours alone, no login needed:`,
        link,
        ``,
        `Sweetie will ask you to share your glucose data, where you've been, and a few quick questions. It takes about five minutes.`,
        ``,
        `${p.providerName}'s office`,
      ].join("\n"),
    },
  };
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
}): Promise<InviteResult> {
  const t = inviteTemplates(p);
  const wanted = (channel: "sms" | "email") => !p.channels || p.channels.includes(channel);
  const notChosen = { sent: false, error: "not a channel this patient consented to" };

  const [sms, email] = await Promise.all([
    !wanted("sms") ? Promise.resolve(notChosen) : p.phone ? sendSms(p.phone, t.sms) : Promise.resolve({ sent: false, error: "no phone on file" }),
    !wanted("email") ? Promise.resolve(notChosen) : p.email ? sendEmail(p.email, t.email.subject, t.email.text) : Promise.resolve({ sent: false, error: "no email on file" }),
  ]);

  logSend("invite_sent", { visitId: p.visitId, patientId: p.patientId }, { sms, email });
  return { link: t.link, sms, email };
}

/** One line per channel: which channel, which backend, whether it left. Never the address or the body. */
function logSend(event: string, ids: { visitId?: string; patientId?: string }, channels: Record<string, SendResult>): void {
  for (const [channel, result] of Object.entries(channels)) {
    log.info(event, { ...ids, channel, sent: result.sent, provider: result.provider, error: result.error });
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
        `The link is yours alone and needs no login. ${p.provider.name}'s office`,
      ].join("\n"),
    },
  };
}

export async function sendSummaryEmails(p: {
  visit: { id: string; token: string; apptAt: Date | null };
  patient: { id: string; name: string; email: string | null };
  provider: { id: string; name: string; email: string | null; practice: string | null };
  providerSummary: Summary;
  patientSummary: Summary;
}): Promise<SummaryNotifyResult> {
  const t = summaryTemplates(p);

  const [provider, patient] = await Promise.all([
    p.provider.email
      ? sendEmail(p.provider.email, t.provider.subject, t.provider.text)
      : Promise.resolve({ sent: false, error: "provider has no email" }),
    p.patient.email
      ? sendEmail(p.patient.email, t.patient.subject, t.patient.text)
      : Promise.resolve({ sent: false, error: "patient has no email" }),
  ]);
  logSend("summary_notified", { visitId: p.visit.id, patientId: p.patient.id }, { provider, patient });
  return { provider, patient };
}
