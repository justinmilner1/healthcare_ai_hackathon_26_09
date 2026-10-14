// Email. Owner: Justin. Two backends, picked by EMAIL_PROVIDER or auto-detected:
//   resend  when RESEND_API_KEY is set (free tier: onboarding@resend.dev -> your own address only)
//   ses     when AWS_ACCESS_KEY_ID is set (sandbox: EMAIL_FROM and every recipient must be verified identities)
// Unconfigured -> { sent: false, error } and the UI shows the link instead.

/** What one send did. `messageId` is the backend's own id for the message (design §8.3): the handle a bounce
 *  or complaint notification arrives under, recorded on the visit by lib/visitStore.ts. Absent when the send
 *  never left, and absent from a backend that does not hand one back. */
export type SendResult = { sent: boolean; error?: string; provider?: string; messageId?: string };

export function emailProvider(): "resend" | "ses" | null {
  const forced = process.env.EMAIL_PROVIDER;
  if (forced === "resend" || forced === "ses") return forced;
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.AWS_ACCESS_KEY_ID) return "ses";
  return null;
}

export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<SendResult> {
  const provider = emailProvider();
  if (!provider) return { sent: false, error: "email not configured (set RESEND_API_KEY or AWS keys)" };
  const body = html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  try {
    if (provider === "resend") return await viaResend(to, subject, text, body);
    return await viaSes(to, subject, text, body);
  } catch (e) {
    return { sent: false, provider, error: e instanceof Error ? e.message : String(e) };
  }
}

async function viaResend(to: string, subject: string, text: string, html: string): Promise<SendResult> {
  const from = process.env.EMAIL_FROM ?? "Sweet Spot <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
  });
  if (!res.ok) return { sent: false, provider: "resend", error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, provider: "resend", messageId: body.id };
}

async function viaSes(to: string, subject: string, text: string, html: string): Promise<SendResult> {
  const from = process.env.EMAIL_FROM;
  if (!from) return { sent: false, provider: "ses", error: "EMAIL_FROM must be a verified SES identity" };
  const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
  const client = new SESClient({ region: process.env.AWS_SES_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1" });
  const sent = await client.send(
    new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
      },
    }),
  );
  return { sent: true, provider: "ses", messageId: sent.MessageId };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
