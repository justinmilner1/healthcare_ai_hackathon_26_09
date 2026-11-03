import assert from "node:assert/strict";
import test from "node:test";
import { needsAttentionDetail, summariesReadyDetail } from "./dashboardTiles";

// T198 (design §2.6, §7.3, §12.1): the "Needs attention" tile's detail, held to both of its branches at the
// three counts that decide them. The bug was a fixed singular over a plural count, so `n = 2` is the
// assertion the ticket was filed for and `n = 1` is the one that stops a fix from over-correcting into
// "1 safety flags".

test("the noun agrees with the count the tile prints above it", () => {
  assert.equal(needsAttentionDetail(1), "safety flag to review");
  assert.equal(needsAttentionDetail(2), "safety flags to review");
});

test("zero keeps its own line and never counts a noun", () => {
  assert.equal(needsAttentionDetail(0), "nothing flagged");
});

// The workspace in the screenshot the ticket was filed from, and a bigger one: nothing about the plural
// branch is specific to two.
test("every flag count above one reads plural", () => {
  for (const n of [2, 3, 7, 11, 100]) {
    assert.equal(needsAttentionDetail(n), "safety flags to review", `${n} flagged`);
  }
});

// T225 (design §2.6, §7.3, §12.1): the "Summaries ready" tile's detail, held to all three of its branches.
// The bug was the zero state — `ready === 0` fell through an inline ternary to "ready to review", so a
// practice with no finished `sour.run` read a claim that something was waiting for it, under a printed `0`
// and inside the only accented card on the screen. So zero is the assertion this ticket was filed for, and
// the two counted branches are what stop a fix from losing the readings that were already right.

test("zero claims nothing is ready, and counts no noun", () => {
  assert.equal(summariesReadyDetail(0, 0), "nothing summarized yet");
});

test("the summary noun agrees with the count the tile prints above it", () => {
  assert.equal(summariesReadyDetail(1, 0), "summary to review");
  assert.equal(summariesReadyDetail(2, 0), "summaries to review");
});

// The irregular plural is the reason this goes through `plural` with both forms rather than a bare `+ "s"`.
test("every summary count above one reads plural, and never 'summarys'", () => {
  for (const n of [2, 3, 7, 11, 100]) {
    assert.equal(summariesReadyDetail(n, 0), "summaries to review", `${n} ready`);
  }
});

// §7.3's reading, which the tile already had and this keeps: a participle naming its own number, so it needs
// no noun inflected and reads the same at one as at ten.
test("a sign-off is reported instead of counting the ready ones as outstanding", () => {
  assert.equal(summariesReadyDetail(1, 1), "1 reviewed");
  assert.equal(summariesReadyDetail(4, 2), "2 reviewed");
  assert.equal(summariesReadyDetail(10, 10), "10 reviewed");
});

// Zero is tested before `reviewed`, so a count that cannot happen in the data cannot print words that
// disagree with the `0` drawn above them either (T169, T198).
test("nothing is ready beats a reviewed count that could not be there", () => {
  assert.equal(summariesReadyDetail(0, 3), "nothing summarized yet");
});

// The two tiles' zero states are each other's register, and neither of them names a count (T198, T225).
test("neither counted tile puts a number or its noun in its zero line", () => {
  for (const zero of [needsAttentionDetail(0), summariesReadyDetail(0, 0)]) {
    assert.match(zero, /^nothing /, zero);
    assert.doesNotMatch(zero, /\d/, zero);
  }
});
