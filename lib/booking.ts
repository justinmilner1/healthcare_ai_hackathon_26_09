// What the booking wizard says about the invite, before the button and after it (design §2.2, §2.3,
// §8.1). Owner: identity.
//
// The card is two lines about one event: a heading in the largest type on the screen and the sentence under
// it. They disagreed, for two tickets. T111 made the sentence branch on whether this deployment can send at
// all — `queued` from POST /api/book, which is the route's answer about the deployment and not about the
// queue — and left the heading a literal, so an office with no email and no SMS backend read, in order:
//
//   Journey Patient mvj64xdw is on the way.
//   Patient added. No invite sent: Sweet Spot cannot send email yet — ask whoever set it up for your office.
//
// That is the fifth time this repo has had to say that an unconfigured deployment does not get to claim a
// send (T91, T94, T110, T111, T120), and the first time the claim and its correction were in one card.
//
// So the two lines come from here, from one branch on one value, the way lib/plural.ts owns the span noun
// for the four patient-path sites (T114). A site that wants only the heading still gets it from the same
// call, so neither line can be changed without the other being looked at.
//
// T140 then found the other half of the same card's problem one press earlier, on the screen the decision is
// actually made on. Step 3 read "Saving creates the patient and sends their private Sweetie link on the
// channel you choose here." and "The secure link goes to …" over a button reading **Add patient & send →**,
// in the same office with no email and no SMS backend, and said nothing about it until the card above had to
// retract it. So this module owns both tenses of one claim — the forecast and the report — the way
// lib/importNote.ts owns both of the CSV import's: neither can be reworded without the other being looked at.
//
// T145 is the third of these, on the branch that is not about the deployment at all: a demo practice (§13.4)
// booking a prospect's real mobile number read "Saving creates the patient and sends their private Sweetie
// link …", "The secure link goes to +16505552652." and **Add patient & send →**, and nothing said otherwise
// until the delivery row did, minutes after the press. The fact was a column on the practice staff were
// signed in to the whole time, which is why this branch is the forecast's and not only the route's.
//
// Pure, and in lib/ rather than in the wizard, so every branch is held to in a unit test (§12.1). The words
// for *why* nothing went out are mostly not here: the deployment's are the route's `reason`, which comes
// from lib/notify.ts and is spelled in lib/delivery.ts, staff's words for a gap in the deployment and never
// a variable name (§3.7, §10.6). §13.4's are quoted from lib/demo.ts, which owns that rule and its sentence,
// for the same reason: one set of words per rule, wherever it is said. The dashboard is a client component,
// so nothing here may pull in Prisma — lib/demo.ts has no imports at all, which is what makes it quotable
// from a browser bundle.

import { DEMO_ONLY_TEST_ADDRESSES, demoBlockReason } from "./demo";
import { channelLabel, channelOf, channelsOf, type ContactChannel } from "./visitIntake";

/** What POST /api/book answered, plus the name the wizard has on screen. */
export type BookedSend = {
  /** The patient the visit was booked for, as staff typed it. */
  name: string;
  /** Whether an invite is really going out: a sender exists and the patient consented to it. */
  queued: boolean;
  /** The channels that can really send, which is not always the channels staff chose (T111). */
  channel?: string | null;
  /** Why nothing is going out, in staff's words, when nothing is. */
  reason?: string | null;
  /** Whether §2.2 matched a patient already on file instead of creating one. */
  patientReused?: boolean;
};

/** The two lines of the success card, decided together. */
export type BookedOutcome = {
  /** The heading: what happened to the patient, which is what the card is largest about. */
  heading: string;
  /** The sentence under it: what happened to the record, and what happened to the invite. */
  lede: string;
};

/**
 * The success card's heading and lede for one booking (§2.2, §2.3, §8.1).
 *
 * The patient was added on both branches, so the unsent heading says that and stops there: "ready for
 * Sweetie" is true of a visit whose link is about to be handed over at the desk, which is §8.1's fallback
 * and is in the card directly below. Only a deployment that can send says anyone is on the way.
 */
