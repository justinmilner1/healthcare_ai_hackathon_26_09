// What a page may say about the span of the WHOOP nights drawn on it, when that span is not the glucose
// span the page is framed as (design §2.7, §7, §7.4). Owner: sour.
//
// T100 → T114 → T116 → T123 → T132 → T207 took one rule onto the patient path a string at a time: the span
// comes from the data, not from the brand. Every span claim on /patient/<token> reads `spanNoun(stats.days)`
// out of lib/plural.ts, so no literal can disagree with the `History` tile beside it.
//
// T218 is that rule broken from the other end, and nothing here names a wrong span. `stats.days` is derived
// from the **glucose series alone** (lib/bundle.ts, `computeStats`), while `bundle.sleep` is parsed from a
// WHOOP export — a separate upload with its own range, since the two exporters have unrelated default
// ranges and §9.3 leaves WHOOP to the optional data panel. Nothing reconciled them, so the glucose span was
// printed as the whole page's span and the sleep series silently overran it: `clarity_window.csv`'s one
// morning beside `whoop_cycles.csv`'s three nights drew a bar per night for Sat, Sun and Mon under a hero
// reading "YOUR DAY WITH SWEETIE", a `HISTORY / 1 / day` tile, and a `SLEEP / 6.8 / hours / night` tile
// averaging all three — two of which fall entirely after the only day of glucose the page is about.
//
// §7 makes the numbers code-generated and they are right for the data each came from, so this is a labelling
// decision and not an arithmetic one: nothing is clipped and no average moves. What the surfaces were
// missing is the admission that the two came from different spans, and the fix is the card naming **its own**
// span wherever it is wider than the frame around it. That decision is made once, here, and the patient
// page, the clinician's brief and §7.4's printed sheet all read it — the bargain lib/spikePlaces.ts struck
// for places and lib/sleepRecovery.ts for recovery, for the reason every caption ticket since T198 moved its
// wording into lib/: a sentence that makes a claim about the data under it is a decision, and a decision the
// unit suite cannot call is one nothing holds (§12.1).

import { countOf, spanNoun } from "./plural";
import type { SleepNight } from "./types";

/**
 * Whether these nights cover more of the calendar than the glucose span the page around them claims.
 *
 * A count against a count, which is what the two surfaces actually hold: `GlucoseStats` carries `days` and
 * not the window it was measured over, and one bar is one night (components/SleepChart.tsx), so the nights
 * are their own count. Strictly greater, because a sleep series *inside* the frame is not this bug — a week
 * of glucose with three scored nights on it is three nights of a week the page correctly claims, and the
 * `h/night` the tiles already print is honest about those.
 *
 * `days < 1` is not an overrun either, and that is the one branch worth stating: with no readings the page
 * makes no span claim at all for a card to contradict — the patient hero's nothing-shared branch names no
 * span (T116, T132) and both clinician surfaces gate their sleep card on `status.hasDexcom` — so there is
 * nothing here to reconcile and the comparison would read against a `0 days` nobody is shown.
 */
export function sleepSpanOverruns(sleep: SleepNight[], days: number): boolean {
  return days >= 1 && sleep.length > days;
}

/**
 * The nights named as their own count — `"3 nights"` — or `null` where they fit inside the frame.
 *
 * The one primitive the three surfaces' wordings below are composed from, so the patient's sentence, the
 * clinician's tile hint and the heading over the chart cannot reach different conclusions about one upload.
 * `countOf` agrees the noun with the number (lib/plural.ts), so a single night is `"1 night"`.
 */
export function sleepNightsClause(sleep: SleepNight[], days: number): string | null {
  return sleepSpanOverruns(sleep, days) ? countOf(sleep.length, "night") : null;
}

/**
 * The detail line under §2.7's `SLEEP` tile, which is an average and has to say what it averaged.
 *
 * `"hours / night"` was a literal in app/patient/[id]/page.tsx, and it is the true half of the claim: the
 * figure above it really is hours per night. What it could not say is *how many* nights, which is the whole
 * of T218 on that tile — `6.8 hours / night` beside a `HISTORY / 1 / day` tile reads as one night's sleep.
 * So the counted branch prints the nights instead of the bare rate; `MiniStat` draws this on one short line
 * under the number, which is why it is a count and not a sentence.
 *
 * The uncounted branch is left exactly as it was, so a week of glucose with a week of nights on it is the
 * frame it has always been and no committed §12.3 shot of one moves.
 */
export function patientSleepTileDetail(sleep: SleepNight[], days: number): string {
  const clause = sleepNightsClause(sleep, days);
  return clause ? `hours · ${clause}` : "hours / night";
}

/**
 * The clause §2.7's sleep card adds to its subtitle when its nights are wider than the page's frame.
 *
 * In the patient's own voice and naming both spans, because the card is read *against* the glucose above it:
 * a patient who uploaded one Clarity window and a fuller WHOOP export — the common pairing — needs to be
 * told which of the two the bars are, not merely that there are three of them. The noun for the glucose side
 * is `spanNoun`'s, like the four sentences the page composes from it, so this clause and the hero over it
 * cannot disagree about what arrived.
 *
 * Composed here rather than in lib/sleepRecovery.ts's subtitle so that the clinician wordings below and this
 * one are one reading of one predicate; `patientSleepCardSubtitle` appends it to whichever of its two
 * recovery branches it took.
 */
export function patientSleepSpanClause(sleep: SleepNight[], days: number): string | null {
  const clause = sleepNightsClause(sleep, days);
  return clause ? `These ${clause} cover more than the ${spanNoun(days)} of glucose above.` : null;
}

/**
 * The heading over the clinician's sleep card, on the brief (§2.6) and on §7.4's sheet.
 *
 * `"Sleep"` was a literal in both components, beside a chart card already headed
 * `Glucose, last {countOf(st.days, "day")}` — so the glucose card named its span and the sleep card beside
 * it inherited it. The counted branch makes the pair parallel and terse, which is the register §7 asks for:
 * `Glucose, last 1 day` next to `Sleep, 3 nights`. Only where it overruns, so the ordinary week keeps the
 * one-word heading the two surfaces were laid out around.
 */
export function clinicianSleepCardHeading(sleep: SleepNight[], days: number): string {
  const clause = sleepNightsClause(sleep, days);
  return clause ? `Sleep, ${clause}` : "Sleep";
}

/**
 * The hint under the clinician surfaces' `Sleep` stat tile: the nights it averaged, and the recovery score
 * it already carried.
 *
 * Both surfaces composed `recovery ${st.recoveryAvg}%` inline and hedged it on `recoveryAvg !== null`
 * (T205), which left the tile's `h/night` averaging three nights under a brief headed `last 1 day`. The two
 * clauses are joined here so neither surface decides the order, and `·` is the separator the tiles beside
 * this one already use for a second fact.
 *
 * `recoveryAvg` is passed rather than re-derived from `sleep`: it is the *rounded* average `computeStats`
 * put on the bundle and the figure the hint has always printed, and taking it twice is how the tile and its
 * own hint would come to differ by a point (the mistake lib/sleepRecovery.ts's `recoveryScores` exists to
 * stop). `undefined` rather than `""` on the empty branch, because `StatTile` renders the hint element only
 * when there is one.
 */
export function clinicianSleepTileHint(
  sleep: SleepNight[],
  days: number,
  recoveryAvg: number | null,
): string | undefined {
  const parts = [sleepNightsClause(sleep, days), recoveryAvg === null ? null : `recovery ${recoveryAvg}%`];
  const hint = parts.filter((p): p is string => p !== null).join(" · ");
  return hint === "" ? undefined : hint;
}
