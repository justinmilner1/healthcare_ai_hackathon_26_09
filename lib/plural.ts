// Counting nouns for the Sour brief (design §7). A one-pager that leads with numbers cannot print "1 days":
// the noun has to agree with the number in front of it. The screen and the printed sheet are twins (§7.4),
// so the rule lives here and both call it rather than each spelling the plural out.

/** The right form of a counting noun for `n`. `-1` is singular too: "1 day below", not "1 days below". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return Math.abs(n) === 1 ? singular : pluralForm;
}

/**
 * `n` with its noun, agreeing: `countOf(1, "day")` is `"1 day"`, `countOf(0, "spike")` is `"0 spikes"`.
 * The number is grouped (`"1,440 readings"`) because the counts this prints — readings in a week — run
 * past a thousand. Irregular nouns pass their plural: `countOf(2, "entry", "entries")`.
 */
export function countOf(n: number, singular: string, pluralForm?: string): string {
  return `${n.toLocaleString()} ${plural(n, singular, pluralForm)}`;
}

/**
 * The span a share of readings was computed over, in the patient's own voice (design §2.7, T100). The
 * patient summary states a time-in-range percentage and has to name the span it came from: "the week" when
 * the data really is a week, and the days themselves when it is not. `lib/bundle.ts` floors `stats.days`
 * at 1, so a patient who uploads the day before their visit is the common case, and the sentence has to
 * agree with the `History` tile beside it rather than calling one day "the week".
 */
export function daySpan(days: number): string {
  if (days === 7) return "the week";
  // The count is dropped at one — "the day you shared", not "the 1 day you shared" — because the numeral
  // reads wrong inside a sentence and the `History` tile beside it prints the number anyway. The noun comes
  // from here on both branches, so the sentence and the tile cannot disagree about it.
  const span = days === 1 ? plural(days, "day") : countOf(days, "day");
  return `the ${span} you shared`;
}
