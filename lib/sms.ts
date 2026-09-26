// Twilio SMS. Optional. Owner: Justin.
// If Twilio env vars are unset, sendSms() returns { sent: false } and the UI shows the link instead.

export async function sendSms(to: string, body: string): Promise<{ sent: boolean; error?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { sent: false, error: "Twilio not configured" };
  try {
    const twilio = (await import("twilio")).default;
    await twilio(sid, token).messages.create({ to, from, body });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function intakeLink(token: string): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/s/${token}/intake`;
}
