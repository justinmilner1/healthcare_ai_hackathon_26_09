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
