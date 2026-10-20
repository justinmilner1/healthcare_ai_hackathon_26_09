// SMS. Owner: Justin. Two backends, picked by SMS_PROVIDER or by the setting each one cannot send without:
//   twilio  TWILIO_ACCOUNT_SID, with TWILIO_AUTH_TOKEN and TWILIO_FROM (trial: only numbers verified in the
//           Twilio console)
//   sns     SNS_ORIGINATION_NUMBER, the registered number §8.1 sends through (sandbox: only destinations
//           verified in the SNS console receive anything)
// Unconfigured -> { sent: false, error } with no `provider`, and the UI shows the link instead.
//
// A deployment sends through SNS, for the same reason email goes through SES (§8.1). Twilio stays for local
// use only (§8.4), and docs/COMPLIANCE.md records that its BAA is only needed if a deployment picks it.
//
// What a backend is *not* chosen by, since T94: an AWS credential. `AWS_ACCESS_KEY_ID` used to select SNS on
// its own, and a generic credential says nothing about whether this deployment texts anybody. It is ambient
// in the cloud sandbox, so `scripts/agent-check.sh` — the gate, documented by AGENTS.md and §11.3 as running
// the whole product offline — published every invite to SNS with a key that cannot work: 14 outbound calls
// across 9 `notify.invite` jobs in one run, 6 of them ending `failed` after spending three attempts on an
// error no attempt could fix. The inference was wrong the other way round too: a deployment on ECS or EC2
// with a task role has no `AWS_ACCESS_KEY_ID` at all, so the backend §8.1 asks for went undetected there. A
// registered origination number is what a deployment has to arrange before it can text anyone
// (docs/NOTIFICATIONS.md), it is set by whoever arranged it, and no sandbox hands one out by accident.

import { appUrl } from "./config";
import type { SendResult } from "./email";

export type SmsBackend = "twilio" | "sns";

/** Which backend sends this environment's texts, or null when none is configured. An explicit `SMS_PROVIDER`
 *  wins; otherwise the setting each backend cannot send without is the signal that it is the one. */
export function smsProvider(): SmsBackend | null {
  const forced = process.env.SMS_PROVIDER?.trim();
  if (forced === "twilio" || forced === "sns") return forced;
  if (process.env.TWILIO_ACCOUNT_SID) return "twilio";
  if (process.env.SNS_ORIGINATION_NUMBER) return "sns";
  return null;
}

/** Everything one send needs, or the reason there is no send to make. A `reason` is a settled fact about the
 *  environment rather than an attempt that went wrong — see `sendSms`. */
export type SmsConfig =
  | { provider: "twilio"; sid: string; token: string; from: string }
  | { provider: "sns"; origination: string }
  | { reason: string };

/**
 * Resolve the backend and its settings, without building a client or touching the network.
 *
 * This is `viaSes`'s `EMAIL_FROM` guard (lib/email.ts) for both SMS backends, moved up to where the backend
 * is chosen so there is one place that decides whether this environment can text anybody at all. Exported
 * because `lib/sms.test.ts` states that rule and because the shape of the answer is the whole of T94: an
 * environment with a stray AWS key resolves to a `reason`, so nothing is sent and nothing is reached.
 */
export function smsConfig(): SmsConfig {
  const provider = smsProvider();
  if (!provider) return { reason: "SMS not configured (set SNS_ORIGINATION_NUMBER, a Twilio account, or SMS_PROVIDER)" };
  if (provider === "twilio") {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    if (!sid) return { reason: "SMS not configured: TWILIO_ACCOUNT_SID is required" };
    if (!token || !from) return { reason: "SMS not configured: TWILIO_AUTH_TOKEN and TWILIO_FROM are required" };
    return { provider: "twilio", sid, token, from };
  }
  const origination = process.env.SNS_ORIGINATION_NUMBER;
  if (!origination) return { reason: "SMS not configured: SNS_ORIGINATION_NUMBER is required, because SNS sends through a registered origination number" };
  return { provider: "sns", origination };
}

/**
 * Send one text, or say why this environment cannot.
 *
 * A refusal that never reached a backend carries no `provider`, and that field is load-bearing twice over:
 * `assertSendable` (lib/jobHandlers.ts) reads it to tell "the job is done having sent what it could" from
 * "try again in a minute", and `deliveryFault` (lib/delivery.ts) reads it to tell staff "Sweet Spot cannot
 * send texts yet" from "the text did not go out". A missing setting reads the same on the third attempt as
 * on the first, so a configuration gap is the first of each pair: `skipped`, not three attempts and `failed`.
 */
export async function sendSms(to: string, body: string): Promise<SendResult> {
  const config = smsConfig();
  if ("reason" in config) return { sent: false, error: config.reason };
  try {
    return config.provider === "twilio" ? await viaTwilio(config, to, body) : await viaSns(config, to, body);
  } catch (e) {
    return { sent: false, provider: config.provider, error: e instanceof Error ? e.message : String(e) };
  }
}

async function viaTwilio(config: { sid: string; token: string; from: string }, to: string, body: string): Promise<SendResult> {
  const twilio = (await import("twilio")).default;
  const message = await twilio(config.sid, config.token).messages.create({ to, from: config.from, body });
  return { sent: true, provider: "twilio", messageId: message.sid };
}

async function viaSns(config: { origination: string }, to: string, body: string): Promise<SendResult> {
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const client = new SNSClient({ region: process.env.AWS_SNS_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1" });
  const sent = await client.send(
    new PublishCommand({
      PhoneNumber: to,
      Message: body,
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        // Always present: it is what selected this backend (smsConfig), and US destinations do not deliver
        // without it (docs/NOTIFICATIONS.md).
        "AWS.MM.SMS.OriginationNumber": { DataType: "String", StringValue: config.origination },
      },
    }),
  );
  return { sent: true, provider: "sns", messageId: sent.MessageId };
}

/** The presigned link in every invite. Lands directly in the Sweetie chat, which is where onboarding happens;
 *  uploads live in the chat's sidebar, so no intermediate page. */
export function intakeLink(token: string): string {
  return `${appUrl()}/s/${token}`;
}