export function bookedOutcome({ name, queued, channel, reason, patientReused }: BookedSend): BookedOutcome {
  // A nameless booking cannot happen through the wizard — step 1 requires the name — but the heading is the
  // largest line on the card and " is on the way." is not a sentence, so it has a subject either way.
  const who = name.trim() || "The patient";
  const added = patientReused ? "Visit added for a patient you already had." : "Patient added.";
  if (queued) {
    return {
      heading: `${who} is on the way.`,
      lede: `${added} The invite is on its way by ${channelLabel(channel).toLowerCase()}.`,
    };
  }
  return {
    heading: `${who} is ready for Sweetie.`,
    lede: `${added} No invite sent${reason ? `: ${reason}` : ""}. Share the link below.`,
  };
}

// ---------------------------------------------------------------------------------------------
// The forecast: what step 3 of the wizard says before the button (§2.2, §8.1, T140).

/** What step 3 knows while the radio is still being chosen. */
export type PlannedSend = {
  /** The contact channel selected on the step, a `CONTACT_CHANNELS` id (lib/visitIntake.ts). */
  channel: string | null | undefined;
  /** Why this deployment cannot send, in staff's words, per channel — `inviteFaultByChannel()`, settled on
   *  the server and handed to the step as a prop (lib/notify.ts). A channel it can send on is absent, and so
   *  is `"none"`, which is a choice and not a fault.
   *
   *  The whole map rather than the one entry for the channel staff picked, because §13.4 can close half of a
   *  `"both"` booking and the deployment then has to be asked about the half that is left (T145). Handed the
   *  single entry, this module asked about a channel it was no longer going to use: an SMS-only office
   *  booking a real mobile and a reserved address into a demo practice read **Add patient & send →** over
   *  "The secure link goes to <the address>." — `inviteSendability("both")` has no fault, because the office
   *  can text — and the press then refused, because the only channel §13.4 left open was the email one
   *  nothing is configured behind. `inviteReach` never made that mistake; it asks
   *  `inviteSendability(channelOf(open))`, about what is actually left. So the lookup lives here, after the
   *  narrowing, inside the pure module where every branch is unit-tested. */
  faults?: Partial<Record<ContactChannel, string>>;
  /** The number and the address step 1 collected. Where the link would go, and — for a demo practice —
   *  what §13.4 is a rule about: the question is asked of the destination, not of the channel (T145). */
  phone?: string | null;
  email?: string | null;
  /** §13.4 Whether the practice this visit is being booked into is marked synthetic, which closes every
   *  channel whose destination is not itself reserved. Settled on the server and handed down as a prop, the
   *  way `fault` is: `Practice.isDemo` is a column and the dashboard is a client component (T145). */
  demo?: boolean;
};

/** The three things step 3 says about the invite, decided together. */
export type BookingPlan = {
  /** The lede under "Ready for the handoff.": what pressing the button does. */
  lede: string;
  /** The note under the channel radios: where the link goes, or that it is not going anywhere. */
  note: string;
  /** Whether `note` is a gap in the deployment rather than the practice's own choice — what the step marks,
   *  the way `.settings-invite-hint-blocked` marks the same fact on the practice settings card (T131). */
  blocked: boolean;
  /** The button, which must not promise a send the two lines above have already withdrawn. */
  action: string;
};

/** What the step says when the link really is going out: the wording before T140, unchanged. */
const WILL_SEND = "Saving creates the patient and sends their private Sweetie link on the channel you choose here.";

/** And when it is not, on either branch: the patient and the link are still made, and the link is staff's to
 *  hand over. No send either way, so the one sentence covers a practice that chose silence and a deployment
 *  that cannot break it; the note below is what tells them apart. */
const WILL_NOT_SEND = "Saving creates the patient and their private Sweetie link, which you hand over yourself.";

/** §8.1's fallback, worded for one patient at a desk rather than for a day of them (lib/importNote.ts).
 *  This is the clause §2.2's "Do not message" row has always carried, and T140's job was to reach it on the
 *  rows that cannot send either — so it is quoted rather than rewritten. Both branches below say it, in
 *  different positions in their sentence, so the capital is derived and the clause is written once. */
