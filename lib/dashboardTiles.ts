// The detail line under a count on the practice overview (design §2.6, §7.3). Owner: sour.
//
// The dashboard's four tiles each print a number and a line of words under it, and three of those lines say
// nothing about how many: "in this workspace", "sharing data or chatting" and `${reviewed} reviewed` read
// correctly at every `n`, so they stay where they are read, in app/provider/dashboard.tsx.
//
// The fourth counts a noun, and that is the one with a rule. "Needs attention" printed a fixed singular over
// a plural count — on the seeded workspace the reviewer run of 2026-10-30 photographed
//
//     NEEDS ATTENTION
//     7
//     safety flag to review
//
// — seven of them, named as one (T198). It is T169's defect on the surface next door: a number and the words
// under it disagreeing inside one card.
//
// So the line is derived here rather than written in the component, for the two reasons this repo keeps
// giving: the agreement comes from `plural` in lib/plural.ts, which is the one rule for a counting noun and
// exists so that a twelfth hand-spelled ternary does not, and a derivation in a `lib/` module is a thing
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
