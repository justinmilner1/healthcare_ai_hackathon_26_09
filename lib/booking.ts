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
// T170 is the fourth, on the branch that is not about a send at all. "Do not message" has always answered
// the whole question itself — "Nothing is sent. Copy the link … ; opening it still sends them a code." — and
// never looked at the number and the address it is handed, so the patient §2.2 has neither for read that
// line directly above T168's correction of the same claim: "the six-digit code their link needs has nowhere
// to go and the link will not open." One screen denying and promising one code, which is what T168 had just
// been filed to stop. The two sentences the code is true of and false of are therefore one branch on one
// value here, like the three above it.
//
// T175 is the fifth, and it is T170's branch one filter along. §8.1's fallback rests on the link opening, and
// the link opens on a six-digit code reaching the patient — which needs more than a field with something in
// it. It needs a destination §13.4 allows and a sender behind it, and "a number and no SMS backend" is a
// state this product is being piloted in and the gate cannot stand in. So the three branches that offer the
// handover — the practice's own silence, §13.4's refusal and the deployment's gap — all read one answer
// (`codeCanReach`), and the sentence that offers a way in is only said where there is one.
//
// T176 is the sixth, and it is T173's branch one field short of it. T173 asked the two *fields* whether this
// patient has anywhere to send to, and that answers "yes" for a patient with a number whose invite staff
// chose to email: the chosen channel still has nothing, so the step read the sending branch — the promise,
// the half-written "The secure link goes to — add a number or address on the first step." and **Add patient
// & send →** — with no warning beside it to contradict it, because `warningsFor` fires only when both fields
// are blank. So the question is asked of the *channels* staff picked, which is `inviteReach`'s own first
// filter, and the gap it leaves is named by the sentence the press has always refused it with (§2.2).
//
// Pure, and in lib/ rather than in the wizard, so every branch is held to in a unit test (§12.1). The words
// for *why* nothing went out are mostly not here: the deployment's are the route's `reason`, which comes
// from lib/notify.ts and is spelled in lib/delivery.ts, staff's words for a gap in the deployment and never
// a variable name (§3.7, §10.6). §13.4's are quoted from lib/demo.ts, which owns that rule and its sentence,
// for the same reason: one set of words per rule, wherever it is said. The dashboard is a client component,
// so nothing here may pull in Prisma — lib/demo.ts has no imports at all, which is what makes it quotable
// from a browser bundle.

