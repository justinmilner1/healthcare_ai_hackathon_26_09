// SMS. Owner: Justin. Two backends, picked by SMS_PROVIDER or auto-detected:
//   twilio  when TWILIO_ACCOUNT_SID is set (trial: only numbers verified in the Twilio console)
//   sns     when AWS_ACCESS_KEY_ID is set (sandbox: only numbers verified in the SNS console;
//           US destinations also need an origination number registered in the account)
// Unconfigured -> { sent: false, error } and the UI shows the link instead.
//
// A deployment sends through SNS, for the same reason email goes through SES (§8.1). Twilio stays for local
// use only (§8.4), and docs/COMPLIANCE.md records that its BAA is only needed if a deployment picks it.

import { appUrl } from "./config";
import type { SendResult } from "./email";

export function smsProvider(): "twilio" | "sns" | null {
  const forced = process.env.SMS_PROVIDER;
  if (forced === "twilio" || forced === "sns") return forced;
  if (process.env.TWILIO_ACCOUNT_SID) return "twilio";
  if (process.env.AWS_ACCESS_KEY_ID) return "sns";
  return null;
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  const provider = smsProvider();
  if (!provider) return { sent: false, error: "SMS not configured (set Twilio or AWS keys)" };
  try {
    if (provider === "twilio") return await viaTwilio(to, body);
    return await viaSns(to, body);
  } catch (e) {
    return { sent: false, provider, error: e instanceof Error ? e.message : String(e) };
  }
}

async function viaTwilio(to: string, body: string): Promise<SendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { sent: false, provider: "twilio", error: "TWILIO_AUTH_TOKEN and TWILIO_FROM are required" };
  const twilio = (await import("twilio")).default;
  const message = await twilio(sid, token).messages.create({ to, from, body });
  return { sent: true, provider: "twilio", messageId: message.sid };
}

async function viaSns(to: string, body: string): Promise<SendResult> {
  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const client = new SNSClient({ region: process.env.AWS_SNS_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1" });
  const sent = await client.send(
    new PublishCommand({
      PhoneNumber: to,
      Message: body,
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
        ...(process.env.SNS_ORIGINATION_NUMBER
          ? { "AWS.MM.SMS.OriginationNumber": { DataType: "String", StringValue: process.env.SNS_ORIGINATION_NUMBER } }
          : {}),
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
