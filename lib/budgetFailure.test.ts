import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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

// The three fixtures below are verbatim `result.errors[].message` out of the installed Playwright, caught
// by failing a matcher on purpose at a budget this suite owns and dumping the JSON reporter's output.
// Colour codes and all, because colour is what `e2e/budgetReporter.ts` is handed on a real run and the
// anchors in `CLOCKS` have to survive it. Everything from the code frame down is `error.snippet`, which
// the reporter joins on separately, so it is left off here.

/** A web-first assertion that spent its whole `LOADED` budget — the commonest clock in this suite, and the
 *  one that went unread until T172. The `Timeout:` line is `formatMatcherMessage` in
 *  node_modules/playwright/lib/matchers/expect.js, written only under `details.timedOut`. */
const A_TIMED_OUT_MATCHER = `Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoContainText\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed

Locator: locator('.sweetie-messages')
Expected substring: \u001b[32m"anything"\u001b[39m
Received string:    \u001b[31m""\u001b[39m
Timeout: 30000ms

Call log:
\u001b[2m  - Expect "toContainText" locator('.sweetie-messages') with timeout 30000ms\u001b[22m
\u001b[2m  - waiting for locator('.sweetie-messages')\u001b[22m
\u001b[2m    63 × locator resolved to <div class="sweetie-messages"></div>\u001b[22m
\u001b[2m       - unexpected value ""\u001b[22m
`;

/** The same sentence with the second space in it. `formatMatcherMessage` aligns the block on its colons
 *  whenever it prints both an `Expected:` and a `Received:` line, and `Timeout:` is aligned with them. */
const A_TIMED_OUT_MATCHER_ALIGNED = `Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveText\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed

Locator:  locator('#a')
Expected: \u001b[32m"a"\u001b[39m
Received: \u001b[31m"b"\u001b[39m
Timeout:  8000ms

Call log:
\u001b[2m  - Expect "toHaveText" locator('#a') with timeout 8000ms\u001b[22m
\u001b[2m  - waiting for locator('#a')\u001b[22m
\u001b[2m    20 × locator resolved to <div id="a">b</div>\u001b[22m
\u001b[2m       - unexpected value "b"\u001b[22m
`;

/** The product answering wrongly: a matcher that compared two values and found them different, with no
 *  clock anywhere in it. Same colouring, so the two cannot be told apart by anything but the sentence. */
const A_PLAIN_MATCHER_FAILURE = `Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBe\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) // Object.is equality\u001b[22m

Expected: \u001b[32m0\u001b[39m
Received: \u001b[31m1\u001b[39m
`;

test("a poll that spent its whole LOADED budget is a clock, and names the budget it ran", () => {
  const verdict = classifyFailure(THE_TICKETS_FAILURE, BUDGETS);
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget?.name, "LOADED (E2E_LOADED_TIMEOUT_MS)");
  assert.equal(verdict.budget?.ms, 30_000);
  // The sentence the verdict was read off, so a reader can check it rather than take it on trust.
  assert.equal(verdict.evidence, "Timeout 30000ms exceeded while waiting on the predicate");
});

test("a web-first assertion that spent its whole budget is a clock too (T172)", () => {
  // The regression this ticket is about: Playwright 1.64 writes `Timeout: <n>ms` where it used to write
  // `Timed out <n>ms waiting for …`, so the commonest clock in the suite read as the product answering
  // wrongly — the one verdict docs/ROUTINES.md says a routine may never excuse.
  const verdict = classifyFailure(A_TIMED_OUT_MATCHER, BUDGETS);
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget?.name, "LOADED (E2E_LOADED_TIMEOUT_MS)");
  assert.equal(verdict.budget?.ms, 30_000);
  assert.equal(verdict.evidence, "Timeout: 30000ms");
});

test("the aligned `Timeout:` line, with its second space, reads the same (T172)", () => {
  const verdict = classifyFailure(A_TIMED_OUT_MATCHER_ALIGNED, BUDGETS);
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget?.name, "GIVES_UP (a quarter of LOADED, 8s floor)");
  assert.equal(verdict.evidence, "Timeout:  8000ms");
});

