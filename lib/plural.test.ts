import assert from "node:assert/strict";
import test from "node:test";
import { countOf, daySpan, plural, spanNoun } from "./plural";

test("one is singular, zero and many are plural", () => {
  assert.equal(countOf(0, "spike"), "0 spikes");
  assert.equal(countOf(1, "spike"), "1 spike");
  assert.equal(countOf(2, "spike"), "2 spikes");
  assert.equal(countOf(1, "day"), "1 day");
  assert.equal(countOf(7, "day"), "7 days");
  // T80: the two counts the patient summary prints, which is the other side of T60's handover.
  assert.equal(countOf(1, "reading"), "1 reading");
  assert.equal(countOf(1, "day"), "1 day");
});

test("the count is grouped, because a week of readings passes a thousand", () => {
  assert.equal(countOf(84, "reading"), "84 readings");
  assert.equal(countOf(2016, "reading"), "2,016 readings");
});

test("an irregular plural can be given", () => {
  assert.equal(countOf(1, "entry", "entries"), "1 entry");
  assert.equal(countOf(3, "entry", "entries"), "3 entries");
});

test("plural returns the noun alone, and treats -1 as singular", () => {
  assert.equal(plural(0, "day"), "days");
  assert.equal(plural(1, "day"), "day");
  assert.equal(plural(5, "day"), "days");
  assert.equal(plural(-1, "day"), "day");
});

// T100 (design §2.7): the patient summary's time-in-range sentence names the span it was computed over.
test("daySpan names the week only when the data is a week", () => {
  assert.equal(daySpan(7), "the week");
  // The numeral is dropped at one, so the sentence reads as English; the span is still one day.
  assert.equal(daySpan(1), "the day you shared");
  assert.equal(daySpan(3), "the 3 days you shared");
  assert.equal(daySpan(14), "the 14 days you shared");
});

// T114 (design §2.7, §7): the bare noun the headings, the "being prepared" card and the patient narrator's
// prompt all compose with their own article. Seven is the only span with a word of its own.
test("spanNoun names the week only at seven, and drops the numeral at one", () => {
  assert.equal(spanNoun(7), "week");
  assert.equal(spanNoun(1), "day");
  assert.equal(spanNoun(3), "3 days");
  assert.equal(spanNoun(14), "14 days");
  // 0 readings is 0 days (lib/bundle.ts computeStats), and the noun still has to agree.
  assert.equal(spanNoun(0), "0 days");
});

test("the sites that compose spanNoun keep the wording the patient page was written with", () => {
  // The two headings T114 fixed, spelled here the way app/patient/[id]/page.tsx spells them, so a change
  // to the branch shows up as a change to the sentence rather than only to the noun.
  assert.equal(`What your ${spanNoun(7)} showed`, "What your week showed");
  assert.equal(`What your ${spanNoun(1)} showed`, "What your day showed");
  assert.equal(`a short summary of your ${spanNoun(7)}`, "a short summary of your week");
  assert.equal(`a short summary of your ${spanNoun(1)}`, "a short summary of your day");
  // And lib/sourRun.ts's label on the figure it hands the narrator.
  assert.equal(`Time in range over the ${spanNoun(1)}`, "Time in range over the day");
  assert.equal(`Time in range over the ${spanNoun(3)}`, "Time in range over the 3 days");
});

test("daySpan is spanNoun's noun, so the sentence and the headings cannot drift apart", () => {
  for (const days of [0, 1, 2, 3, 7, 14, 30]) {
    const span = daySpan(days);
    if (days === 7) assert.equal(span, "the week");
    else assert.equal(span, `the ${spanNoun(days)} you shared`);
  }
});
