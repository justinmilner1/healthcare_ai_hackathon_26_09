// Whether a week of WHOOP nights carries a recovery score at all, and what §2.7's sleep card is allowed to
// say about it (T205). Owner: front end.
//
// Pure, and in lib/ rather than in the page, for the reason every caption ticket since T198 has moved its
// wording here: a sentence that makes a claim about the data under it is a decision, and a decision the unit
// suite cannot call is one nothing holds (§12.1). The page's subtitle was a literal in the JSX, which is also
// why this one went uncaught for as long as it did — there was nothing in lib/ to write a test against.
//
// Recovery is optional twice over. §9.3 leaves WHOOP to the optional data panel, so the ordinary visit has no
// sleep card at all; and `parseWhoopCsv` (lib/sleep.ts) matches its columns loosely on purpose, so an export
// whose header names no recovery column yields `recovery: undefined` for *every* night of the upload rather
// than for a row here and there. `data/fixtures/whoop_alt_headers.csv` is that export, and the card drawn over
// it read "Nightly sleep and recovery from your connected data." above columns of hours, a tooltip whose
// recovery suffix had already dropped out, and a Recovery column of em dashes — the subtitle was the only
// element on the screen that mentioned the word.

import { patientSleepSpanClause } from "./sleepSpan";
import type { SleepNight } from "./types";

/**
 * The recovery scores these nights actually carry, which is the one reading everything below is made of.
 *
 * `lib/bundle.ts` takes `GlucoseStats.recoveryAvg` off this same array, and that average is what both
 * clinician surfaces branch their Sleep tile's hint on (app/provider/[id]/sour.tsx,
 * app/provider/visit/[id]/print/page.tsx) — so `computeStats` calls this rather than filtering again. That is
 * the point of extracting it: `recoveryAvg === null` and `anyRecoveryKnown` are then the same question asked
 * once, and the patient's card and the clinician's tile cannot reach different conclusions about one week.
 * T82 is the ticket that settled that an element's claim and the predicate behind it belong in one place; the
 * `anyPlaceKnown` it left in lib/spikePlaces.ts is this function's sibling for places.
 */
export function recoveryScores(sleep: SleepNight[]): number[] {
  return sleep.map((n) => n.recovery).filter((x): x is number => typeof x === "number");
}

/**
 * Whether any night of this upload has a recovery score.
 *
 * `some`, not `every`: a mixed week — some nights scored, some not — is a week whose card may still say
 * recovery, because there is a score on it to read. The nights without one are the em dash the table already
 * prints, which is a gap in a column the data does have and not a column the data does not have.
 */
export function anyRecoveryKnown(sleep: SleepNight[]): boolean {
  return recoveryScores(sleep).length > 0;
}

/**
 * Whether the table twin under the columns draws its **Recovery** column (components/SleepChart.tsx).
 *
 * A column header is itself a claim that the data has that field, which is what T82 settled for the rises
 * table's Where column: five rows of em dash report nothing but the column's own absence, and cost a phone a
 * third of its width to do it (§6.5). So the column is drawn exactly where some night has a score to put in
 * it, and the em dash goes back to meaning what it means in a mixed week — this night, not this export.
 *
 * The same predicate as the subtitle on purpose. A card whose sentence says recovery over a table with no
 * recovery column is T82's bug read twice in one frame, and one function is what stops the two drifting.
 */
export function sleepRecoveryColumn(sleep: SleepNight[]): boolean {
  return anyRecoveryKnown(sleep);
}

/**
 * The subtitle over §2.7's sleep card, which says only what the card beneath it shows.
 *
 * The recovery branch is the wording §2.7 has carried since the card was built and is left exactly as it was
 * (T205 AC4): a week with scores on it is the week that sentence was true of. The other branch drops the two
 * words it cannot support and keeps the rest of the sentence, so the two readings are one claim with and
 * without a clause rather than two sentences a reword could pull apart.
 *
 * `days` is the glucose span the page around the card is framed as, and the clause it may add is the second
 * thing this sentence could not say (T218): the nights come from a WHOOP export with its own range, so a
 * card drawn over more nights than the frame claims names its own span rather than inheriting the page's.
 * That decision is lib/sleepSpan.ts's and the clinician surfaces read the same predicate, which is what
 * stops this sentence and the heading on their sleep card concluding differently about one upload.
 *
 * Both clinician surfaces already hedge *recovery* correctly — their Sleep tile's `hint` is `undefined` when
 * `recoveryAvg` is null — which is why that half is still only asked here.
 */
export function patientSleepCardSubtitle(sleep: SleepNight[], days: number): string {
  const base = anyRecoveryKnown(sleep)
    ? "Nightly sleep and recovery from your connected data."
    : "Nightly sleep from your connected data.";
  const span = patientSleepSpanClause(sleep, days);
  return span ? `${base} ${span}` : base;
}