const HAND_IT_OVER = "copy the link from the dashboard and hand it over yourself";
const HAND_IT_OVER_FIRST = `${HAND_IT_OVER[0].toUpperCase()}${HAND_IT_OVER.slice(1)}`;

/**
 * What step 3 of the booking wizard says about the invite, before anything is saved (§2.2, §8.1, T140).
 *
 * One branch on one value, like `bookedOutcome` above: a lede, the note under the channel radios and the
 * button all read from the same answer, so the screen cannot promise a send in one of the three and retract
 * it in another. Which was the bug — across the press rather than across the screen, but the same bug.
 *
 * The order is the order of the three questions, and it is `inviteReach`'s (lib/notify.ts), so the forecast
 * and the press cannot disagree about which fact to name. "Do not message" is asked first because it is the
 * practice's own choice and keeps its own sentence whatever anything else says (`NO_CONSENT_TO_MESSAGE`,
 * T120). Then §13.4: a demo practice may write only to a reserved address or number, which is a column on
 * the practice and a destination typed on step 1 — both on this screen, and neither fixable by configuring
 * anything (T145). Only then is the deployment asked whether it can serve what is left.
 */
export function bookingPlan({ channel, faults, phone, email, demo }: PlannedSend): BookingPlan {
  if (channel === "none") {
    return {
      lede: WILL_NOT_SEND,
      note: `Nothing is sent. ${HAND_IT_OVER_FIRST}; opening it still sends them a code.`,
      blocked: false,
      action: "Add patient →",
    };
  }
  // §13.4 before the deployment's own gap, which is the order `inviteReach` answers the press in
  // (lib/notify.ts) and the reason the two cannot disagree. A demo practice may only write to a reserved
  // address or number, so the destinations typed on step 1 are what decides it — and a channel it may not
  // write to is closed however well this office is configured, which is what the sentence has to say.
  // `channelsOf` is empty only for "none", which returned above, so an empty `open` here means §13.4 closed
  // every channel staff chose — the case the route answers `queued: false` for.
  const open = channelsOf(channel).filter((c) => !demoBlockReason(Boolean(demo), c, c === "sms" ? phone : email));
  if (!open.length) {
    return {
      lede: WILL_NOT_SEND,
      note: `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Save this patient and ${HAND_IT_OVER}.`,
      blocked: true,
      action: "Add patient →",
    };
  }
  // The destination is what is left open, so the step cannot name a number §13.4 has just refused while the
  // other channel carries the invite. Blank until step 1 has one of them, which is not a fault.
  const to = [open.includes("sms") && phone?.trim(), open.includes("email") && email?.trim()].filter(Boolean).join(" and ");
  // And the deployment is asked about what §13.4 left open, not about what staff picked — `channelOf(open)`
  // is the same subset `inviteReach` hands `inviteSendability`, so the forecast and the press ask one
  // question. Asking about the unnarrowed channel is what let an SMS-only office promise a send on the email
  // half of a `"both"` booking that §13.4 had already reduced to that half (T145).
  const fault = faults?.[channelOf(open)];
  if (fault) {
    // The tense is the whole of this branch: the rows do not exist yet, so the sentence names the press it
    // is a forecast about — the cost of pressing the button is what the screen was missing — and stops
    // there. Nothing about the six-digit code, which the "none" sentence above can promise and this one
    // cannot: a deployment with no sender behind this channel may well have none behind the code either.
    return {
      lede: WILL_NOT_SEND,
      note: `No invite will be sent: ${fault}. Save this patient and ${HAND_IT_OVER}.`,
      blocked: true,
      action: "Add patient →",
    };
  }
  return {
    lede: WILL_SEND,
    // Blank until step 1 has a number or an address, which is not a fault and is said where it happens.
    note: `The secure link goes to ${to || "— add a number or address on the first step"}.`,
    blocked: false,
    action: "Add patient & send →",
  };
}
