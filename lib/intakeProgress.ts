// The progress card in Sweetie's rail: how far the check-in got, and what to say about it (design §2.5, §6.5).
// Owner: sweetie.
//
// The card has three parts — a label, a percentage with a track under it, and a sentence — and they used to
// be decided by three different expressions in app/s/[token]/page.tsx. Two of them asked different
// questions. The number counted the fields the patient actually answered plus the wrap, and the sentence
// asked `finished` alone, so a patient who answered one of two questions and pressed "Skip the rest of the
// questions" read:
//
//     Conversation progress                      67%
//     [a track two thirds full]
//     Your story is ready
//
// — a third of the check-in outstanding, drawn, beside a sentence saying it was done (T142). At 375px the
// sentence is not rendered at all, so the same patient got the bare 67% and nothing to explain it.
//
// T66 already settled what this card does when an intake ends short: for a flagged check-in it drops the
// number *and* the track and says why in words, "rather than drawing a part-full track next to it". A skip
// is the other way an intake ends short, so it is given the same shape here. What makes that reliable is
// that one function now decides all three parts together: there is no state in which the label, the number
// and the sentence can disagree, because they are returned from the same branch.
//
// The percentage keeps its old arithmetic for a check-in still in progress — the fields plus the wrap, so
// the track is never full while Sweetie is still asking — and a check-in answered to the end reads 100,
// unconditionally, rather than a count that happens to come to it.

/** How this check-in stands, and if it is over, how it ended. */
export type IntakeEnding =
  /** Sweetie is still asking. */
  | "open"
  /** The questions were answered and Sweetie said goodbye. */
  | "answered"
  /** The patient pressed "Skip the rest of the questions" with some of them still unanswered. */
  | "skipped"
  /** The safety scan stopped the interview (§2.5, T66). */
  | "flagged";

/** What the page knows about the intake by the time it draws the card. */
export type IntakeProgressInput = {
  /** How many fields `fieldsFor` built for this visit (lib/sweetie.ts). */
  totalFields: number;
  /** How many of them are filled to medium or high confidence. */
  completeFields: number;
  /** `status.done || intake.wrapped`: Sweetie is not asking anything more. */
  finished: boolean;
  /** `intake.flagged`: the safety scan fired. */
  flagged: boolean;
  /** `intake.questionsSkipped`: the patient chose to finish without the rest. */
  questionsSkipped: boolean;
  /** What to call the practice in the flagged sentence — `providerLabel(provider)` on the page. */
  office: string;
};

/** The three parts of the card, decided together. */
export type IntakeProgressCard = {
  ending: IntakeEnding;
  /** The label on the left of the top row. */
  label: string;
  /**
   * The percentage, and with it the track: a number means both are drawn, `null` means neither is. An
   * ending that stopped short has no honest percentage to show, so it shows none (T66, T142).
   */
  percent: number | null;
  /** The sentence under the card. Present in every state, including the two with no number. */
  detail: string;
};

/**
 * Which of the four states this check-in is in.
 *
 * The order matters. A flagged intake is also a wrapped one, and a skip wraps the intake too, so "finished"
 * on its own cannot tell the three endings apart — which is the whole of T142. A skip that left nothing
 * unanswered is not an early ending at all: the patient pressed the link after filling the template, so the
 * card reads the same as any other completed check-in rather than apologising for a gap that is not there.
 */
export function intakeEnding({
  totalFields,
  completeFields,
  finished,
  flagged,
  questionsSkipped,
}: Omit<IntakeProgressInput, "office">): IntakeEnding {
  if (flagged) return "flagged";
  if (!finished) return "open";
  if (questionsSkipped && completeFields < totalFields) return "skipped";
  return "answered";
}

export function intakeProgressCard(input: IntakeProgressInput): IntakeProgressCard {
  const { totalFields, completeFields, office } = input;
  const ending = intakeEnding(input);
  switch (ending) {
    case "flagged":
      // T66's card, unchanged: §2.5 has sent the patient to a person, and a part-full track beside that is
      // the wrong pair of facts.
      return {
        ending,
        label: "Check-in stopped",
        percent: null,
        detail: `We stopped early so ${office} can look at this now.`,
      };
    case "skipped":
      // The same shape for the other early ending. The sentence is what the card has instead of the number,
      // so §6.5 asks it to survive at 375px as well — app/globals.css un-hides it for this state.
      return {
        ending,
        label: "Check-in ended early",
        percent: null,
        detail: "You skipped the rest — what you shared is saved for your care team.",
      };
    case "answered":
      return { ending, label: "Conversation progress", percent: 100, detail: "Your story is ready" };
    default: {
      // Still going: the fields plus the wrap, so the track cannot read full while a question is still
      // outstanding. `totalFields` is 0 only before GET /api/sweetie has answered with the template.
      const steps = totalFields + 1;
      return {
        ending,
        label: "Conversation progress",
        percent: Math.round((completeFields / steps) * 100),
        detail: `${completeFields} of ${totalFields || "—"} questions answered`,
      };
    }
  }
}

/** The last step of the intake stepper: what it is called, whether it is ticked, and its tooltip. */
export type IntakeStepperEnd = {
  /** The word on the pill — what happened, not what was hoped for. */
  label: string;
  /** Whether the step takes the tick. Only a check-in that answered the questions earns one. */
  done: boolean;
  /** The step's `title`, which says the same thing a second time and so has to agree with the first. */
  title: string;
};

/**
 * The stepper's last step, from the same ending the card above is drawn from (T146, §2.5).
 *
 * This is the fourth expression over how the check-in ended and the second this module owns, for the same
 * reason the card's three parts are decided in one branch: the strip sits three inches from the card, and
 * the two of them asked different questions. The strip asked `finished && !flagged`, which a skip answers
 * "done" to — a skip sets `questionsSkipped` *and* `wrapped` (lib/sweetie.ts) — so a patient who answered
 * one of two questions and pressed "Skip the rest of the questions" read
 *
 *     ✓ Why you're here · 2 Since last visit · ✓ Done
 *
 * with "Check-in complete" in the tooltip, next to a card that said "Check-in ended early". A tick on the
 * right of a step that is visibly outstanding.
 *
 * T66 settled the shape for the other early ending — a word for what happened, no tick — and a skip takes
 * it: the two states that stopped short are the two with no tick, and the one word differs because what
 * happened differs. `open` keeps the unticked "Done" it has always had, because there the word is the step
 * the patient is walking towards rather than a claim about a check-in that is over.
 */
export function intakeStepperEnd(ending: IntakeEnding): IntakeStepperEnd {
  switch (ending) {
    case "flagged":
      // T66's step, unchanged, down to the tooltip e2e/mobile.spec.ts finds it by.
      return { label: "Stopped", done: false, title: "Check-in stopped early and flagged for the office" };
    case "skipped":
      return {
        label: "Ended early",
        done: false,
        title: "Check-in ended early with questions unanswered",
      };
    case "answered":
      return { label: "Done", done: true, title: "Check-in complete" };
    default:
      // Still being asked: the step is ahead of the patient, so it is named and not ticked.
      return { label: "Done", done: false, title: "Check-in complete" };
  }
}
