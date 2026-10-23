// Where the patient flow offers the patient their own summary, and in what words (design §2.5, §2.7).
// Owner: sweetie.
//
// Three surfaces make one promise: the setup-complete step at the end of `/s/<token>/intake`, the skip
// link in Sweetie's chat, and the goodbye the route writes when that link is pressed. Each one tells the
// patient they can go and look at what they shared, and each one used to decide that on a condition of
// its own — all of them weaker than the condition `/patient/<token>` renders a summary on, which is
// `status.hasDexcom`, i.e. one glucose reading or more (lib/bundle.ts).
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
// sweep (§12.1), rather than three times over in two pages and a route:
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
