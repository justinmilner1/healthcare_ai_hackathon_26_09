// Send a patient their presigned Sweetie link by SMS and/or email. Owner: Justin.
// The token in the link is the patient's sign-in: /s/<token> opens their intake, /patient/<token> their summary.
// Each channel fails soft; the caller decides whether to show the link on screen.

import { sendEmail } from "./email";
import { intakeLink, sendSms } from "./sms";

export type InviteResult = {
  link: string;
  sms: { sent: boolean; error?: string };
  email: { sent: boolean; error?: string };
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
