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
 * The noun for a span of days, bare: `"week"` at seven, `"day"` at one, `"3 days"` otherwise (design §2.7,
 * T100, T114). Seven is the only span with a word of its own, because a week is what the product asks the
 * patient for; every other span is counted. The count is dropped at one — "day", not "1 day" — because the
 * numeral reads wrong inside a sentence and the `History` tile beside it prints the number anyway.
 *
 * It is bare so that each site supplies its own article and the branch is decided once. The patient path
 * says the span in four different grammars — "What your week showed", "a short summary of your day",
 * "for 76% of the day you shared", and the line the patient narrator's prompt is handed — and every one of
 * them is a claim about the data, so none of them may spell the span as a literal. `lib/bundle.ts` floors
 * `stats.days` at 1, so a patient who uploads the day before their visit is the common case and not an
 * edge one.
 */
export function spanNoun(days: number): string {
  if (days === 7) return "week";
  return days === 1 ? plural(days, "day") : countOf(days, "day");
}

/**
 * The span a share of readings was computed over, in the patient's own voice (design §2.7, T100). The
 * patient summary states a time-in-range percentage and has to name the span it came from: "the week" when
 * the data really is a week, and the days themselves when it is not, so the sentence agrees with the
 * `History` tile beside it rather than calling one day "the week". The noun is `spanNoun`'s on both
 * branches, so this and the headings around it cannot disagree about it.
 */
export function daySpan(days: number): string {
  if (days === 7) return "the week";
  return `the ${spanNoun(days)} you shared`;
}

/**
 * The accessible name of §2.7's row of three stat tiles — History, Average, Sleep (T207).
 *
 * The fifth grammar the patient path says the span in, and the last one that still spelled it as a
 * literal: the row was named `aria-label="Week at a glance"` in app/patient/[id]/page.tsx, so a patient
 * who uploaded the day before their visit got a group announced as a week over a `History / 1 / day` tile.
 * That is the pair T100 was filed for, surviving in the one place neither T100 nor T114 could reach —
 * `e2e/flows.spec.ts`'s negative assertion reads text nodes, and an attribute is not one.
 *
 * `spanNoun`'s noun on every branch, so this and the four sentences above it cannot disagree about what
 * arrived. "Your" rather than "The", because §2.7 is the patient's own summary and the hero one card up
 * composes the same noun the same way ("Your 3 days with Sweetie"); the possessive is what makes the
 * counted branch read as English rather than as a column header.
 */
export function spanAtAGlance(days: number): string {
  return `Your ${spanNoun(days)} at a glance`;
}