import { NO_HANDOVER_EITHER, NO_HANDOVER_SENTENCE } from "./delivery";
import { DEMO_ONLY_TEST_ADDRESSES, demoBlockReason } from "./demo";
import type { NotifyChannel } from "./suppression";
import { channelLabel, channelNeeds, channelOf, channelsOf, type ContactChannel } from "./visitIntake";

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
  /** T173, T175 Whether handing the link over is a way in: false wherever the six-digit code the link needs
   *  cannot reach this patient at all (§2.3, §5.3), which is `canHandOver`'s question (lib/notify.ts).
   *  T173 asked only whether a detail was on file; a detail this deployment has no sender behind, or one
   *  §13.4 or §8.1 has closed, is the same dead end. `POST /api/book` answers it off the patient row it has
   *  just written. Optional and treated as true when absent, because it is a fact about the patient and the
   *  deployment rather than about the send, and a caller that has not got it must not be made to guess: the
   *  two routes that have it pass it. */
  handover?: boolean;
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
export function bookedOutcome({ name, queued, channel, reason, patientReused, handover }: BookedSend): BookedOutcome {
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
  // T173 §8.1's fallback is the last clause, and for one patient it is not a fallback: with neither a number
  // nor an address there is nowhere to send the six-digit code their link needs, so the link does not open
  // and sharing it is not a handover (§2.3, §5.3). The clause that withdraws it is lib/delivery.ts's, the
  // same one step 3's note three presses earlier reads, so the forecast and the report say it once each in
  // the same words. The heading is unchanged: the patient and their visit were added either way, which is
  // what "ready for Sweetie" says and all it says.
  const fallback = handover === false ? NO_HANDOVER_SENTENCE : "Share the link below.";
  return {
    heading: `${who} is ready for Sweetie.`,
    lede: `${added} No invite sent${reason ? `: ${reason}` : ""}. ${fallback}`,
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
  /** T175 Which of the two channels this deployment has a sender behind for the *six-digit code* — the
   *  message §8.1's handover rests on (§2.3, §5.3). `codeSenders()`, settled on the server and handed down
   *  beside `faults` (lib/notify.ts, app/provider/page.tsx).
   *
   *  Not derivable from `faults`, which is the *invite's* answer: the code's email goes through
   *  `sendOrMailbox` and the invite's does not, so a checkout naming `DEV_MAIL_DIR` can carry one and not
   *  the other — and that checkout is the gate (§11.3). Reading the invite's faults as the code's would have
   *  made the gate's own screens disagree with a deployment's.
   *
   *  Absent means unnarrowed, the way `handover` above is read as true when absent: a caller without the
   *  answer is not made to guess it, and every caller the product has passes it. */
  codeChannels?: readonly NotifyChannel[];
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

/** T170 The same row, for the patient §2.2 has neither a number nor an address on file for.
 *
 *  Both halves of the sentence above are about a patient there is somewhere to send a code to: the handover
 *  is the way in, and the code is what makes it one. With neither on file there is nowhere to send one, so
 *  the link does not open (`POST /api/verify`, components/VerifyGate.tsx) and the handover is not a remedy —
 *  and `warningsFor` says exactly that three lines below this on the same step (lib/visitIntake.ts), which
 *  is how the step came to deny the code in one line and promise it in the one above.
 *
 *  So this branch withdraws the half that is this note's — the handover it offers and the code that makes
 *  the handover work — and stops. The reason and the way out of it are the warning's, which is §2.2's own
 *  gap and the only line in the repo that owns it; saying either here would put two lines on one screen
 *  about one fact, which is the shape of every ticket in this family. Deliberately not ending on "the link
 *  will not open", for that reason: the warning ends on those words, and at 375px the two sit one above the
 *  other (`mobile-provider-add-visit-no-contact-silent.png`). The register is `cannotSendYet`'s and
 *  lib/teamInvite.ts's "they cannot sign in until it is fixed", and nothing of the deployment's is in it,
 *  because nothing here is the deployment's fault (§3.7, §10.6).
 *
 *  T173 Three callers now, which is why the clause behind it is lib/delivery.ts's: this note on the silent
 *  channel, the same note on the three sending ones — the combination the step opens on, which had the
 *  sending branch's promise and a half-written sentence — and the success card after the press
 *  (`bookedOutcome` above). One fact about one patient, in one sentence, wherever the screen is. */
const NO_WAY_IN = `Nothing is sent, and ${NO_HANDOVER_EITHER}.`;

/**
 * T175 Whether handing this patient their link is a way in, as step 3 can ask it: the link opens on a
 * six-digit code reaching them (§2.3, §5.3), which needs a destination on file that §13.4 allows and this
 * deployment has a sender behind.
 *
 * `canHandOver`'s question (lib/notify.ts), over the two fields step 1 has typed rather than over a patient
 * row that does not exist yet — the same asymmetry `bookingPlan` already has for §13.4 and for the invite's
 * own faults. §8.1's bounce and STOP are therefore not asked here and are asked at the press: they are the
 * one filter that needs a row, and §2.2 may not even have matched one yet.
 *
 * The code is sent on whatever the patient has, not on the channel staff chose for the invite, so this does
 * not look at `channel` at all — which is why one answer serves all four of the branches below.
 */
function codeCanReach({ phone, email, demo, codeChannels }: PlannedSend): boolean {
  const onFile: NotifyChannel[] = [];
  if (phone?.trim()) onFile.push("sms");
  if (email?.trim()) onFile.push("email");
  return onFile.some(
    (c) => !demoBlockReason(Boolean(demo), c, c === "sms" ? phone : email) && (!codeChannels || codeChannels.includes(c)),
  );
}

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
export function bookingPlan(planned: PlannedSend): BookingPlan {
  const { channel, faults, phone, email, demo } = planned;
  // T175 One answer, read by every branch that offers §8.1's fallback — and the reason the four of them are
  // one ticket: the fallback is the same remedy wherever it is offered, so what withdraws it is one fact.
  const handover = codeCanReach(planned);
  if (channel === "none") {
    // T170 The one thing this branch had never asked, although it has had both answers as parameters since
    // T140: whether there is anywhere to send the code it promises.
    //
    // T175 And the same question one filter wider, which is this ticket: a number with no SMS backend behind
    // it, or an address §13.4 will not write to, is as much nowhere to send a code as an empty field. What
    // promised one is this note's own last clause — "opening it still sends them a code" — so that is the
    // clause that goes, and `NO_WAY_IN` already says what is left.
    //
    // `blocked` stays false on both arms, which is what it is for: it marks a *reason* that is a gap in the
    // deployment, and neither arm states one. "Do not message" is the practice's own choice and the only
    // reason either sentence gives; the missing contact details are marked by the warning's own element
    // (`.patient-consent-warning`, T168), and a missing sender is named by the branches below, which are the
    // ones that have the deployment's sentence to state.
    return {
      lede: WILL_NOT_SEND,
      note: handover ? `Nothing is sent. ${HAND_IT_OVER_FIRST}; opening it still sends them a code.` : NO_WAY_IN,
      blocked: false,
      action: "Add patient →",
    };
  }
  // T173, T176 The first filter, and the one this function spent nine tickets without: of the channels staff
  // picked, which have a destination to send to at all. `inviteReach`'s own opening narrowing
  // (`channelsFor`, lib/notify.ts), asked over the two fields step 1 has typed rather than over a patient
  // row that does not exist yet — and asked *before* §13.4 and before the deployment, which is the order
  // the press answers in. A channel with nowhere to send to is not a channel a demo practice or an
  // unconfigured office closed, so naming either of them would answer the wrong gap.
  //
  // T173 reached this for the patient with both fields blank, by reading the fields rather than the
  // channels; T176 is the combination that leaves: one field filled and the *other* channel picked, where
  // reading the fields answers "there is something on file" and the chosen channel still has nothing. That
  // fell through to the sending branch at the bottom of this function, which promised the send, rendered
  // "The secure link goes to — add a number or address on the first step." and offered **Add patient &
  // send →** — with no warning beside it, because `warningsFor` fires only when both fields are blank.
  const wanted = channelsOf(channel);
  const onFile = wanted.filter((c) => (c === "sms" ? phone : email)?.trim());
  if (!onFile.length) {
    // Both fields blank: the "Do not message" answer word for word, because it is the same fact about the
    // same patient — nothing is sent, and the link that would be handed over does not open (§2.3, §5.3). The
    // reason and the remedy are `warningsFor`'s, three lines below on the same step (lib/visitIntake.ts).
    if (!(phone?.trim() || email?.trim())) {
      return { lede: WILL_NOT_SEND, note: NO_WAY_IN, blocked: false, action: "Add patient →" };
    }
    // T176 And one field filled, on the channel staff did not pick. `wanted` is a single channel here —
    // "Text and email" with either field filled leaves `onFile` non-empty — so the gap is that one channel's
    // missing field, which is the front desk's own and the only one of the four this step can name a remedy
    // for by naming the field. The sentence is the press's, from the module that owns it (`channelNeeds`,
    // lib/visitIntake.ts): the forecast and the refusal are one wording, not two about one field.
    //
    // Nothing else is said. §13.4 and the deployment are not asked, because neither closed this channel;
    // `warningsFor` is silent here, so there is no line to split a reason or a remedy with (T170); and the
    // handover is not offered, because saving is what the press refuses and "save this patient and …" would
    // be the next promise in this family. It is only *withdrawn*, where the code cannot reach this patient
    // either — the one thing a front desk reading "add the other field" would otherwise still get wrong.
    const needs = channelNeeds(wanted[0]);
    return {
      lede: WILL_NOT_SEND,
      note: handover ? needs : `${needs} ${NO_HANDOVER_SENTENCE}`,
      blocked: false,
      action: "Add patient →",
    };
  }
  // §13.4 before the deployment's own gap, which is the order `inviteReach` answers the press in
  // (lib/notify.ts) and the reason the two cannot disagree. A demo practice may only write to a reserved
  // address or number, so the destinations typed on step 1 are what decides it — and a channel it may not
  // write to is closed however well this office is configured, which is what the sentence has to say.
  // Over `onFile` and not over everything staff picked (T176): an empty `open` here means §13.4 closed every
  // channel that had somewhere to send, which is the case the route answers `queued: false` for.
  const open = onFile.filter((c) => !demoBlockReason(Boolean(demo), c, c === "sms" ? phone : email));
  // T175 The two branches that state a reason of their own — §13.4's rule and the deployment's own gap —
  // used to end on §8.1's fallback unconditionally, and that last clause is the one this ticket withdraws.
  // One shape for both, because the reason is all that differs between them and the remedy is the same
  // remedy: what the deployment cannot do keeps `cannotSendYet`'s sentence, and what it costs the handover
  // is lib/delivery.ts's clause, said once wherever it is said (§3.7, §10.6).
  const refused = (why: string): BookingPlan => ({
    lede: WILL_NOT_SEND,
    note: `No invite will be sent: ${why}. ${handover ? `Save this patient and ${HAND_IT_OVER}.` : NO_HANDOVER_SENTENCE}`,
    blocked: true,
    action: "Add patient →",
  });
  if (!open.length) return refused(DEMO_ONLY_TEST_ADDRESSES);
  // The destination is what is left open, so the step cannot name a number §13.4 has just refused while the
  // other channel carries the invite. T176 Never blank: `open` is a subset of the channels that have a
  // destination, so every channel in it contributes one and the sentence always names what it is about.
  const to = [open.includes("sms") && phone?.trim(), open.includes("email") && email?.trim()].filter(Boolean).join(" and ");
  // And the deployment is asked about what §13.4 left open, not about what staff picked — `channelOf(open)`
  // is the same subset `inviteReach` hands `inviteSendability`, so the forecast and the press ask one
  // question. Asking about the unnarrowed channel is what let an SMS-only office promise a send on the email
  // half of a `"both"` booking that §13.4 had already reduced to that half (T145).
  const fault = faults?.[channelOf(open)];
  // The tense is the whole of this branch: the rows do not exist yet, so the sentence names the press it is
  // a forecast about — the cost of pressing the button is what the screen was missing — and stops there.
  //
  // T175 It stopped one clause too late. "A deployment with no sender behind this channel may well have none
  // behind the code either" is what the comment here used to say, and where that is so the handover it was
  // offering is not one: the pilot's own case is a patient whose single detail is the channel this office
  // cannot serve, and `codeCanReach` is now what decides which remedy the sentence ends on.
  if (fault) return refused(fault);
  return {
    lede: WILL_SEND,
    // T176 The `${to || …}` fallback is gone with the branch that reached it: a sentence that names a
    // destination is only ever shown where there is one, and the half-written one it rendered instead —
    // "The secure link goes to — add a number or address on the first step." — named a step the front desk
    // had already filled in.
    note: `The secure link goes to ${to}.`,
    blocked: false,
    action: "Add patient & send →",
  };
}
