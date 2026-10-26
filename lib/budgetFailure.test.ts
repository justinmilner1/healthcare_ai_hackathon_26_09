import assert from "node:assert/strict";
import test from "node:test";
import {
  type Budget,
  classifyFailure,
  type FailedTest,
  reportFailures,
  summariseFailures,
} from "./budgetFailure";

/** The suite's budgets at their documented defaults (e2e/budget.ts, playwright.config.ts). */
const BUDGETS: Budget[] = [
  { name: "LOADED (E2E_LOADED_TIMEOUT_MS)", ms: 30_000 },
  { name: "DRAINED (twice LOADED, 60s floor)", ms: 60_000 },
  { name: "GIVES_UP (a quarter of LOADED, 8s floor)", ms: 8_000 },
  { name: "the per-test ceiling (E2E_TEST_TIMEOUT_MS)", ms: 180_000 },
];

/** The failure that cost the reviewer run of 2026-10-26 a serial re-run and a second full check, verbatim
 *  from #232 — `expectTranscriptUncut`'s poll giving up on a tree that passed untouched a run later. */
const THE_TICKETS_FAILURE = `Error: the transcript the reload restored: the transcript never settled on the newest message

Expected: "settled"
Received: "\\"Since you last saw the doctor, what's ch…\\" is still moving, 24px from where it is going"

Call Log:
- Timeout 30000ms exceeded while waiting on the predicate

    at expectTranscriptUncut (e2e/mobile.ts:550:6)`;

test("a poll that spent its whole LOADED budget is a clock, and names the budget it ran", () => {
  const verdict = classifyFailure(THE_TICKETS_FAILURE, BUDGETS);
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget?.name, "LOADED (E2E_LOADED_TIMEOUT_MS)");
  assert.equal(verdict.budget?.ms, 30_000);
  // The sentence the verdict was read off, so a reader can check it rather than take it on trust.
  assert.equal(verdict.evidence, "Timeout 30000ms exceeded while waiting on the predicate");
});

test("the product answering wrongly, with no clock in it, is an assertion", () => {
  const verdict = classifyFailure(
    `Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1

    at e2e/flows.spec.ts:329:31`,
    BUDGETS,
  );
  assert.equal(verdict.kind, "assertion");
  assert.equal(verdict.budget, null);
  assert.equal(verdict.evidence, null);
});

test("each of the four sentences Playwright writes a clock in is read as one", () => {
  // A web-first assertion, which reports its clock in the first line rather than in a call log.
  const webFirst = classifyFailure(
    'Error: Timed out 60000ms waiting for expect(locator).toHaveAttribute(expected)\n\nLocator: locator("[data-phase]")',
    BUDGETS,
  );
  assert.equal(webFirst.kind, "clock");
  assert.equal(webFirst.budget?.ms, 60_000);
  // The per-test ceiling, which is a sentence of its own.
  const perTest = classifyFailure("Test timeout of 180000ms exceeded.", BUDGETS);
  assert.equal(perTest.kind, "clock");
  assert.equal(perTest.budget?.name, "the per-test ceiling (E2E_TEST_TIMEOUT_MS)");
  // A web server that never answered, which names the config instead of a test.
  const server = classifyFailure(
    "Error: Timed out waiting 1800000ms from config.webServer.",
    BUDGETS,
  );
  assert.equal(server.kind, "clock");
  assert.equal(server.budget, null); // 1.8e6 is not in the list above, so there is nothing to name
  assert.equal(server.evidence, "Timed out waiting 1800000ms from config.webServer.");
});

test("a clock the suite does not own is still a clock, with no budget to name (T124)", () => {
  // Playwright's own 5s `expect` default: a number nobody wrote down and E2E_LOADED_TIMEOUT_MS cannot
  // reach, which is the gap `npm run lint`'s budgetless-poll rule exists for. Reading it as an assertion
  // would hand that gap back, so it reads as a clock with nothing to raise.
  const verdict = classifyFailure("Error: Timed out 5000ms waiting for expect(locator).toBeVisible()", BUDGETS);
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget, null);
});

