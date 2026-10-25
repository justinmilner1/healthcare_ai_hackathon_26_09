// Where the patient flow offers the patient their own summary, and in what words (design §2.5, §2.7).
// Owner: sweetie.
//
// Five surfaces make one promise: the setup-complete step at the end of `/s/<token>/intake`, the skip
// link in Sweetie's chat, the goodbye the route writes when that link is pressed, and the two cards that
// end the transcript — the completion card (T137) and the one the safety scan stops the interview with
// (T141). Each one tells the patient they can go and look at what they shared, and each one used to
// decide that on a condition of its own — all of them weaker than the condition `/patient/<token>`
// renders a summary on, which is `status.hasDexcom`, i.e. one glucose reading or more (lib/bundle.ts).
//
// That gap is this file. T116 (§2.5, §2.7) fixed the setup-complete step for a patient who had shared
// *nothing*; the same false sentence survived for a patient who had shared something with no glucose in
// it, because `connectedCount > 0` counts a WHOOP CSV and a Timeline export, neither of which produces a
// reading. So a patient who uploaded only their sleep history was told "Your week is ready to view",
// pressed "View my week", and landed on the empty summary asking them to go back and share a Dexcom
// export. The route's goodbye did it on `turns > 0`: one typed message, nothing uploaded, "You can view
// your week now", same dead end (T133).
//
// So the condition and the words live together, in one pure module every state of which a unit test can
// sweep (§12.1), rather than once per surface in two pages and a route:
//
// - **Offer the summary only on `hasGlucose`** — the same predicate that renders one, not a proxy for it.
// - **Name no span, in any state.** T100 → T114 → T123 took that rule across the patient path one screen
//   at a time: a span is read off the data (`spanNoun`, lib/plural.ts) at the three sites that know how
//   many days arrived, and nowhere else. None of these three surfaces is one of them — this step runs
//   before any of it is computed — so the answer is to name no span, as T123's empty branch does, not to
//   guess one here.
//
// The destination's own words are what the offer is written from: `/patient/<token>` heads its chart card
// "Your glucose" (app/patient/[id]/page.tsx), which is exactly what `hasGlucose` guarantees is there.
//
// One of the five asks a second question as well. The completion card is a headline over that offer, and a
// headline has to be true of the check-in and not only of the data: "Your check-in is complete" over a
// check-in the patient stopped short is wrong however honest the sentence under it is. So that title turns
// on `intakeEnding` (lib/intakeProgress.ts) — the rail's and the stepper's answer, not a new one (T146).

import type { IntakeEnding } from "./intakeProgress";

/** What this visit has, as the two conditions the copy below turns on. */
export type SummaryPromise = {
  /** Any source at all: Dexcom, WHOOP or Timeline. What the setup-complete card's first row counts. */
  hasConnections: boolean;
  /** A glucose reading or more — `status.hasDexcom`, the condition `/patient/<token>` renders on. */
  hasGlucose: boolean;
};

export type SetupCompleteCopy = {
  /** Sweetie's bubble beside the card. */
  bubble: string;
  /** The sentence over the card. */
  lede: string;
  /** The line under the primary action. */
  hint: string;
  /**
   * The words on the primary button when there is a summary to send the patient to, and `null` when
   * there is not — in which case the chat is the primary action, the way T116 left the empty column.
   */
  action: string | null;
};

/**
 * The setup-complete step, for whichever of its three states this visit is in (§2.5, §2.7).
 *
 * Three, not two. The card's first row has always had two states and reports the count honestly (T84),
 * but the four strings around it had only the row's own question — was anything shared — and the thing
 * they offer needs the other one: was any of it glucose.
 */
