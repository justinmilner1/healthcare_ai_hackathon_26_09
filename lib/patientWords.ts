// What the clinician's "In the patient's words" block shows, decided in code (design §2.6). Owner: front end.
//
// The block renders on two surfaces — the working brief (app/provider/[id]/sour.tsx) and the printed
// one-pager (app/provider/visit/[id]/print/page.tsx, §7.4) — so the decision is one pure function with one
// test rather than the same ternary written twice. Pure on purpose, like lib/sourState.ts beside it: no
// database, no model, no React.
//
// Both surfaces used to quote `Visit.notes` whole and call it the patient's words. That holds for the wrap
// §6 is written for, where `renderNotes` (lib/sweetie.ts) builds the notes out of the fields Sweetie filled,
// and it is false for the one ending where it matters most (T154). The §2.5 safety scan fires before any
// extraction (lib/sweetieTurn.ts), so a flag on the patient's *first* message wraps the visit with every
// field `unfilled` — and `renderNotes` then has nothing of theirs to emit. The brief read:
//
//     In the patient's words
//       ⚠ Safety flag during intake: cardiac or breathing. Patient was told to call the office.
//       Visit: Follow-up. Called about: tired all the time
//
// Two machine-written lines, one of them typed by staff into the booking form, presented as a quotation —
// while "I had chest pain yesterday evening and it really scared me." reached no clinician surface at all.
//
// So the patient's own chat rows are what this quotes when the notes hold no answer of theirs
// (`patientMessages` on the bundle, lib/bundle.ts), the machine-written lines are kept but moved out of the
// quotation into `context`, and a check-in nobody wrote in says so. The ordinary wrap is untouched: notes in
// one quotation, no note above it and no context beside it, exactly as the brief has rendered it since §2.6
// was built.

import { notesHaveAnswers } from "./sweetie";
import type { IntakeFieldDef, IntakeState } from "./types";

/**
 * How many of the patient's messages the block quotes. The interview is six questions long
 * (`MAX_TURNS`, lib/sweetieTurn.ts), so six covers every check-in that ran its course; what can run past it
 * is a flagged visit, where §2.5 has taken the composer away and each further message is one the patient
 * went out of their way to send. The sheet is a one-pager (§7.4), so the overflow is counted rather than
 * printed — never dropped in silence.
 */
export const MAX_QUOTES = 6;

export type PatientWords = {
  /** The sentence above the quotation, or in place of it when there is nothing to quote. Empty on the
   *  ordinary wrap, whose answers need no explaining. */
  note: string;
  /** The patient's own text, verbatim, oldest first — one block each. On a wrap that filled fields this is
   *  the single `Visit.notes` string, which is those answers in the words `renderNotes` wrote for Sour. */
  quotes: string[];
  /** The patient's messages past `MAX_QUOTES`, counted so the block can say they exist. */
  more: number;
  /** The machine-written lines of `Visit.notes` — the safety-flag line, the booked reason, the skip
   *  notices — kept for the clinician but outside the quotation, because they are nobody's words. Only
   *  populated when the notes carry no answer of the patient's; an ordinary wrap keeps them inside its
   *  quotation, where §2.6 has always had them. */
  context: string[];
};

/**
 * Typed structurally rather than against `PatientBundle` (the way lib/auditLog.ts types `visitPartsRead`),
 * so a test can state one case in four fields instead of building a whole bundle. A `PatientBundle`
 * satisfies it.
 */
export type PatientWordsInput = {
  patient: { notes: string | null };
  intake: IntakeState;
  intakeFields: IntakeFieldDef[];
  patientMessages: string[];
};

export function patientWords(bundle: PatientWordsInput): PatientWords {
  const notes = (bundle.patient.notes ?? "").trim();

  // The ending §2.6 was built for: Sweetie filled fields, so the notes are the patient's account of their
  // week and the quotation is the notes. Unchanged, down to the markup the surfaces wrap it in.
  if (notes && notesHaveAnswers(bundle.intake, bundle.intakeFields)) {
    return { note: "", quotes: [notes], more: 0, context: [] };
  }

  const said = bundle.patientMessages.map((m) => m.trim()).filter(Boolean);
  const context = notes ? notes.split("\n").map((l) => l.trim()).filter(Boolean) : [];

  if (said.length) {
    return {
      note: bundle.intake.flagged
        ? "The safety scan stopped the check-in before any question was answered. What the patient wrote:"
        : "Nothing the patient wrote filled one of Sweetie's questions. What they wrote:",
      quotes: said.slice(0, MAX_QUOTES),
      more: Math.max(0, said.length - MAX_QUOTES),
      context,
    };
  }

  // Nothing of the patient's, on either side. `renderNotes` always writes at least the visit line, so notes
  // with no messages behind them is a check-in the patient has not typed into; no notes at all is one that
  // has not run a turn.
  return {
    note: context.length ? "The patient wrote nothing in the check-in." : "Sweetie has not collected answers yet.",
    quotes: [],
    more: 0,
    context,
  };
}

/** The one line the block prints for an overflow, so both surfaces word it the same way. */
export const moreMessagesLine = (more: number): string =>
  `${more} further ${more === 1 ? "message" : "messages"} in the check-in, not shown here.`;