test("the product answering wrongly, with no clock in it, is an assertion", () => {
  const verdict = classifyFailure(A_PLAIN_MATCHER_FAILURE, BUDGETS);
  assert.equal(verdict.kind, "assertion");
  assert.equal(verdict.budget, null);
  assert.equal(verdict.evidence, null);
  // And the same with none of Playwright's framing at all, which is what a bare `assert` in a spec writes.
  const bare = classifyFailure(
    `Error: expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1

    at e2e/flows.spec.ts:329:31`,
    BUDGETS,
  );
  assert.equal(bare.kind, "assertion");
  assert.equal(bare.evidence, null);
});

test("a `Timeout:` in the middle of a line is not a clock", () => {
  // The fix cannot widen into excusing a product failure, so the line counts only where Playwright writes
  // it: on a line of its own. A value the product returned that happens to contain the word is still the
  // product answering.
  const verdict = classifyFailure(
    `Error: expect(locator).toHaveText(expected) failed

Locator: locator('.brief')
Expected: "no follow-up scheduled"
Received: "Timeout: 30000ms — reschedule"`,
    BUDGETS,
  );
  assert.equal(verdict.kind, "assertion");
  assert.equal(verdict.budget, null);
  assert.equal(verdict.evidence, null);
});

test("each of the sentences Playwright writes a clock in is read as one", () => {
  // The per-test ceiling, which is a sentence of its own and arrives colour-wrapped and nothing else.
  const perTest = classifyFailure("\u001b[31mTest timeout of 180000ms exceeded.\u001b[39m", BUDGETS);
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

/**
 * Where in the installed Playwright each sentence `CLOCKS` matches is written, and a sample of what that
 * template renders.
 *
 * The regexes used to be held to prose remembered from a log, and one of them —
 * `Timed out <n>ms waiting for …` — went on being asserted after Playwright had stopped writing it, while
 * the sentence that replaced it went unmatched and every web-first-assertion clock was read as the product
 * answering wrongly (T172). So each pattern is pinned to its source here: a bump that rewords one fails
 * this test, loudly, instead of degrading the gate quietly.
 */
const SOURCES: readonly { what: string; file: string; template: string; rendered: string }[] = [
  {
    what: "a web-first assertion that spent its budget",
    file: "node_modules/playwright/lib/matchers/expect.js",
    template: 'message += `Timeout: ${align ? " " : ""}${details.timeout}ms',
    rendered: "Locator: locator('.x')\nTimeout: 30000ms\nError: element(s) not found",
  },
  {
    what: "the same with the block aligned on its colons, which is where the second space comes from",
    file: "node_modules/playwright/lib/matchers/expect.js",
    template: 'message += `Timeout: ${align ? " " : ""}${details.timeout}ms',
    rendered: 'Locator:  locator(\'.x\')\nExpected: "a"\nReceived: "b"\nTimeout:  30000ms',
  },
  {
    what: "expect.poll and toPass, which report theirs inside a call log",
    file: "node_modules/playwright/lib/matchers/expect.js",
    template: "const matcherMessage = `Timeout ${timeout}ms exceeded while waiting on the predicate`;",
    rendered: "Error: nope\n\nCall Log:\n- Timeout 30000ms exceeded while waiting on the predicate",
  },
  {
    what: "the per-test ceiling, which ends the test rather than one wait in it",
    file: "node_modules/playwright/lib/worker/workerProcessEntry.js",
    template: "Test timeout of ${timeout}ms exceeded.`",
    rendered: "Test timeout of 30000ms exceeded.",
  },
  {
    what: "a web server that never answered",
    file: "node_modules/playwright/lib/runner/index.js",
    template: "Timed out waiting ${launchTimeout}ms from config.webServer",
    rendered: "Error: Timed out waiting 30000ms from config.webServer.",
  },
];

test("every clock sentence this module matches is one the installed Playwright still writes", () => {
  const repoRoot = path.join(import.meta.dirname, "..");
  for (const source of SOURCES) {
    const installed = readFileSync(path.join(repoRoot, source.file), "utf8");
    assert.ok(
      installed.includes(source.template),
      `${source.file} no longer writes \`${source.template}\` (${source.what}). Playwright has reworded a ` +
        "clock: read what it writes now and update CLOCKS in lib/budgetFailure.ts and the fixtures here, " +
        "or the gate will read that clock as the product answering wrongly (T172).",
    );
    const verdict = classifyFailure(source.rendered, BUDGETS);
    assert.equal(verdict.kind, "clock", `${source.what}: not read as a clock`);
    assert.equal(verdict.budget?.ms, 30_000, `${source.what}: did not name the budget it ran`);
  }
});

test("a clock the suite does not own is still a clock, with no budget to name (T124)", () => {
  // Playwright's own 5s `expect` default: a number nobody wrote down and E2E_LOADED_TIMEOUT_MS cannot
  // reach, which is the gap `npm run lint`'s budgetless-poll rule exists for. Reading it as an assertion
  // would hand that gap back, so it reads as a clock with nothing to raise.
  const verdict = classifyFailure(
    "Error: expect(locator).toBeVisible() failed\n\nLocator: locator('#x')\nTimeout: 5000ms\n",
    BUDGETS,
  );
  assert.equal(verdict.kind, "clock");
  assert.equal(verdict.budget, null);
});

test("a raised budget is what the verdict is read against, not the default", () => {
  // docs/ROUTINES.md tells a routine on a slow box to raise E2E_LOADED_TIMEOUT_MS. A report read against
  // the defaults would then stop naming the budget that actually blew.
  const raised: Budget[] = [{ name: "LOADED (E2E_LOADED_TIMEOUT_MS)", ms: 90_000 }];
  assert.equal(classifyFailure("- Timeout 90000ms exceeded while waiting on the predicate", raised).budget?.ms, 90_000);
  assert.equal(classifyFailure(THE_TICKETS_FAILURE, raised).budget, null);
  assert.equal(classifyFailure(A_TIMED_OUT_MATCHER, raised).budget, null);
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

test("a run of nothing but timed-out web-first assertions is one of those runs (T172)", () => {
  // The half of the ticket that reaches scripts/agent-check.sh: with the sentence unmatched, `allClocks`
  // was false for this run and the excuse rule could never fire, however many times the re-run passed.
  const report = reportFailures([
    failure({ error: A_TIMED_OUT_MATCHER }),
    failure({ project: "desktop", error: A_TIMED_OUT_MATCHER_ALIGNED }),
  ]);
  assert.equal(report.allClocks, true);
  const printed = summariseFailures(report).join("\n");
  assert.match(printed, /ran out its whole 30000ms LOADED \(E2E_LOADED_TIMEOUT_MS\) budget/);
  assert.match(printed, /ran out its whole 8000ms GIVES_UP \(a quarter of LOADED, 8s floor\) budget/);
  assert.doesNotMatch(printed, /the product answered wrongly/);
});

test("one failure that is not a clock keeps the whole run unexcusable", () => {
  // The guard the check script's exit status rests on: a product assertion that answers differently under
  // parallelism is nondeterminism in the product, and a second run passing does not unsay it.
  const report = reportFailures([failure(), failure({ error: A_PLAIN_MATCHER_FAILURE })]);
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
    reportFailures([failure(), failure({ error: A_PLAIN_MATCHER_FAILURE })]),
  ).join("\n");
  assert.match(printed, /2 failed test\(s\): 1 clock\(s\) that ran out, 1 product assertion\(s\)/);
  assert.match(printed, /the product answered wrongly, with no clock involved/);
  assert.match(printed, /this run is evidence about the tree/);
  // No invitation to read it as the box, because it is not one.
  assert.doesNotMatch(printed, /When the box is the problem/);
});

test("a clock with no budget to name says so, rather than naming nothing", () => {
  const printed = summariseFailures(
    reportFailures([
      failure({ error: "Error: expect(locator).toBeVisible() failed\n\nLocator: locator('#x')\nTimeout: 5000ms\n" }),
    ]),
  ).join("\n");
  assert.match(printed, /a clock the suite does not own and cannot raise \(T124\)/);
});
