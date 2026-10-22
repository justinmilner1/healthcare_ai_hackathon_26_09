// What the booking wizard's success card says (design §2.2, §2.3, §8.1). Owner: identity.
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
// Pure, and in lib/ rather than in the wizard, so every branch is held to in a unit test (§12.1). The words
// for *why* nothing went out are not here: they are the route's `reason`, which comes from lib/notify.ts
// and is spelled in lib/delivery.ts, staff's words for a gap in the deployment and never a variable name
// (§3.7, §10.6). The dashboard is a client component, so nothing here may pull in Prisma.

import { channelLabel } from "./visitIntake";

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
