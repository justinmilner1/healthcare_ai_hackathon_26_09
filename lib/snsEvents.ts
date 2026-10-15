// What SES and SNS tell us after a send, as data (design §8.1). Owner: Justin.
//
// Both providers report through the same door: an SNS topic subscribed to this app's
// `POST /api/notifications/sns`. SNS posts a JSON envelope — `Type`, `TopicArn`, `Signature`, and the
// provider's own payload as a *string* in `Message` — and the three envelope types are:
//
//   SubscriptionConfirmation   sent once when the topic is subscribed; confirmed by fetching `SubscribeURL`
//   Notification               the one that carries a bounce, a complaint or an inbound text
//   UnsubscribeConfirmation    sent once when someone unsubscribes us; recorded and otherwise ignored
//
// This module is the parsing and the classification, and nothing else: no node:crypto (that is
// lib/snsSignature.ts, which the edge-safe half must not pull in), no database (lib/notifyStore.ts), no
// network. Everything here is a pure function over a parsed body, so lib/snsEvents.test.ts can feed it the
// real payload shapes from AWS's documentation and read the answer.
//
// Three payload shapes matter, and they are not the same shape as each other:
//
//   SES notification       { notificationType: "Bounce" | "Complaint" | "Delivery", bounce: {...}, mail: {...} }
//                          SES's own event publishing uses `eventType` instead of `notificationType` for the
//                          same thing, so both are read.
//   inbound SMS            { originationNumber, destinationNumber, messageKeyword, messageBody, ... } —
//                          AWS End User Messaging's two-way SMS. A `STOP` here is §8.1's opt-out.
//   SMS delivery status    { delivery: { phoneCarrier, providerResponse, destination }, status } — SNS's own
//                          SMS logging. A number already on AWS's opt-out list comes back here, because the
//                          patient texted STOP to a different message of ours and we never saw the inbound.

import { normalizeEmail, normalizePhone, smsKeyword } from "./suppression";

export type SnsEnvelopeType = "SubscriptionConfirmation" | "Notification" | "UnsubscribeConfirmation";

export type SnsEnvelope = {
  type: SnsEnvelopeType;
  messageId: string;
  topicArn: string;
  /** The provider's payload, still a string. SNS signs this text, so it is parsed only after verification. */
  message: string;
  timestamp: string;
  subject: string | null;
  signature: string;
  signatureVersion: string;
  signingCertUrl: string;
  /** Present on the two confirmation types. */
  subscribeUrl: string | null;
  token: string | null;
};

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

const ENVELOPE_TYPES: readonly string[] = ["SubscriptionConfirmation", "Notification", "UnsubscribeConfirmation"];

/**
 * The envelope, or null when the body is not one. Null rather than a throw, because this is the first thing
 * that touches an unauthenticated request body: a 400 with no stack is the whole of the right answer.
 */
export function parseSnsEnvelope(body: unknown): SnsEnvelope | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const type = str(raw.Type);
  if (!type || !ENVELOPE_TYPES.includes(type)) return null;
  const messageId = str(raw.MessageId);
  const topicArn = str(raw.TopicArn);
  const timestamp = str(raw.Timestamp);
  const signature = str(raw.Signature);
  const signingCertUrl = str(raw.SigningCertURL) ?? str(raw.SigningCertUrl);
  // `Message` may legitimately be an empty string on a confirmation, so it is read without the blank check.
  const message = typeof raw.Message === "string" ? raw.Message : null;
  if (messageId === null || topicArn === null || timestamp === null || message === null) return null;
  if (signature === null || signingCertUrl === null) return null;
  return {
    type: type as SnsEnvelopeType,
    messageId,
    topicArn,
    message,
    timestamp,
    subject: str(raw.Subject),
    signature,
    signatureVersion: str(raw.SignatureVersion) ?? "1",
    signingCertUrl,
    subscribeUrl: str(raw.SubscribeURL) ?? str(raw.SubscribeUrl),
    token: str(raw.Token),
  };
}

/**
 * The exact text SNS signed, per its own documentation: the fields that are part of the signature, each as
 * `Name\nvalue\n`, in this order. `Subject` is included only when the message has one, and the two
 * confirmation types sign `SubscribeURL` and `Token` where a notification signs neither.
 *
 * Getting this wrong fails closed — the signature simply does not verify — which is why it is a pure
 * function with a test rather than a detail inside the verifier.
 */
export function snsSigningString(e: SnsEnvelope): string {
  const pairs: [string, string | null][] =
    e.type === "Notification"
      ? [["Message", e.message], ["MessageId", e.messageId], ["Subject", e.subject], ["Timestamp", e.timestamp], ["TopicArn", e.topicArn], ["Type", e.type]]
      : [
          ["Message", e.message],
          ["MessageId", e.messageId],
          ["SubscribeURL", e.subscribeUrl],
          ["Timestamp", e.timestamp],
          ["Token", e.token],
          ["TopicArn", e.topicArn],
          ["Type", e.type],
        ];
  return pairs.filter(([, value]) => value !== null).map(([name, value]) => `${name}\n${value as string}\n`).join("");
}

/**
 * Whether a URL is one AWS would serve the signing certificate from: https, and a host that is an
 * `sns.<region>.amazonaws.com` (or the China partition's `.com.cn`).
 *
 * This is the check that keeps the verifier from being an SSRF: the signing certificate URL arrives inside
 * the request being verified, so without it an attacker posts a body they signed themselves and a
 * `SigningCertURL` pointing at a certificate they control — and everything verifies perfectly.
 */
export function isSnsCertUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)) return false;
  return url.pathname.endsWith(".pem");
}

