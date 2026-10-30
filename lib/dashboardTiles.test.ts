import assert from "node:assert/strict";
import test from "node:test";
import { needsAttentionDetail } from "./dashboardTiles";

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
test("every count above one reads plural", () => {
  for (const n of [2, 3, 7, 11, 100]) {
    assert.equal(needsAttentionDetail(n), "safety flags to review", `${n} flagged`);
  }
});
