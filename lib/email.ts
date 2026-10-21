// Email. Owner: Justin. Two backends, picked by EMAIL_PROVIDER or by the setting each one cannot send without:
//   resend  RESEND_API_KEY (free tier: onboarding@resend.dev -> your own address only)
//   ses     EMAIL_FROM, the verified identity §8.1 sends from (sandbox: every recipient must be a verified
//           identity too)
// Unconfigured -> { sent: false, error } with no `provider`, and the UI shows the link instead.
//
// A deployment sends through SES, which is the one vendor the BAAs cover (§8.1, docs/COMPLIANCE.md). Resend
// stays for local use only (§8.4): it is what lets somebody with no AWS account watch a real invite arrive.
//
// What a backend is *not* chosen by, since T110: an AWS credential. `AWS_ACCESS_KEY_ID` used to select SES on
// its own, which is the same mistake T94 took out of lib/sms.ts, and a generic credential says nothing about
// whether this deployment sends email. It is ambient in the cloud sandbox and on CI, so every `notify.invite`
// in a run of `scripts/agent-check.sh` — the gate, documented by AGENTS.md and §11.3 as running the whole
// product offline — resolved to SES, refused on the missing sender, and was retried: 7 `job_retry` lines
// across 4 jobs in one run, each one spending three attempts over six minutes on an error no attempt can fix.
// The inference was wrong the other way round too: a deployment on ECS or EC2 with a task role has no
// `AWS_ACCESS_KEY_ID` at all, so the backend §8.1 asks for went undetected there. A verified sending identity
// is what a deployment has to arrange before it can mail anybody (docs/NOTIFICATIONS.md), it is set by
// whoever arranged it, and no sandbox hands one out by accident.

// Type-only, so the SDK itself is still imported lazily inside viaSes: a `import type` is erased at compile
// time and nothing is pulled into a bundle that never sends mail.
import type { SendEmailCommandInput } from "@aws-sdk/client-ses";

export type SendResult = {
  sent: boolean;
  error?: string;
  provider?: string;
  /** Where a diverted message landed: the local mailbox directory (lib/mailer.ts). Never an address. */
  target?: string;
  /** The backend's own id for the message (design §8.3): the handle a bounce or complaint notification
   *  arrives under, recorded on the visit by lib/visitStore.ts. Absent when the send never left, and absent
   *  from a backend that does not hand one back. */
  messageId?: string;
};

export type EmailBackend = "resend" | "ses";

/** Resend's free sender, which needs no identity of its own and only ever reaches the key's owner. It is why
 *  the Resend branch can run with no EMAIL_FROM, and why EMAIL_FROM is read as a signal for SES alone. */
const RESEND_DEFAULT_FROM = "Sweet Spot <onboarding@resend.dev>";

/** Which backend sends this environment's email, or null when none is configured. An explicit
 *  `EMAIL_PROVIDER` wins; otherwise the setting each backend cannot send without is the signal that it is
 *  the one, and Resend wins where both are set because §8.4 makes it the local alternative. */
export function emailProvider(): EmailBackend | null {
  const forced = process.env.EMAIL_PROVIDER?.trim();
  if (forced === "resend" || forced === "ses") return forced;
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.EMAIL_FROM?.trim()) return "ses";
  return null;
}

/** Everything one send needs, or the reason there is no send to make. A `reason` is a settled fact about the
 *  environment rather than an attempt that went wrong — see `sendEmail`. */
export type EmailConfig =
  | { provider: "resend"; key: string; from: string }
  | { provider: "ses"; from: string }
  | { reason: string };

/**
 * Resolve the backend and its settings, without building a client or touching the network.
 *
 * This is the `EMAIL_FROM` guard that used to sit inside `viaSes`, moved up to where the backend is chosen so
 * there is one place that decides whether this environment can mail anybody at all — the shape T94 gave
 * `smsConfig` in lib/sms.ts. Exported because `lib/email.test.ts` states that rule, and because the shape of
 * the answer is the whole of T110: an environment with a stray AWS key resolves to a `reason`, so nothing is
 * sent and nothing is reached.
 */
export function emailConfig(): EmailConfig {
  const provider = emailProvider();
  if (!provider) return { reason: "email not configured (set EMAIL_FROM, RESEND_API_KEY, or EMAIL_PROVIDER)" };
  const from = process.env.EMAIL_FROM?.trim();
  if (provider === "resend") {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { reason: "email not configured: RESEND_API_KEY is required" };
    return { provider: "resend", key, from: from || RESEND_DEFAULT_FROM };
  }
  if (!from) return { reason: "email not configured: EMAIL_FROM is required, because SES rejects an unverified sender" };
  return { provider: "ses", from };
}

/**
 * Send one message, or say why this environment cannot.
 *
 * A refusal that never reached a backend carries no `provider`, and that field is load-bearing twice over:
 * `assertSendable` (lib/jobHandlers.ts) reads it to tell "the job is done having sent what it could" from
 * "try again in a minute", and `deliveryFault` (lib/delivery.ts) reads it to tell staff "Sweet Spot cannot
 * send email yet" from "the email did not go out". A missing setting reads the same on the third attempt as
 * on the first, so a configuration gap is the first of each pair: `skipped`, not three attempts and `failed`.
 */
export async function sendEmail(to: string, subject: string, text: string, html?: string): Promise<SendResult> {
  const config = emailConfig();
  if ("reason" in config) return { sent: false, error: config.reason };
  const body = html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  try {
    if (config.provider === "resend") return await viaResend(config, to, subject, text, body);
    return await viaSes(config, to, subject, text, body);
  } catch (e) {
    return { sent: false, provider: config.provider, error: e instanceof Error ? e.message : String(e) };
  }
}

async function viaResend(config: { key: string; from: string }, to: string, subject: string, text: string, html: string): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.from, to: [to], subject, text, html }),
  });
  if (!res.ok) return { sent: false, provider: "resend", error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, provider: "resend", messageId: body.id };
}

/**
 * What goes to SES for one message. Pure and exported so lib/email.test.ts can read it without a client.
 *
 * `ConfigurationSetName` is the load-bearing part (design §8.1): SES publishes a message's bounce, complaint
 * and delivery events to the SNS topic its *configuration set* names, so a send made without one is a send
 * nothing is ever reported about — `POST /api/notifications/sns` would simply never be called, and the
 * suppression `SES_CONFIGURATION_SET` is configured for would silently never happen. Absent when the variable
 * is unset, because SES refuses a configuration set that does not exist.
 */
export function sesSendInput(p: { from: string; to: string; subject: string; text: string; html: string }): SendEmailCommandInput {
  const configurationSet = process.env.SES_CONFIGURATION_SET?.trim();
  return {
    Source: p.from,
    Destination: { ToAddresses: [p.to] },
    Message: {
      Subject: { Data: p.subject, Charset: "UTF-8" },
      Body: { Text: { Data: p.text, Charset: "UTF-8" }, Html: { Data: p.html, Charset: "UTF-8" } },
    },
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
  };
}

async function viaSes(config: { from: string }, to: string, subject: string, text: string, html: string): Promise<SendResult> {
  const { SESClient, SendEmailCommand } = await import("@aws-sdk/client-ses");
  const client = new SESClient({ region: process.env.AWS_SES_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1" });
  // Always present: it is what selected this backend (emailConfig), and SES refuses an unverified sender.
  const sent = await client.send(new SendEmailCommand(sesSendInput({ from: config.from, to, subject, text, html })));
  return { sent: true, provider: "ses", messageId: sent.MessageId };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