/** The same rule for the URL a subscription confirmation is completed by fetching. Same reason: the URL comes
 *  out of the request, and anything else is this server making a GET wherever a stranger pointed it. */
export function isSnsSubscribeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname);
}

/** Whether this envelope came from a topic the operator subscribed us to (`SNS_TOPIC_ARNS`). An open webhook
 *  that trusts any correctly signed SNS message trusts every AWS account in the world. */
export function isAllowedTopic(topicArn: string, allowed: readonly string[]): boolean {
  return allowed.includes(topicArn);
}

/** `SNS_TOPIC_ARNS` as a list: comma or whitespace separated, blanks dropped. */
export function parseTopicArns(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// What a notification means

export type NotificationEvent =
  /** §8.1 "marks addresses undeliverable". `code` is the provider's own subtype, kept because
   *  "Suppressed" and "MailboxFull" are different operational stories for the same status. */
  | { kind: "email.bounce" | "email.complaint"; emails: string[]; providerMessageId: string | null; code: string }
  /** A send that landed. Not suppression: it is what clears a `VisitDelivery` row to `sent` (§8.3). */
  | { kind: "email.delivered"; emails: string[]; providerMessageId: string | null }
  /** §8.1 "`STOP` is honored and recorded on the patient", and the way back for a patient who texts START. */
  | { kind: "sms.optout" | "sms.optin"; phone: string }
  /** An SMS that did not arrive, so staff see it on the dashboard rather than assuming it did. */
  | { kind: "sms.failed"; phone: string; code: string };

const emails = (list: unknown, field: string): string[] => {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const raw = typeof item === "string" ? item : item && typeof item === "object" ? (item as Record<string, unknown>)[field] : null;
    const address = normalizeEmail(typeof raw === "string" ? raw : null);
    if (address && !out.includes(address)) out.push(address);
  }
  return out;
};

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * One notification's `Message`, already parsed, as the events it reports. A list because one SES bounce can
 * name several recipients, and empty for a payload this app has nothing to do with (a delivery delay, a
 * subscription event, an inbound text that is an actual reply) — which is not an error: the topic is allowed
 * to carry more than we read.
 */
export function notificationEvents(payload: unknown): NotificationEvent[] {
  const message = obj(payload);
  const sesType = str(message.notificationType) ?? str(message.eventType);
  if (sesType) return sesEvents(message, sesType);

  // Two-way SMS: an inbound message from the patient's own handset.
  const keyword = str(message.messageKeyword) ?? str(message.messageBody);
  const origination = str(message.originationNumber);
  if (origination && (keyword || message.messageBody !== undefined)) {
    const intent = smsKeyword(str(message.messageKeyword) ?? str(message.messageBody));
    const phone = normalizePhone(origination);
    if (!phone || !intent) return [];
    return [{ kind: intent === "stop" ? "sms.optout" : "sms.optin", phone }];
  }

  // SNS's own SMS delivery logging. The status is the top-level `status` on the record, and the carrier's
  // sentence is in `delivery.providerResponse` — which is where a number already on AWS's opt-out list shows
  // up, because the patient texted STOP to a message of ours and AWS answered it without telling us.
  const delivery = obj(message.delivery);
  const destination = normalizePhone(str(delivery.destination) ?? str(message.destination));
  if (destination) {
    const status = (str(message.status) ?? "").toUpperCase();
    const response = str(delivery.providerResponse) ?? "";
    if (/opted?\s*out/i.test(response) || status === "OPTED_OUT") return [{ kind: "sms.optout", phone: destination }];
    if (status === "FAILURE") return [{ kind: "sms.failed", phone: destination, code: smsFailureCode(response) }];
    return [];
  }

  return [];
}

/** The carrier's sentence as a short constant: the sentence itself is operational text we do not need, and
 *  `code` is an allow-listed log field that must not carry a phone number (lib/log.ts). */
function smsFailureCode(response: string): string {
  const text = response.toLowerCase();
  if (text.includes("invalid")) return "invalid_number";
  if (text.includes("blocked") || text.includes("blacklist")) return "blocked";
  if (text.includes("rate")) return "rate_limited";
  if (text.includes("unreachable") || text.includes("unknown")) return "unreachable";
  return "carrier_failure";
}

function sesEvents(message: Record<string, unknown>, type: string): NotificationEvent[] {
  const mail = obj(message.mail);
  const providerMessageId = str(mail.messageId) ?? str(message.messageId);
  const kind = type.toLowerCase();

  if (kind === "bounce") {
    const bounce = obj(message.bounce);
    const addresses = emails(bounce.bouncedRecipients, "emailAddress");
    if (!addresses.length) return [];
    // A transient bounce is a full mailbox or a greylist, not a wrong address: SES retries it itself and the
    // address is not what is broken, so nothing is reported at all — the row stays `sent`, which is what the
    // send did, and the channel stays open.
    if ((str(bounce.bounceType) ?? "").toLowerCase() !== "permanent") return [];
    const code = `${str(bounce.bounceType) ?? "Unknown"}/${str(bounce.bounceSubType) ?? "Unknown"}`;
    return [{ kind: "email.bounce", emails: addresses, providerMessageId, code }];
  }

  if (kind === "complaint") {
    const complaint = obj(message.complaint);
    const addresses = emails(complaint.complainedRecipients, "emailAddress");
    if (!addresses.length) return [];
    return [{ kind: "email.complaint", emails: addresses, providerMessageId, code: str(complaint.complaintFeedbackType) ?? "complaint" }];
  }

  if (kind === "delivery") {
    const addresses = emails(obj(message.delivery).recipients, "emailAddress");
    return [{ kind: "email.delivered", emails: addresses, providerMessageId }];
  }

  return [];
}
