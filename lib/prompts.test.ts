import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone, sample } from "./fixtures";
import { parseClarityCsv } from "./glucose";
import { patientSummarySystem, sourChatSystem, sourSystem } from "./prompts";
import { spanNoun } from "./plural";

pinUtcTimeZone(); // the Clarity fixtures carry device-local timestamps with no offset

/** `computeStats`'s span, which is what the page prints and what lib/sourRun.ts hands the prompt. */
async function daysOf(csv: string): Promise<number> {
  // lib/bundle.ts reaches Prisma, so it is imported here rather than at the top (lib/fixtures.ts says why).
  const { computeStats } = await import("./bundle");
  return computeStats(parseClarityCsv(csv), []).days;
}

// T114 (design §2.7, §7): the one thing under test in this file. The patient narrator's output is rendered
// verbatim on a page that cannot correct it, so the span it is asked about has to be the span it was given.
test("the patient narrator is asked about the span it was given, from the fixtures", async () => {
  // clarity_window.csv is 84 readings inside one day — the common case, because lib/bundle.ts floors the
  // span at 1 and a patient who uploads the day before their visit lands on it every time.
  const oneDay = await daysOf(fixture("clarity_window.csv"));
  assert.equal(oneDay, 1, "the window fixture is one day of readings");
  const single = patientSummarySystem(oneDay);
  assert.match(single, /what their day showed/);
  assert.match(single, /The data covers the day and nothing more/);
  // The regression itself: on one day of data the prompt must not say "week" anywhere, in either the rule
  // about the span or the key comment that asks for the narrative.
  assert.doesNotMatch(single, /week/i);

  // dexcom_clarity_sample.csv is the seven-day export `npm run seed` loads, and the wording the prompt was
  // written with is what that span still produces.
  const week = await daysOf(sample("dexcom_clarity_sample.csv"));
  assert.equal(week, 7, "the demo sample is a week of readings");
  assert.match(patientSummarySystem(week), /what their week showed/);
});

test("a span of several days is counted, and agrees with lib/plural.ts", () => {
  const three = patientSummarySystem(3);
  assert.match(three, /what their 3 days showed/);
  assert.match(three, /The data covers the 3 days and nothing more/);
  assert.doesNotMatch(three, /week/i);
  // One source for the noun, so the prompt cannot drift from the heading the patient reads.
  for (const days of [0, 1, 2, 3, 7, 14]) {
    assert.ok(
      patientSummarySystem(days).includes(`what their ${spanNoun(days)} showed`),
      `the prompt for ${days} days asks for "${spanNoun(days)}"`,
    );
  }
});

// The span is the only number besides the percentage the patient's narrative may carry, and the rule that
// says so has to allow it — a prompt that names "3 days" and then forbids every number but the percentage
// contradicts itself in exactly the branch T114 added.
test("the number rule allows the span it now states", () => {
  assert.match(patientSummarySystem(3), /only numbers you may use are the time-in-range percentage and the span above/);
});

// The two provider prompts take no argument and are not under test as prose (see the file header); this is
// only that they are still constant, so a future span lands in the patient's prompt and nowhere else.
test("the provider prompts are constants", () => {
  assert.equal(sourSystem(), sourSystem());
  assert.equal(sourChatSystem(), sourChatSystem());
  assert.doesNotMatch(sourSystem(), /\$\{/);
});
