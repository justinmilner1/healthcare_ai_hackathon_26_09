// What the clinician's surfaces may say about GMI (design §2.6, §7, §7.4).
// Owner: sour. The brief's metrics row, the brief's one-line overview and the printed one-pager read it.
//
// GMI is `3.31 + 0.02392 * avg` (lib/sour.ts, lib/bundle.ts, lib/types.ts). It is a linear transform of the
// mean of whatever arrived, so unlike every other figure on that row it is *always* computable and never
// refuses: the number is never missing, only sometimes meaningless. Both surfaces labelled it
// `est. A1c from CGM` on any span, including the single-day uploads the e2e suite itself drives — an
// estimated A1c, which stands in for a three-month average, printed with a hint as flat as if a fortnight
// had arrived (T185).
//
// That is the overclaim T100, T123, T132, T136 and T138 took out of the patient's hero, the consent screen
// and the connect step, arriving on the clinician's side. It slipped past all five because those fixed
// headings that *named* a span and this hint names none. The two tiles either side of it already refuse:
// `Spikes > 180` asks lib/spikePlaces.ts whether a Timeline was ever shared, and `Sleep` reads `—` with
// "no WHOOP data" under it. The tile between them was the one on that row still written in the markup.
//
// Pure, and in lib/ rather than in the two components, for the reason lib/spikePlaces.ts is: the value and
// the hint are settled together, in one place, so the brief and the sheet cannot drift apart and the rule
// can be held to in a unit test (§12.1). `clinicianGmi` is the whole decision; neither call site keeps a
// literal.

/**
 * The span GMI needs before either surface may read it as an estimated A1c.
 *
 * **Fourteen days**, for two reasons that agree.
 *
 * The first is what the figure is for. GMI exists to be compared with a lab A1c — that is its entire
 * clinical job, and it is why the hint says "est. A1c" at all. The international CGM consensus the safety
 * thresholds in lib/sour.ts already follow puts that correspondence at about two weeks of wear: below it
 * the figure tracks the days that happened to arrive rather than the quarter a lab value covers, and a
 * single day of it is the mean of three meals wearing the name of a three-month average.
 *
 * The second is that this product already asks for exactly that span. lib/sweetie.ts tells the patient, in
 * the words it puts on their screen, to "choose the last 14 days" of their Clarity export — so fourteen is
 * not a number imported from outside the repo, it is the window Sweet Spot was built to receive. A Clarity
 * export is typically longer still (Clarity offers ninety days), so this threshold is ordinarily met by a
 * real upload and ordinarily missed by the suite's deliberately small fixtures, which is the right way
 * round.
 *
 * It is not met by the Dexcom *connection*, which fetches seven days (lib/dexcom.ts, §9.2), nor by the
 * seven-day demo sample. Those visits keep the number and lose the A1c claim, which is the honest reading
 * of them: seven days is a week of this patient, not an estimate of their quarter.
 */
export const GMI_A1C_MIN_DAYS = 14;

/** The sub-line where the span supports the claim. Unchanged from what both surfaces have always printed. */
export const GMI_A1C_HINT = "est. A1c from CGM";

/**
 * The sub-line where it does not.
 *
 * Staff's and the clinician's words, and only theirs: no variable, no field name, no formula and no
 * citation (§3.7, §10.6 keep those off a rendered surface). It does not repeat the span either — the
 * sub-header three lines above is already printing `1 day · 84 readings`, and a hint that said it again
 * would be spending the one line it has on the thing the reader has just read.
 *
 * So the line is spent on the one thing the tile cannot otherwise say. The label above it already names
 * what the figure *is* ("GMI"), so what is left to say is what it is not yet, and what would make it so.
 * The threshold is written out rather than interpolated, for the no-variable rule above; lib/gmi.test.ts
 * holds the two to each other so they cannot drift.
 */
export const GMI_SHORT_SPAN_HINT = "needs 14 days to estimate A1c";

/** What the two clinician surfaces print for GMI on this visit. */
export type GmiReport = {
  /** The figure, rounded as the tile has always rounded it. */
  value: string;
  /** The tile's sub-line: `GMI_A1C_HINT`, or what the span makes the figure instead. */
  hint: string;
  /**
   * The `GMI 6.1%` clause of the brief's one-line overview, or `null` to leave it out.
   *
   * The asymmetry with `value` is deliberate and is the §2.6 half of this ticket. The overview line
   * (`In range 76% · avg 117 · GMI 6.1% · 7 spikes`) is read at a glance and has nowhere to put a
   * qualifier, so a bare `GMI 6.1%` there is the unqualified claim this ticket is about, said a second time
   * on the same screen with no sub-line under it to scope it. The tile has that line and keeps the number;
   * the overview has not and drops it, keeping `avg`, which is the figure GMI is a transform of anyway.
   *
   * One predicate decides both, which is the point: the tile and the line above it cannot come to
   * different conclusions about the same number on one screen.
   */
  overview: string | null;
};

/**
 * The one answer the brief's GMI tile, the brief's overview line and the printed sheet's tile all read.
 *
 * `stats` is `PatientBundle.stats` (lib/bundle.ts `computeStats`), the argument both call sites already
 * have in hand: `days` is the span of the readings and `gmi` the figure. Nothing is computed or fetched
 * here that the surfaces did not already have — the fact needed was always on the row, beside the number.
 *
 * `days` is 0 only where there are no readings at all, which `computeStats` answers with `gmi: 0`. That
 * falls on the short-span side, as it must: a `0.0 %` labelled as an estimated A1c is the overclaim with
 * nothing behind it whatsoever. Both surfaces draw this row only when `status.hasDexcom`, so that case is
 * reached by a visit whose upload parsed to nothing rather than by the ordinary empty visit.
 */
export function clinicianGmi(stats: { days: number; gmi: number }): GmiReport {
  const value = stats.gmi.toFixed(1);
  if (stats.days >= GMI_A1C_MIN_DAYS) return { value, hint: GMI_A1C_HINT, overview: `GMI ${value}%` };
  return { value, hint: GMI_SHORT_SPAN_HINT, overview: null };
}
