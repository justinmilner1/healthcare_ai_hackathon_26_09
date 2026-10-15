// When we stop messaging a patient on a channel, and why (design §8.1). Owner: Justin.
//
// §8.1 asks for two things to be honored, and they come from opposite directions:
//
//   a bounce or complaint   SES tells us the address is wrong, or that the person marked our mail as spam.
//                           Either way the next send is worse than useless: it is counted against the
//                           sending domain, and enough of them stop the domain sending to anyone.
//   STOP                    the patient tells us to stop texting. AWS adds the number to its own opt-out
//                           list and silently drops what we publish, so the honoring is not optional — the
//                           only question is whether we find out before or after spending a message.
//
// So the facts live on the `Patient` row (prisma/schema.prisma), lib/notifyStore.ts writes them when a
// notification arrives, and this module is the rule every send reads: pure, no database, no AWS, so
// lib/suppression.test.ts can state the rule once and lib/notify.ts can apply it in three places.
//
// The verification code is suppressed like everything else, which is worth saying out loud because it is the
// one message a patient is waiting for. A bounced address does not deliver a code either; what it does is
// burn the practice's sending reputation while the patient stares at a page. The honest answer is to skip the
// channel, record why, and let the other channel — or the staff member holding the phone — finish the job.

/** The two ways out of the app. Not lib/visitIntake.ts's `ContactChannel`, which also has "both" and "none":
 *  that one is what staff chose, this one is a wire. */
export type NotifyChannel = "sms" | "email";

/** Why a channel is closed. `bounce` and `complaint` are SES's own words for it; `stop` is the patient's. */
export type SuppressionCode = "bounce" | "complaint" | "undeliverable" | "stop";

/** The columns this reads. Structural rather than Prisma's `Patient`, so a test can pass three fields and
 *  lib/notify.ts can be handed whatever the caller happens to have selected. */
export type SuppressionFacts = {
  emailUndeliverableAt?: Date | string | null;
  emailUndeliverableReason?: string | null;
  smsOptOutAt?: Date | string | null;
};

export type Suppression = { channel: NotifyChannel; code: SuppressionCode; at: Date | null };

const asDate = (value: Date | string | null | undefined): Date | null => {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

const emailCode = (reason: string | null | undefined): SuppressionCode =>
  reason === "bounce" || reason === "complaint" ? reason : "undeliverable";

/** Every closed channel for this patient, in a fixed order so a screen and a test read the same list. */
export function suppressions(facts: SuppressionFacts | null | undefined): Suppression[] {
  if (!facts) return [];
  const out: Suppression[] = [];
  if (facts.smsOptOutAt) out.push({ channel: "sms", code: "stop", at: asDate(facts.smsOptOutAt) });
  if (facts.emailUndeliverableAt) {
    out.push({ channel: "email", code: emailCode(facts.emailUndeliverableReason), at: asDate(facts.emailUndeliverableAt) });
  }
  return out;
}

export function suppressionOn(facts: SuppressionFacts | null | undefined, channel: NotifyChannel): Suppression | null {
  return suppressions(facts).find((s) => s.channel === channel) ?? null;
}

/** Those of `channels` still open. The order of the input is kept: callers list channels in the order the
 *  design does and the result should not reshuffle them. */
export function allowedChannels(channels: readonly NotifyChannel[], facts: SuppressionFacts | null | undefined): NotifyChannel[] {
  const closed = new Set(suppressions(facts).map((s) => s.channel));
  return channels.filter((c) => !closed.has(c));
}

/**
 * The `error` text recorded against a send that was not made, or null when the channel is open.
 *
 * It is operational and it is the same shape as lib/email.ts's own refusals ("email not configured"), because
 * it lands in the same two places: `VisitDelivery.error`, which staff read, and the log, which §10.3 allows
 * no address and no body into. "the patient texted STOP" names what happened without naming anyone.
 */
export function suppressedReason(facts: SuppressionFacts | null | undefined, channel: NotifyChannel): string | null {
  const hit = suppressionOn(facts, channel);
  if (!hit) return null;
  if (hit.code === "stop") return "the patient texted STOP, so texts are off (design §8.1)";
  if (hit.code === "complaint") return "the address was reported as spam, so email is off (design §8.1)";
  return "the address bounced, so email is off (design §8.1)";
}

/** How a closed channel reads on the dashboard (§8.3 "shown to staff"). Short: it sits under a status pill. */
export function suppressionLabel(s: Suppression): string {
  if (s.code === "stop") return "Texts stopped (STOP)";
  if (s.code === "complaint") return "Email reported as spam";
  if (s.code === "bounce") return "Email bounced";
  return "Email undeliverable";
}

// ---------------------------------------------------------------------------------------------
// The keywords
//
// AWS End User Messaging answers STOP itself and will not deliver to a number on its opt-out list, so these
// are not what *performs* the opt-out — they are how we learn about it from the inbound message (§8.1) and
// stop queueing sends that would be dropped. The lists are AWS's own reserved keywords plus the spellings
// people actually text; anything else is a reply to a question, not a command, and is left alone.

export const STOP_KEYWORDS: readonly string[] = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out", "revoke"];
export const START_KEYWORDS: readonly string[] = ["start", "unstop", "yes", "optin", "opt-in", "subscribe"];

/**
 * What an inbound text asks for, from its first word. "STOP" and "STOP." and "Stop please" all stop;
 * "I'd like to stop eating so late" does not, which is why only the first word counts — the alternative is a
 * patient's answer to Sweetie's question about dinner turning their invites off.
 */
export function smsKeyword(body: string | null | undefined): "stop" | "start" | null {
  const first = (body ?? "").trim().toLowerCase().split(/[\s,.!;:]+/)[0] ?? "";
  if (!first) return null;
  if (STOP_KEYWORDS.includes(first)) return "stop";
  if (START_KEYWORDS.includes(first)) return "start";
  return null;
}

/**
 * A phone number in the one shape the database stores, so a notification about `(415) 555-0100` finds the
 * patient saved as `+14155550100`. Ten digits are assumed to be North American, which is what `+1` on every
 * number this app has ever been given means; anything else keeps the country code it arrived with.
 *
 * Null when there is no plausible number in the string at all. A notification we cannot match a patient to is
 * reported as unmatched rather than guessed at (lib/notifyStore.ts).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** The address as a comparison key. SES quotes the domain in whatever case the sender typed. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  // `Name <a@b.c>` is how a bounce sometimes names the recipient.
  const bracketed = value.match(/<([^<>]+)>/)?.[1];
  const address = (bracketed ?? value).trim();
  return /^[^<>@\s]+@[^<>@\s]+\.[A-Za-z]{2,}$/.test(address) ? address : null;
}
