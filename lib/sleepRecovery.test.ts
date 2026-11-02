import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import { parseWhoopCsv } from "./sleep";
import { anyRecoveryKnown, patientSleepCardSubtitle, recoveryScores, sleepRecoveryColumn } from "./sleepRecovery";
import type { SleepNight } from "./types";

pinUtcTimeZone(); // the WHOOP fixtures carry device-local timestamps with no offset

/** A glucose span wide enough that neither fixture's nights outrun it, so the sentences below are the
 *  recovery branches alone and nothing about T218's span clause is mixed into them. Both fixtures are
 *  shorter than this: `whoop_alt_headers.csv` is two nights and `whoop_cycles.csv` three. */
const WEEK = 7;

/** The export this ticket is about: a header of `Date,Sleep duration (min),Sleep performance %` and no
 *  recovery column anywhere in it, so every night of the upload comes back without a score (lib/sleep.ts). */
const noRecovery: SleepNight[] = parseWhoopCsv(fixture("whoop_alt_headers.csv"));
/** And the other fixture, whose header does name one. */
const withRecovery: SleepNight[] = parseWhoopCsv(fixture("whoop_cycles.csv"));

test("the fixtures really are the two shapes this module branches on", () => {
  // Asserted rather than assumed: if either export drifts, this says so here instead of leaving the tests
  // below passing for the wrong reason.
  assert.equal(noRecovery.length, 2);
  assert.ok(noRecovery.every((n) => n.recovery === undefined), "whoop_alt_headers.csv carries no recovery score");
  assert.equal(withRecovery.length, 3);
  assert.ok(withRecovery.every((n) => typeof n.recovery === "number"), "whoop_cycles.csv scores every night");
});

test("recoveryScores keeps the numbers and nothing else", () => {
  assert.deepEqual(recoveryScores(noRecovery), []);
  assert.deepEqual(recoveryScores(withRecovery), [68, 41, 74]);
  assert.deepEqual(recoveryScores([]), []);
  // A zero is a score, not an absence: `filter(Boolean)` would have dropped it.
  assert.deepEqual(recoveryScores([{ date: "2026-09-19", hours: 7, recovery: 0 }]), [0]);
});

test("anyRecoveryKnown is some, not every", () => {
  assert.equal(anyRecoveryKnown(noRecovery), false);
  assert.equal(anyRecoveryKnown(withRecovery), true);
  assert.equal(anyRecoveryKnown([]), false);
  // The mixed week: one scored night is enough for the card to be about recovery.
  assert.equal(
    anyRecoveryKnown([...noRecovery, { date: "2026-09-22", hours: 7.1, recovery: 55 }]),
    true,
  );
});

test("§2.7's sleep card does not promise recovery over a week that carries none", () => {
  assert.equal(patientSleepCardSubtitle(noRecovery, WEEK), "Nightly sleep from your connected data.");
  assert.doesNotMatch(patientSleepCardSubtitle(noRecovery, WEEK), /recovery/i);
});

test("and says what it has always said over a week that does (AC4)", () => {
  assert.equal(patientSleepCardSubtitle(withRecovery, WEEK), "Nightly sleep and recovery from your connected data.");
  // The mixed week keeps it too: there is a score on the card to read.
  assert.match(patientSleepCardSubtitle([...noRecovery, { date: "2026-09-22", hours: 7.1, recovery: 55 }], WEEK), /recovery/i);
});

test("the table's Recovery column is drawn exactly where a night has a score", () => {
  assert.equal(sleepRecoveryColumn(noRecovery), false);
  assert.equal(sleepRecoveryColumn(withRecovery), true);
  // One predicate behind the column and the sentence, so the card cannot say the word over a table with no
  // column for it — T82's bug read twice in one frame.
  for (const nights of [noRecovery, withRecovery, [], [...noRecovery, { date: "2026-09-22", hours: 7.1, recovery: 55 }]]) {
    assert.equal(sleepRecoveryColumn(nights), /recovery/i.test(patientSleepCardSubtitle(nights, WEEK)));
  }
});

test("and the predicate the clinician's Sleep tile reads is this one", () => {
  // `recoveryAvg === null` is the question app/provider/[id]/sour.tsx and the printed sheet hang their
  // recovery hint off, and `lib/bundle.ts` takes that average off `recoveryScores` above — so the two
  // surfaces are one reading of one array and cannot conclude differently about one week (T205 AC2). The
  // equivalence itself is pinned beside `computeStats` in lib/bundle.test.ts, which already has the fixture
  // schema this module does not need; what is held here is the arithmetic that makes it true.
  for (const nights of [noRecovery, withRecovery, [], [...noRecovery, { date: "2026-09-22", hours: 7.1, recovery: 55 }]]) {
    assert.equal(recoveryScores(nights).length > 0, anyRecoveryKnown(nights));
  }
});

test("the span clause rides on whichever recovery branch the sentence took (T218)", () => {
  // Both halves of the sentence are decided independently, so the four combinations are four sentences and
  // not two. The span clause is lib/sleepSpan.ts's and is held to its own wording there; what is pinned here
  // is that it is appended to either branch rather than replacing one of them.
  for (const nights of [noRecovery, withRecovery]) {
    const framed = patientSleepCardSubtitle(nights, 1);
    assert.ok(framed.startsWith(patientSleepCardSubtitle(nights, WEEK)), "the recovery branch is kept whole");
    assert.match(framed, /cover more than the day of glucose above\.$/);
  }
  // And the recovery word is still the recovery predicate's alone: the clause adds none of its own.
  assert.doesNotMatch(patientSleepCardSubtitle(noRecovery, 1), /recovery/i);
  assert.match(patientSleepCardSubtitle(withRecovery, 1), /recovery/i);
});
