import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CLOSING_KEYWORD_PATTERN, parseClosingIssues } from "./closingIssues";

const workflow = readFileSync(".github/workflows/auto-merge.yml", "utf8");

test("every GitHub closing keyword is recognised, in any case", () => {
  for (const kw of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
    assert.deepEqual(parseClosingIssues(`${kw} #7`), [7], kw);
    assert.deepEqual(parseClosingIssues(`${kw.toUpperCase()} #7`), [7], kw.toUpperCase());
  }
  // The colon form GitHub also accepts, and the shape the pull request template actually produces.
  assert.deepEqual(parseClosingIssues("Closes: #7"), [7]);
  assert.deepEqual(parseClosingIssues("## Ticket\n\nCloses #83. Fulfills design §12.4.\n"), [83]);
});

test("a body naming no issue, or none at all, yields nothing rather than throwing", () => {
  assert.deepEqual(parseClosingIssues(""), []);
  assert.deepEqual(parseClosingIssues(null), []);
  assert.deepEqual(parseClosingIssues(undefined), []);
  // The unfilled template placeholder is not an issue number, which is why it must not match.
  assert.deepEqual(parseClosingIssues("Closes #<issue>."), []);
  assert.deepEqual(parseClosingIssues("See #12 for context"), []);
  assert.deepEqual(parseClosingIssues("Refs #12, part of #13"), []);
  assert.deepEqual(parseClosingIssues("Closes #0"), []); // there is no issue 0
});

test("several issues come back in order, once each", () => {
  assert.deepEqual(parseClosingIssues("Closes #66.\nAlso fixes #10 and closes #66 again."), [66, 10]);
});

test("another repository's issue is not ours to close", () => {
  assert.deepEqual(parseClosingIssues("Closes justinmilner1/other#12"), []);
  assert.deepEqual(parseClosingIssues("Fixes some-org/repo#12 and closes #13"), [13]);
});

// The workflow runs actions/github-script with no checkout, so it carries its own copy of the regex above.
// These two assertions are what stops the copies drifting: the keyword list is reasoned about in one place.
test("the auto-merge workflow carries this exact pattern", () => {
  const inWorkflow = /matchAll\((\/.+\/gi)\)/.exec(workflow);
  assert.ok(inWorkflow, "auto-merge.yml no longer has a matchAll(/.../gi) over the pull request body");
  assert.equal(inWorkflow[1], `/${CLOSING_KEYWORD_PATTERN}/gi`);
});

test("the auto-merge workflow closes what it finds and says so", () => {
  for (const needed of [
    'state_reason: "completed"',       // closed as done, not as not-planned
    '["review", "in-progress"]',       // the two labels a merged ticket must not keep
    "removeLabel",
    "core.info(`#${number}: closed #${issue_number}`)",
  ]) {
    assert.ok(workflow.includes(needed), `auto-merge.yml is missing ${needed}`);
  }
});
