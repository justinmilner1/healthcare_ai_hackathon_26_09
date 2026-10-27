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

import { DEMO_BLOCKED } from "./demo";
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

/**
 * Why no invite is going out when the practice chose to message nobody — the sentence `inviteSendability`
 * deliberately does not return, because staff choosing "Don't contact" is not a gap in the deployment
 * (lib/notify.ts).
 *
 * Here rather than in the two routes that say it, so they cannot drift: `POST /api/book` says it when the
 * wizard's channel is "none" and `POST /api/invite` says it when the visit already on file carries that
 * channel (T120), and a clinician pressing Send link on the dashboard has to read the same thing the person
 * who booked the visit did.
 */
export const NO_CONSENT_TO_MESSAGE = "no consent to message this patient";

/**
 * §2.2, §2.3, T173 And the one `inviteReach` never asked about: a patient with neither a phone nor an email
 * on file. Staff's words for what is missing, and only that — the remedy and the consequence are
 * `warningsFor`'s on the creation screen (lib/visitIntake.ts) and `NO_CODE_TO_SEND`'s on the dashboard, and
 * each of those lines owns them where it is read. This is the clause that goes after "No invite sent:", so
 * it says what the gap is and stops, the way `NO_CONSENT_TO_MESSAGE` above does.
 *
 * The first four words are the warning's own, deliberately: one fact said the same way wherever it is said.
 * Nothing of the deployment's is in it, because nothing about this is the deployment's (§3.7, §10.6) — it is
 * two fields on the front desk's own screen.
 */
export const NO_CONTACT_ON_FILE = "no phone or email on file";

/**
 * §8.1, T170, T173 The clause that withdraws the handover, for the patient it is not a way in for.
 *
 * §8.1's fallback is "hand the link over yourself", and it rests on the link opening — which rests on a code
 * reaching the patient (§2.3, §5.3). With neither a number nor an address there is nowhere to send one, so
 * every line that offers the handover to this patient is offering a way in that does not exist. T170 wrote
 * this sentence for the booking step; T173 found the same offer in the two dashboard notes, so the clause
 * lives here and both modules quote it rather than wording it twice.
 */
export const NO_HANDOVER_EITHER = "handing the link over will not get this patient in either";

/**
 * §2.3, §5.3, T121 What staff read on a visit whose patient cannot be sent a six-digit code: every channel
 * on file is closed, by a bounce or a STOP (§8.1), by §13.4's demo rule, or because this deployment has no
 * sender behind it. `codeReach` (lib/notify.ts) is what decides it; this is the one sentence for all of them.
 *
 * One sentence rather than three, because the three "why" lines are already on the row — the suppression
 * line, the demo line, and the deployment's own — and what none of them says is the consequence: the patient
 * cannot open their link at all, so the intake happens on the telephone or not at all. Staff's words, so it
 * names no channel, no address and no backend (§3.7, §10.6), and here beside the other staff-readable
 * refusals because the dashboard is a client component and must not import lib/notify.ts to read it.
 *
 * It is deliberately not said about a visit with no phone and no email: "call them" is the remedy, and that
 * patient cannot be telephoned either. T173 is what that exclusion cost — the row said nothing at all, and
 * the conclusion the front desk needs is the same one. So that case has the sibling below rather than this
 * sentence, and the two are mutually exclusive by construction: this one is about channels that closed, that
 * one about there being none to close (app/api/provider/route.ts).
 */
export const NO_CODE_CAN_REACH = "No code can reach this patient, so their link will not open — call them";

/**
 * §2.2, §2.3, T173 The same conclusion for the patient who has nothing on file at all: the row used to carry
 * no line of any kind, so a front desk reading **Invited** and a live **Send link** beside "No contact on
 * file" had nothing telling them this link cannot be opened.
 *
 * `NO_CODE_CAN_REACH`'s shape — the fact, the consequence, then the one remedy that works — because it is
 * the same sentence about a different cause, and the remedy is the half that has to differ: there is no
 * telephoning this patient, and the two fields the front desk can fill are the whole of it. "Nowhere to
 * send" rather than "nothing on file", because the patient cell one column to the left already says what is
 * missing (app/provider/dashboard.tsx) and the words the patient's own screen uses for the consequence are
 * these (components/VerifyGate.tsx: "there is nowhere to send your 6-digit code").
 */
export const NO_CODE_TO_SEND =
  "Nowhere to send their code, so their link will not open — add a phone number or an email address";

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
 * The same "nothing was reached" line, for a screen asking *before* a send instead of reporting one after it
 * (T111). The booking wizard is the first thing staff are told about an invite, and until now it was told by
 * the queue: a row in `Job` read as "on its way by email" in a deployment with no email backend at all. The
 * sentence it needs is the one the delivery row will carry minutes later, so both screens say one thing.
 *
 * Pure, like the rest of this module. Whether a backend exists is `emailConfig` and `smsConfig`'s answer
 * (lib/email.ts, lib/sms.ts); `inviteSendability` in lib/notify.ts is what asks them and this is what it
 * quotes. A channel that is neither "sms" nor "email" — "both", the wizard's default — gets the line that
 * names no channel, which is the true one when neither of the two can send.
 */
export function cannotSendYet(channel: string): string {
  return NOTHING_CONFIGURED[channelKey(channel)];
}

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
  if (STAFF_REASONS.has(error)) return null;
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