export function setupCompleteCopy({ hasConnections, hasGlucose }: SummaryPromise): SetupCompleteCopy {
  // Glucose is in, so there is a summary at the other end of the button and the step can say so. "Your
  // glucose" is the heading the destination opens that data with; what it is not is a span, which this
  // step cannot know and used to claim twice over ("Your week is ready to view", "View my week").
  if (hasGlucose) {
    return {
      bubble: "Your glucose is ready to view. Questions are optional.",
      lede:
        "Go straight to your glucose without answering questions. If you'd like to share more before " +
        "your visit, chatting with Sweetie is optional.",
      hint: "Skip the questions. Your shared data stays saved.",
      action: "View my glucose",
    };
  }
  // Something was shared and none of it was glucose — a WHOOP CSV, a Timeline export, or both. §2.5 makes
  // every one of those optional and worth having, so the step thanks the patient for what is saved and
  // then says plainly that there is nothing to look at, rather than offering a summary the destination
  // would have to deny. The two things that lead somewhere real are the two that are offered: more data,
  // and Sweetie.
  if (hasConnections) {
    return {
      bubble: "Your data is saved. There's nothing to view without glucose.",
      lede:
        "What you shared is saved for your care team. There's nothing to show you yet without your " +
        "glucose readings — you can go back and add them, or tell Sweetie what's going on before your " +
        "visit. Both are optional.",
      hint: "A short chat still gives your clinician something to work from.",
      action: null,
    };
  }
  // Nothing at all, which is T116's column and unchanged by T133.
  return {
    bubble: "Nothing shared yet. We can still talk it through.",
    lede:
      "You haven't shared any data, so there's nothing to show you yet. You can go back and add some, " +
      "or tell Sweetie what's going on before your visit — both are optional.",
    hint: "A short chat still gives your clinician something to work from.",
    action: null,
  };
}

/**
 * The skip link in Sweetie's chat (§2.5).
 *
 * Whether to offer the skip at all is a different question, and the chat page answers it correctly: there
 * is nothing to skip to until the patient has answered something or shared something. This is only what
 * the link says once it is there — and it said "Skip the rest and view my week" on that same wider
 * condition, which is the route's goodbye as a button.
 */
export function skipLinkLabel(hasGlucose: boolean): string {
  return hasGlucose ? "Skip the rest and view my glucose" : "Skip the rest of the questions";
}

/**
 * Sweetie's goodbye when the remaining questions are skipped (§2.5).
 *
 * The gate above this in app/api/sweetie/route.ts — refuse the skip outright when nothing has been
 * answered and nothing uploaded — is right and stays. What overreached was the last sentence: a patient
 * who typed one message and uploaded nothing satisfied it and was told "You can view your week now".
 */
export function skipGoodbye(hasGlucose: boolean): string {
  const saved =
    "You've skipped the remaining questions. Anything you've already shared is saved for your care team.";
  return hasGlucose ? `${saved} You can view your glucose now.` : saved;
}

/**
 * Where the press on the chat's skip link lands (§2.5, §2.7).
 *
 * T133 made the three sentences above honest and left the navigation under them alone, so the no-glucose
 * press still pushed `/patient/<token>`: the patient asked to stop answering questions and was moved,
 * unasked, to a card headed "Your glucose story is ready for its first chapter" whose only button sends
 * them back to the chat they were on — and the goodbye the route had just committed never painted (T137).
 *
 * The destination is the same question as the words on the button, so it is answered here rather than by
 * a fourth predicate written beside them. With glucose, the summary the label offers. Without it, `null`:
 * stay in the chat, which is where `skipGoodbye(false)` can be read and where §2.5's remaining action is.
 */
export function skipDestination(hasGlucose: boolean, token: string): string | null {
  return hasGlucose ? `/patient/${token}` : null;
}

/** The card that ends the transcript once the intake has wrapped. */
export type CheckInCompleteCopy = {
  /**
   * The headline. The check-in is over either way, so this does not turn on the data — but *how* it ended
   * is a different question, and one the card used not to ask at all (T146).
   */
  title: string;
  /** The line under it — the one that either offers the summary or says what was kept instead. */
  detail: string;
  /**
   * The mark in the tile to the left of the title, which has to say what the title says (T152).
   *
   * It is here rather than in the page because it is the title's own fact in one character: a card headed
   * "Check-in ended early" beside a glyph meaning "done" is the contradiction T146 took off the stepper,
   * one element over. Returning the two from one branch is what stops them drifting again, and is the
   * shape `intakeStepperEnd` already uses for the strip's last step (lib/intakeProgress.ts).
   *
   * The page renders it `aria-hidden`, so this is decoration of the title and never part of the card's
   * accessible name.
   */
  glyph: string;
};

