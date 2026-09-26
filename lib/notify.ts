// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { sendEmail, type SendResult } from "./email";
import { intakeLink, sendSms } from "./sms";
import type { Summary } from "./types";

export type InviteResult = {
  link: string;
  sms: SendResult;
  email: SendResult;
};

export async function sendIntakeInvite(p: {
  name: string;
  phone?: string | null;
  email?: string | null;
  token: string;
  providerName: string;
  apptAt?: Date | null;
}): Promise<InviteResult> {
  const link = intakeLink(p.token);
  const first = p.name.split(" ")[0];
  const when = p.apptAt ? ` on ${p.apptAt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` : "";

  const smsBody = `${p.providerName}'s office: hi ${first}, take 5 minutes before your visit${when} so your doctor is ready for you. Tap to chat with Sweetie: ${link}`;

  const emailText = [
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
  ].join("\n");

  const [sms, email] = await Promise.all([
    p.phone ? sendSms(p.phone, smsBody) : Promise.resolve({ sent: false, error: "no phone on file" }),
    p.email ? sendEmail(p.email, `Get ready for your visit with ${p.providerName}`, emailText) : Promise.resolve({ sent: false, error: "no email on file" }),
  ]);

  return { link, sms, email };
}

// ---------------------------------------------------------------------------------------------
// Summary notifications. Fired by POST /api/sour once both summaries are saved. Each channel fails soft.
// Deliberately short: no clinical data, no names beyond the patient's own first name in their own email.
// The link is the delivery; the summary lives only on the site. (If a document is ever wanted in email,
// it goes as an attachment, never as body text.)

export type SummaryNotifyResult = { provider: SendResult; patient: SendResult };

export async function sendSummaryEmails(p: {
  patient: { id: string; name: string; email: string | null; token: string; apptAt: Date | null };
  provider: { id: string; name: string; email: string | null; practice: string | null };
  providerSummary: Summary;
  patientSummary: Summary;
}): Promise<SummaryNotifyResult> {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const providerLink = `${base}/provider/${p.provider.id}?patient=${p.patient.id}`;
  const patientLink = `${base}/patient/${p.patient.token}`;
  const first = p.patient.name.split(" ")[0];
  const when = p.patient.apptAt ? p.patient.apptAt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) : null;

  const providerText = [
    `A Sour pre-visit summary is ready${when ? ` for a visit on ${when}` : ""}.`,
    ``,
    `Open it here: ${providerLink}`,
    ``,
    `This email carries no patient data. The summary is on the page, with charts and a place to ask Sour follow-up questions.`,
  ].join("\n");

  const patientText = [
    `Hi ${first},`,
    ``,
    `Your summary is ready${when ? ` ahead of your visit on ${when}` : ""}.`,
    ``,
    `See it here: ${patientLink}`,
    ``,
    `The link is yours alone and needs no login. ${p.provider.name}'s office`,
  ].join("\n");

  const [provider, patient] = await Promise.all([
    p.provider.email
      ? sendEmail(p.provider.email, `Sour: a pre-visit summary is ready${when ? ` (${when})` : ""}`, providerText)
      : Promise.resolve({ sent: false, error: "provider has no email" }),
    p.patient.email
      ? sendEmail(p.patient.email, `Your summary is ready, ${first}`, patientText)
      : Promise.resolve({ sent: false, error: "patient has no email" }),
  ]);
  return { provider, patient };
}
