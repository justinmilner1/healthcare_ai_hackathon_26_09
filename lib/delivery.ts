// What a delivery row says to staff (design §8.3). Owner: Justin.
//
// `VisitDelivery.error` is one column with three kinds of text in it, and only two of them are written for
// the practice:
//
//   our own refusals        "no email on file", §8.1's suppression, §13.4's demo rule. Staff's own words on
//                           purpose: each one names something the front desk can see or do.
//   a bounce or a complaint SES's own subtype for a message that *did* leave ("Permanent/General", §8.1).
//                           "it came back" is a different statement from "it never went" and keeps its own
//                           wording.
//   a backend's own message "EMAIL_FROM must be a verified SES identity" (lib/email.ts), "TWILIO_AUTH_TOKEN
//                           and TWILIO_FROM are required" (lib/sms.ts), whatever the SDK threw.
//
// The third used to reach the dashboard unchanged, so hovering a red `Email ✕` beside a patient's name told
// a practice's front desk to set an environment variable (T74). There is nothing they can do with one, and
// it is the deployment's internals on a screen the practice sees. So this module maps it, at the edge, to
// something staff can act on. The backend's words stay where whoever runs the deployment reads them: on the
// row (`recordDeliveries` in lib/visitStore.ts) and in the log line (`logSend` in lib/notify.ts). This is a
// mapping, not a loss of the diagnostic.
//
// Recognising one of ours is an allow-list rather than a search for variable-shaped words, so the next
// sender written in lib/email.ts or lib/sms.ts is mapped by default instead of being shown by default. The
// cost is that a new refusal of our own reads as the generic line until it is added here, which is the safe
// way round.
//
// Pure, no database and no Prisma types: lib/delivery.test.ts states the rule once and the dashboard applies
// it.

import { DEMO_BLOCKED, isDemoBlocked } from "./demo";
import { SUPPRESSED_REASONS } from "./suppression";

/** The columns this reads. Structural rather than `DeliveryRow` from lib/visitStore.ts, so a test can pass
 *  three fields; `providerName` is load-bearing and is explained at `deliveryFault`. */
export type DeliveryFacts = {
  channel: string;
  status: string;
  error?: string | null;
  providerName?: string | null;
  providerMessageId?: string | null;
};

// The refusals lib/notify.ts writes when there is nothing to send to, or nothing it is allowed to send.
// Named here rather than inline there so the allow-list below and the sender cannot drift apart.
export const DELIVERY_NOT_CHOSEN = "not a channel this patient consented to";
export const DELIVERY_NO_PHONE = "no phone on file";
export const DELIVERY_NO_EMAIL = "no email on file";
export const DELIVERY_NO_PROVIDER_EMAIL = "provider has no email";
export const DELIVERY_NO_PATIENT_EMAIL = "patient has no email";

/** Every reason the app writes for staff rather than for a deployment. §8.1's suppression and §13.4's demo
 *  rule come from the modules that own them, so there is one copy of each sentence in the repo. */
const STAFF_REASONS: ReadonlySet<string> = new Set([
  DELIVERY_NOT_CHOSEN,
  DELIVERY_NO_PHONE,
  DELIVERY_NO_EMAIL,
  DELIVERY_NO_PROVIDER_EMAIL,
  DELIVERY_NO_PATIENT_EMAIL,
  DEMO_BLOCKED,
  ...SUPPRESSED_REASONS,
]);

/** Nothing was reached, so nothing will be until somebody configures a sender. Says that, and who to ask —
 *  not which variable, which is the deployment's business and not the practice's (§3.7, §10.6). */
const NOTHING_CONFIGURED: Record<ChannelKey, string> = {
  email: "Sweet Spot cannot send email yet — ask whoever set it up for your office",
  sms: "Sweet Spot cannot send texts yet — ask whoever set it up for your office",
  other: "Sweet Spot cannot send this message yet — ask whoever set it up for your office",
};

/** A sender was reached and refused the message. Staff's half of that is the same either way: the message is
 *  not with the patient, so hand them the link, and the deployment has something to look at. */
const BACKEND_REFUSED: Record<ChannelKey, string> = {
  email: "The email did not go out — ask whoever set Sweet Spot up for your office",
  sms: "The text did not go out — ask whoever set Sweet Spot up for your office",
  other: "The message did not go out — ask whoever set Sweet Spot up for your office",
};

type ChannelKey = "sms" | "email" | "other";

const channelKey = (channel: string): ChannelKey => (channel === "sms" || channel === "email" ? channel : "other");

/**
 * The deployment's own fault with this delivery, in staff's words — or null when the row's `error` is
 * already theirs to read and passes through untouched.
 *
 * `providerName` is what tells the two generic cases apart, and it is the same field `statusOf` in
 * lib/visitStore.ts reads to choose `failed` over `skipped`: a backend named on the row means one was
 * reached and said no, and no backend means there was none to reach. Neither is matched on words, so a
 * future sender's wording cannot change which line staff get.
 */
export function deliveryFault(d: DeliveryFacts): string | null {
  const error = d.error?.trim();
  if (!error) return null;
  // The provider reporting back on a message that left. §8.1 keeps those words: "Permanent/General" is SES's
  // own phrase for it, it names nobody, and it is what a support request quotes alongside the message id.
  if (d.status === "bounced" || d.status === "complained") return null;
  if (STAFF_REASONS.has(error) || isDemoBlocked(error)) return null;
  return (d.providerName ? BACKEND_REFUSED : NOTHING_CONFIGURED)[channelKey(d.channel)];
}

/** Why this message is in the state it is in, for staff. The row's own reason when it was written for them,
 *  the mapped line when it was not, and nothing when the row has no reason at all. */
export function deliveryReason(d: DeliveryFacts): string | undefined {
  // `|| undefined` and not `??`: a row whose error is blank has nothing to say, and an empty
  // tooltip is a tooltip.
  return deliveryFault(d) ?? (d.error?.trim() || undefined);
}

/**
 * The tooltip on a delivery pill (app/provider/dashboard.tsx): the reason above and the provider's message
 * id, which §8.3 asks for and a support request to AWS quotes. Neither is an address or a body (§10.3), so
 * both are safe on a practice's screen.
 */
export function deliveryTooltip(d: DeliveryFacts | null | undefined): string | undefined {
  if (!d) return undefined;
  return [deliveryReason(d), d.providerMessageId].filter(Boolean).join(" · ") || undefined;
}

/** The faults across one visit's deliveries, deduplicated and in the order they first appear: one line under
 *  the pills however many channels ran into the same thing, the way §13.4's demo line already reads. */
export function deliveryFaults(deliveries: readonly DeliveryFacts[]): string[] {
  return [...new Set(deliveries.map(deliveryFault).filter((text): text is string => Boolean(text)))];
}