/**
 * The completion card at the end of Sweetie's transcript (§2.5).
 *
 * It is the fourth surface of the same promise, and the one a skipped check-in now stays on: its whole
 * box was a link to `/patient/<token>` under "See the summary you'll share with your doctor", on nothing
 * but `wrapped`. Keeping the patient in the chat would have been worth little with that card sitting
 * under the goodbye, offering in a heading what the sentence above it had just declined to offer. So the
 * card asks the same question as everything else here: with glucose it is the link it was, and without it
 * it is a statement — `skipDestination` returns `null` and the page renders no anchor around this copy.
 */
export function checkInCompleteCopy(hasGlucose: boolean, ending: IntakeEnding): CheckInCompleteCopy {
  // Only a check-in that reached the end of the template is complete. The title was unconditional, so a
  // skip — which wraps the intake like any other ending — was congratulated on completing the questions it
  // had just declined, one viewport below a rail reading "Check-in ended early" (T146). The ending comes
  // from lib/intakeProgress.ts rather than from a fifth expression over `wrapped` here, so §2.5 has one
  // answer to "how did this check-in end" and the card says it in the same words the rail and the stepper
  // do. The sub-line is a different question — is there anything to look at — and keeps its own.
  const endedEarly = ending === "skipped" || ending === "flagged";
  return {
    title: endedEarly ? "Check-in ended early" : "Your check-in is complete",
    // The same branch as the title, because it is the same claim (T152). §2.5 now has three endings in
    // every element on this screen, and this is the last one that was answering the retired question: the
    // tick was a literal in both arms of the page's render, so "Check-in ended early" wore the glyph that
    // means complete and — not being hidden — read it out first.
    //
    // An en dash rather than the flagged card's "!": a skip is not an alarm. The exclamation is §2.5's
    // safety ending, which sends the patient to a person, and borrowing it here would make a patient who
    // simply had no more to say read their own card as the urgent one. A dash claims nothing in either
    // direction, which is exactly the state of a check-in whose questions were left unanswered, and it is
    // distinguishable from both the other two at the 30px the tile draws it at. The card itself stays the
    // green one — what the patient did share *is* saved for their care team, which is the sub-line below —
    // and app/globals.css mutes the tile this mark sits in, keyed on the same ending. Only the claim to
    // completeness was wrong.
    glyph: endedEarly ? "–" : "✓",
    detail: hasGlucose
      ? "See the summary you'll share with your doctor"
      : "What you shared is saved for your care team",
  };
}

/** The line under §2.5's office instruction on the flagged card, and where it goes. */
export type FlaggedCardCopy = {
  /**
   * Where the line leads: the summary when there is one, and `null` when there is not — in which case the
   * page renders the words as a statement rather than wrapping them in an anchor.
   */
  href: string | null;
  /** The words themselves: the offer where there is a destination, and what was kept where there is not. */
  detail: string;
};

/**
 * The card §2.5's safety scan ends the transcript with (T66, T141).
 *
 * The fifth surface of the same promise, and the last one to ask the question. T66 demoted the summary link
 * to the second thing on this card, under the instruction to call the office, and T137 put the other four
 * offers behind `hasGlucose` — but this card is rendered by its own branch of the same component, so the
 * anchor stayed there on nothing but the flag. A patient who typed one sentence about chest pain, uploaded
 * nothing, and was told to call the office was offered, underneath that, a link to a page headed "Your
 * glucose story is ready for its first chapter" whose only button sent them back to the check-in that had
 * just stopped talking to them.
 *
 * So the destination is this module's `skipDestination` rather than a fifth predicate, and the words are
 * read off it: wherever there is an offer there is somewhere to go, and wherever there is not there is
 * neither. The no-glucose state is not silence — the patient has just described something urgent and needs
 * to know it reached their clinician — so it keeps `checkInCompleteCopy(false)`'s sentence, which says
 * exactly that and promises nothing to look at.
 */
export function flaggedCardCopy(hasGlucose: boolean, token: string): FlaggedCardCopy {
  const href = skipDestination(hasGlucose, token);
  return {
    href,
    // T66's wording, unchanged, where there is something to see. §2.5's instruction stays the headline
    // either way; this is only the line under it.
    detail: href ? "See what you've shared so far" : checkInCompleteCopy(false, "flagged").detail,
  };
}
