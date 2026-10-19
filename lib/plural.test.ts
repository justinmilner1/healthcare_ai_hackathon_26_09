import assert from "node:assert/strict";
import test from "node:test";
import { countOf, plural } from "./plural";

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
