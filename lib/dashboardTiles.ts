// The detail line under a count on the practice overview (design §2.6, §7.3). Owner: sour.
//
// The dashboard's four tiles each print a number and a line of words under it, and two of those lines say
// nothing about how many: "in this workspace" and "sharing data or chatting" read correctly at every `n`, so
// they stay where they are read, in app/provider/dashboard.tsx.
//
// The other two have a branch that counts a noun, and those are the ones with a rule. "Needs attention"
// printed a fixed singular over a plural count — on the seeded workspace the reviewer run of 2026-10-30
// photographed
//
//     NEEDS ATTENTION
//     7
//     safety flag to review
//
// — seven of them, named as one (T198). It is T169's defect on the surface next door: a number and the words
// under it disagreeing inside one card.
//
// "Summaries ready" had the same defect at the other end of the range, and this comment used to miss it: the
// enumeration above named `${reviewed} reviewed` among the lines that are safe at every `n`, which is true of
// that branch and says nothing about the branch beside it. The tile's detail was one inline ternary,
// `reviewed ? `${reviewed} reviewed` : "ready to review"`, so a practice with no finished `sour.run` — every
// brand-new one — fell to the second branch and read
//
//     SUMMARIES READY
//     0
//     ready to review
//
// over an accent the sibling's `danger` was already gated on: nothing was ready, and the one tile drawing the
// clinician's eye said something was waiting for them (T225). §2.6 sends that clinician to the brief; at zero
// there is no brief to send them to. That tile is derived here too now, and the enumeration above names only
// the two lines that really are safe.
//
// A counted line lives here rather than in the component for the two reasons this repo keeps giving: the
// agreement comes from `plural` in lib/plural.ts, which is the one rule for a counting noun and exists so
// that a twelfth hand-spelled ternary does not, and a derivation in a `lib/` module is a thing
// lib/dashboardTiles.test.ts can hold to every branch — the component is a client component the unit suite
// cannot render. lib/spikePlaces.ts owns the brief's captions on the same terms.

import { plural } from "./plural";

/**
 * What to say under the "Needs attention" count.
 *
 * `flagged` is how many of the practice's visits raised §2.5's red flag during check-in — `Visit.intake.flagged`
 * is one flag id per intake at most (lib/types.ts), so the number is both "visits" and "flags" and the noun
 * names the flag, which is the thing §2.6 sends the clinician to read.
 *
 * Zero is not a count of anything, so it does not get the noun: nothing has been flagged, and the tile drops
 * its danger colour at the same time (app/provider/dashboard.tsx).
 */
export function needsAttentionDetail(flagged: number): string {
  if (flagged === 0) return "nothing flagged";
  return `${plural(flagged, "safety flag")} to review`;
}

/**
 * What to say under the "Summaries ready" count (T225).
 *
 * `ready` is how many of the practice's visits have a saved Sour pair (`hasSummary`) and `reviewed` how many
 * of those a clinician has signed off under §7.3. A summary somebody has marked reviewed is not still waiting
 * to be read, so the line reports the sign-off once there is one rather than counting every ready summary as
 * outstanding — that reading is this tile's older half and the only one that was ever right.
 *
 * Three branches, in the order the number above them decides:
 *
 * - **Zero.** Nothing has been summarized, so there is nothing to claim and no noun to count — the register
 *   of the sibling's "nothing flagged". "yet" is the one word this zero state has that the sibling's does
 *   not: a flag is not expected to arrive, and a summary is (the hero one card up promises Sour "will light
 *   up when a summary is ready"). The tile drops its accent on this branch, as "Needs attention" drops its
 *   danger colour (app/provider/dashboard.tsx), so an empty dashboard highlights nothing.
 * - **Ready, none reviewed.** The summaries are the clinician's to read, in a noun that agrees with the
 *   count drawn above it: "summary to review" at one, "summaries to review" above. `plural` carries the
 *   irregular plural, because "summarys" is the kind of thing a hand-spelled ternary prints.
 * - **Some reviewed.** `${reviewed} reviewed` names its own number and agrees at every `n` without a noun to
 *   inflect — "reviewed" is a participle, not something countable — so this branch keeps the wording the
 *   tile has always had.
 *
 * Zero is tested first and wins outright. `reviewed` cannot exceed `ready` in the data (a review hangs off a
 * summary), but the branch order is what makes that a property of this function rather than a thing to trust:
 * a line reading "2 reviewed" under a printed `0` would be exactly the disagreement T169 and T198 are about.
 */
export function summariesReadyDetail(ready: number, reviewed: number): string {
  if (ready === 0) return "nothing summarized yet";
  if (reviewed > 0) return `${reviewed} reviewed`;
  return `${plural(ready, "summary", "summaries")} to review`;
}