test("a raised budget is what the verdict is read against, not the default", () => {
  // docs/ROUTINES.md tells a routine on a slow box to raise E2E_LOADED_TIMEOUT_MS. A report read against
  // the defaults would then stop naming the budget that actually blew.
  const raised: Budget[] = [{ name: "LOADED (E2E_LOADED_TIMEOUT_MS)", ms: 90_000 }];
  assert.equal(classifyFailure("- Timeout 90000ms exceeded while waiting on the predicate", raised).budget?.ms, 90_000);
  assert.equal(classifyFailure(THE_TICKETS_FAILURE, raised).budget, null);
});

const failure = (over: Partial<FailedTest> = {}): FailedTest => ({
  project: "mobile",
  title: "a reply the browser never receives is still in the transcript after a reload (§6.2)",
  location: "e2e/durability.spec.ts:114",
  error: THE_TICKETS_FAILURE,
  budgets: BUDGETS,
  ...over,
});

test("a run of nothing but clocks is the one a serial re-run can excuse", () => {
  const report = reportFailures([failure(), failure({ project: "desktop" })]);
  assert.equal(report.allClocks, true);
  assert.equal(report.failures.length, 2);
  assert.deepEqual(
    report.failures.map((f) => f.verdict.kind),
    ["clock", "clock"],
  );
});

test("one failure that is not a clock keeps the whole run unexcusable", () => {
  // The guard the check script's exit status rests on: a product assertion that answers differently under
  // parallelism is nondeterminism in the product, and a second run passing does not unsay it.
  const report = reportFailures([failure(), failure({ error: "Error: expect(received).toBe(expected)" })]);
  assert.equal(report.allClocks, false);
});

test("a run with no failures at all is not excusable either", () => {
  // `allClocks` answers "may a serial re-run excuse this run?", and there is nothing to excuse. It matters
  // because an interrupted run reaches the reporter with no classified failures and a non-zero exit: the
  // safe answer there is no.
  const report = reportFailures([]);
  assert.equal(report.allClocks, false);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(summariseFailures(report), []);
});

test("the block names the test, the budget and the sentence it was read off", () => {
  const printed = summariseFailures(reportFailures([failure()])).join("\n");
  assert.match(printed, /every one of the 1 failed test\(s\) is a clock that ran out, not a product assertion/);
  assert.match(printed, /\[mobile\] e2e\/durability\.spec\.ts:114 — a reply the browser never receives/);
  assert.match(printed, /ran out its whole 30000ms LOADED \(E2E_LOADED_TIMEOUT_MS\) budget/);
  assert.match(printed, /Timeout 30000ms exceeded while waiting on the predicate/);
  // And where to read about what to do with it, because that is the half the ticket is about.
  assert.match(printed, /docs\/ROUTINES\.md, "When the box is the problem"/);
});

test("the block counts the two kinds apart when the run is mixed, and says the tree is implicated", () => {
  const printed = summariseFailures(
    reportFailures([failure(), failure({ error: "Error: expect(received).toBe(expected)" })]),
  ).join("\n");
  assert.match(printed, /2 failed test\(s\): 1 clock\(s\) that ran out, 1 product assertion\(s\)/);
  assert.match(printed, /the product answered wrongly, with no clock involved/);
  assert.match(printed, /this run is evidence about the tree/);
  // No invitation to read it as the box, because it is not one.
  assert.doesNotMatch(printed, /When the box is the problem/);
});

test("a clock with no budget to name says so, rather than naming nothing", () => {
  const printed = summariseFailures(
    reportFailures([failure({ error: "Error: Timed out 5000ms waiting for expect(locator).toBeVisible()" })]),
  ).join("\n");
  assert.match(printed, /a clock the suite does not own and cannot raise \(T124\)/);
});
