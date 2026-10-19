// What the patient's own "biggest rises" table says about where they were (design §2.5, §2.7). Owner: sour.
//
// The place on a Spike comes from the Timeline export, which §2.5 makes optional and Sweetie's `nextTarget`
// stops offering once the patient declines it. So a patient who shared only Dexcom has a spike table whose
// place column cannot ever say anything, and it used to fill every row with "no matching visit" (T82):
// the matcher's vocabulary (lib/match.ts: a spike *matches* a visit), on the one page written for the
// patient, using the one word — "visit" — that already means their appointment to them (§4.4). It also read
// as a lookup that had come back empty, for data §2.4 and §2.5 told them they need not give.
//
// So the patient's table asks here instead of spelling the rule out: with no place known the column is not
// drawn at all, and the chart caption above it stops promising places too — one predicate, so the caption
// and the table cannot disagree. The clinician's brief and the printed sheet are not this: "no matching
// visit" is a true and useful thing to tell a reader who knows what the matcher is, and they keep it.
//
// Pure, and in lib/ rather than in the component, so both shapes can be held to this in a unit test (§12.1).

import type { Spike } from "./types";

/**
 * Whether any of these spikes was matched to a place (lib/match.ts).
 *
 * This is the whole decision: `false` means the Timeline export is not in this visit — or named nowhere the
 * patient went near a rise — so there is nothing a place column could report but its own absence.
 */
export function anyPlaceKnown(spikes: Spike[]): boolean {
  return spikes.some((s) => Boolean(s.visit));
}

/**
 * The patient's word for a rise with no place against it, used only where some *other* row has one.
 *
 * "not sure" is the page admitting it does not know, in the register of the rest of it ("Here's your story",
 * "What you told Sweetie"). It reports no failure and asks nothing of the patient, and it borrows no word
 * from the matcher — least of all "visit", which on this page is the appointment they are preparing for.
 */
export const UNKNOWN_PLACE = "not sure";

/**
 * The subtitle under the patient's glucose card, which names what the markers on it carry.
 *
 * GlucoseChart labels a marker with its spike's place when there is one and with the peak reading when there
 * is not, so the half-sentence about places is only true in the first case — and a caption promising "where
 * you had just been" above a table with no Where column is the same bug read twice (T82).
 */
export function patientChartCaption(spikes: Spike[]): string {
  return anyPlaceKnown(spikes)
    ? "Markers show your biggest rises and where you had just been, when available."
    : "Markers show your biggest rises.";
}
