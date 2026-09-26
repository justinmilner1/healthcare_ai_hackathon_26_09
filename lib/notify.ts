// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { sendEmail, type SendResult } from "./email";
import { intakeLink, sendSms } from "./sms";
import type { Spike, Summary } from "./types";

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
// Summary emails. Fired by POST /api/sour once both summaries are saved. Each channel fails soft.

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
  const s = p.providerSummary;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const spikeLine = (x: Spike) =>
    `${new Date(x.peak).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}: ${x.from} → ${x.to} mg/dL${x.visit ? ` after ${x.visit.place}` : ""}`;

  const providerText = [
    `Sour 🍋 pre-visit summary · ${p.patient.name}${when ? ` · visit ${when}` : ""}`,
    ``,
    `Time in range ${pct(s.timeInRange)} · average ${s.avgGlucose} mg/dL · ${s.spikes.length} spikes`,
    ``,
    `Spikes`,
    ...(s.spikes.length ? s.spikes.map((x) => `  • ${spikeLine(x)}`) : ["  • none detected"]),
    ``,
    `Patterns`,
    ...(s.patterns.length ? s.patterns.map((x) => `  • ${x}`) : ["  • none"]),
    ``,
    `Ask the patient`,
    ...(s.questions.length ? s.questions.map((x, i) => `  ${i + 1}. ${x}`) : ["  none"]),
    ``,
    ...(s.patientNotes ? [`In the patient's words`, `  ${s.patientNotes.replace(/\n/g, "\n  ")}`, ``] : []),
    `Full page with charts: ${providerLink}`,
    ``,
    `AI-generated from the patient's own uploads. Not reviewed by a clinician until you read it.`,
  ].join("\n");

  const q = p.patientSummary;
  const patientText = [
    `Hi ${first},`,
    ``,
    `Your week is ready${when ? ` ahead of your visit on ${when}` : ""}. You were in the 70 to 180 range ${pct(q.timeInRange)} of the time.`,
    ``,
    `What your week showed`,
    ...(q.patterns.length ? q.patterns.map((x) => `  • ${x}`) : ["  • Your doctor will go over the details with you."]),
    ``,
    ...(q.questions.length ? [`Things you might ask your doctor`, ...q.questions.map((x, i) => `  ${i + 1}. ${x}`), ``] : []),
    `See your charts: ${patientLink}`,
    ``,
    `This is a summary of your own data, not medical advice. ${p.provider.name}'s office`,
  ].join("\n");

  const [provider, patient] = await Promise.all([
    p.provider.email
      ? sendEmail(p.provider.email, `Sour: ${p.patient.name}${when ? ` · ${when}` : ""} · TIR ${pct(s.timeInRange)}`, providerText)
      : Promise.resolve({ sent: false, error: "provider has no email" }),
    p.patient.email
      ? sendEmail(p.patient.email, `Your week is ready, ${first}`, patientText)
      : Promise.resolve({ sent: false, error: "patient has no email" }),
  ]);
  return { provider, patient };
}
