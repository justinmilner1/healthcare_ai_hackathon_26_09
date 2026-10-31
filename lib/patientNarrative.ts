// The two sentences under §2.7's narrative cards — the patterns the model found and the questions it wrote
// for the visit — each agreeing with how many items the list beneath it actually holds (T206). Owner: front
// end.
//
// Pure, and in lib/ for the reason every caption ticket since T198 has moved its wording here: a sentence
// that makes a claim about the data under it is a decision, and a decision the unit suite cannot call is one
// nothing holds (§12.1). Both of these were literals in app/patient/[id]/page.tsx, and both were written for
// a plural the data need not have:
//
//     A few patterns worth noticing together.          over one bullet
//     Bring these into your visit, or use them as a starting point.   over one numbered line
//
// One item is not an edge case here, it is what §7 asks for. `lib/prompts.ts` bounds both arrays at 1 to 3
// and `lib/sourRun.ts` clamps with `clean(…, 3)`, so nothing raises the floor above one — and the clinician
// prompt *instructs* the model to return a single pattern in a named case ("If the data is unremarkable, say
// so in one pattern rather than inventing one"). So the single-pattern card is the well-controlled week, the
// best outcome §7 has to report, and it was the one §2.7 described least accurately. That is T199's reading
// of the empty chart caption, one card up the same page.
//
// Nothing caught it because neither card has ever been drawn by the suite: with no model gateway
// `degradedPair` (lib/sourRun.ts) writes `patterns: []` and `questions: []` for both audiences, so both
// cards are gated out of every spec and every committed screenshot. e2e/flows.spec.ts supplies the narrative
// itself rather than waiting for one.
//
// The headings over these two cards are deliberately not here. "What your week showed" makes no claim about
// a count, and "Things you might ask your doctor" is a bare plural noun naming the section — the same shape
// as the clinician's own `Patterns` and `Questions` headings, which this ticket records as making no claim
// about how many there are. What the card *counts* is the only thing that has to agree with the list.

import { plural } from "./plural";

/**
 * The subtitle over the patterns card, counting the bullets under it.
 *
 * Two agreements rather than two spelled-out sentences, the shape `patientChartCaption` uses in
 * lib/spikePlaces.ts: the noun phrase agrees, and so does the relation word after it. "Together" is a claim
 * that needs two things to hold between, so at one it is not softened, it is absent — the rest of the
 * sentence is the same sentence either way, which is what keeps a later reword from pulling the two
 * readings apart into two voices.
 *
 * Today's wording is kept at two and three (T206 AC1): that is the count it was written for.
 *
 * No branch at nought, like `patientSpikeCardHeading`: the card is rendered on `patterns.length` in
 * app/patient/[id]/page.tsx, so an empty array has no subtitle on screen to be wrong, and inventing words
 * for it would be wording no element ever carries.
 */
export function patientPatternsSubtitle(patterns: string[]): string {
  const n = patterns.length;
  const relation = plural(n, "", " together");
  return `${plural(n, "A pattern", "A few patterns")} worth noticing${relation}.`;
}

/**
 * The subtitle over the questions card, counting the numbered lines under it.
 *
 * Both pronouns agree, for the same reason the two halves of `patientChartCaption` do: a sentence that says
 * "these" in one clause and "it" in the next is a sentence half-fixed, which is the mistake T200 had to come
 * back for one caption down, where a plural survived after the comma. The verb and the rest of the clause
 * are untouched, so this is one sentence read at two counts rather than two sentences.
 */
export function patientQuestionsSubtitle(questions: string[]): string {
  const n = questions.length;
  return `Bring ${plural(n, "this", "these")} into your visit, or use ${plural(n, "it", "them")} as a starting point.`;
}
