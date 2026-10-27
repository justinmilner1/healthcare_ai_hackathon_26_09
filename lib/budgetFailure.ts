// Which kind of thing a failed Playwright test is evidence about (T161, design §12.4).
//
// The gate is `scripts/agent-check.sh` passing on the tree about to be pushed, and docs/ROUTINES.md,
// "When the box is the problem", tells a routine that reads a failure how to tell a red tree from a slow
// box: compare the stage wall times against the 2026-10-10 probe. That test works when the whole container
// is crawling. It does not work when one wait loses a scheduling race, which is the case that actually
// happens — the reviewer run of 2026-10-26 failed on `main` at `7f22d3d` and passed on the same untouched
// tree a run later, and the two timings tables were the same table: one test stalling for 30s is 4% of an
// eleven-minute e2e stage, invisible in wall time, while the failure it writes names the product ("the
// transcript never settled on the newest message") and reads exactly like a §6.2 regression.
//
// What separates the two is already at the point of failure. Every budget the suite waits on is a named
// number in e2e/budget.ts or playwright.config.ts, and a clock that ran out says which number it was. So a
// failure can be read as one of two things:
//
//   - **a clock** — a wait consumed its whole budget and gave up. Nothing about the product is settled by
//     it: a wait that runs out has not seen the product say no, it has stopped asking.
//   - **an assertion** — the product was asked and answered wrongly, with no clock involved.
//
// That distinction is deliberately coarse, and it is not by itself an excuse. A web-first assertion whose
// value is permanently wrong also spends its budget before it reports, so it lands here as a clock; what
// tells it from a race is the serial re-run `scripts/agent-check.sh` does next, which a permanently wrong
// value fails again. The classification's job is the other half: a failure with *no* clock in it that
// passes serially is nondeterminism in the product, and must never be excused as a slow box. So the check
// script excuses a run only when every failure was a clock **and** the serial re-run passed.

/** One of the suite's named millisecond budgets (e2e/budget.ts, `TEST_TIMEOUT_MS` in playwright.config.ts). */
export type Budget = {
  /** What a reader and docs/ROUTINES.md call it — the override that raises it, where there is one. */
  name: string;
  ms: number;
};

/** What a failed test is evidence about. */
export type FailureVerdict = {
  /** `clock` when a wait ran out of its budget, `assertion` when the product answered wrongly. */
  kind: "clock" | "assertion";
  /** The budget the clock cited, when it is one the suite owns and a routine can raise; `null` otherwise. */
  budget: Budget | null;
  /** The sentence the verdict was read off, so a reader can check it against the error themselves. */
  evidence: string | null;
};

/**
 * The sentences Playwright writes when a clock runs out, each capturing the budget it ran.
 *
 * All four shapes, because which one appears depends on what was waiting and none of them is the one a
 * reader expects: `expect.poll` and `toPass` report theirs inside a call log, the per-test ceiling is its
 * own sentence, a web server that never answered names the config, and a web-first assertion that spent
 * its budget writes a bare `Timeout:` line among the matcher's own lines. The numbers are what matter — a
 * sentence with a budget the suite owns in it is a wait of this suite's that was given its full allowance
 * and did not get there.
 *
 * Each one is held to the installed Playwright by `lib/budgetFailure.test.ts`, which reads the templates
 * out of `node_modules` and fails when a bump rewords one. That test exists because the fourth shape used
 * to be `Timed out <n>ms waiting for …`, the pre-1.64 web-first-assertion wording; 1.64 replaced it with
 * the `Timeout:` line below and nothing noticed, so the commonest clock of all read as the product
 * answering wrongly — the one verdict docs/ROUTINES.md says never to excuse (T172).
 *
 * The order only decides which budget gets named when one error carries two clocks: a matcher cut short by
 * the per-test ceiling reports both, and the ceiling is the one that ended the test, so it is matched
 * first. `kind` is `clock` either way.
 */
const CLOCKS: readonly RegExp[] = [
  /Timeout (\d+)ms exceeded[^\n]*/,
  /Test timeout of (\d+)ms exceeded[^\n]*/,
  /Timed out waiting (\d+)ms from config\.webServer[^\n]*/,
  // `playwright/lib/matchers/expect.js`, `formatMatcherMessage`: `Timeout: ${align ? " " : ""}${n}ms`, on a
  // line of its own and written only under `details.timedOut`, so the line's presence is itself the whole
  // statement that this failure was a clock. The alignment space is why two are allowed after the colon,
  // and the anchors are why a `Timeout:` inside a received value is not read as one.
  /^[ \t]*Timeout:[ \t]{1,2}(\d+)ms[ \t]*\r?$/m,
];

/**
 * Read one failed test's error text as a clock or an assertion.
 *
 * `budgets` is what the suite owns at the values this run is using, so an override a routine set for a slow
 * box is what the verdict is read against rather than a default written down here. A clock citing a number
 * no budget matches is still a clock — Playwright's own 5s `expect` default is the one that gets there, and
 * it is a budget nothing can raise, which is the T124 gap — so it is reported as a clock with no budget to
 * name rather than quietly as an assertion.
 */
export function classifyFailure(error: string, budgets: readonly Budget[]): FailureVerdict {
  for (const clock of CLOCKS) {
    const hit = clock.exec(error);
    if (!hit) continue;
    const ms = Number(hit[1]);
    return {
      kind: "clock",
      budget: budgets.find((budget) => budget.ms === ms) ?? null,
      evidence: hit[0].trim(),
    };
  }
  return { kind: "assertion", budget: null, evidence: null };
}

/** One failed test, as much of it as a verdict needs. */
export type FailedTest = {
  /** The project the failure is on — `desktop` or `mobile`; the same test can fail on one and pass on the other. */
  project: string;
  /** The test's title, and the spec and line it is at: what a re-run would be pointed at. */
  title: string;
  location: string;
  /** Every error Playwright recorded for it, run together. */
  error: string;
  /**
   * The budgets this test was waiting on, at the values this run used.
   *
   * Per test rather than per run, because the per-test ceiling is: `TEST_TIMEOUT_MS` in
   * playwright.config.ts is the default and three specs raise their own above it, so the only list that can
   * name the clock a given test ran out is the one assembled for that test.
   */
  budgets: readonly Budget[];
};

export type SuiteFailureReport = {
  failures: (FailedTest & { verdict: FailureVerdict })[];
  /**
   * Whether every failure in the run was a clock.
   *
   * The one question `scripts/agent-check.sh` asks of this: a serial re-run that passes excuses a run of
   * clocks and nothing else. One failure with no clock in it is the product having answered wrongly under
   * parallelism, which is a finding about the tree whatever a second run says.
   */
  allClocks: boolean;
};

/** Read a run's failures, in the order Playwright reported them. */
export function reportFailures(tests: readonly FailedTest[]): SuiteFailureReport {
  const failures = tests.map((test) => ({ ...test, verdict: classifyFailure(test.error, test.budgets) }));
  return { failures, allClocks: failures.length > 0 && failures.every((f) => f.verdict.kind === "clock") };
}

/**
 * The block the suite prints about its own failures, one line per element.
 *
 * It is here rather than in the reporter so that what a routine reads in the log is the thing the unit tests
 * hold to (§12.1): the wording is the whole deliverable of this ticket, since the failure saying what it is
 * is what stops a healthy commit being reverted.
 */
export function summariseFailures(report: SuiteFailureReport): string[] {
  if (report.failures.length === 0) return [];
  const clocks = report.failures.filter((f) => f.verdict.kind === "clock").length;
  const lines = [
    report.allClocks
      ? `== every one of the ${report.failures.length} failed test(s) is a clock that ran out, not a product assertion`
      : `== ${report.failures.length} failed test(s): ${clocks} clock(s) that ran out, ${
          report.failures.length - clocks
        } product assertion(s)`,
  ];
  for (const failure of report.failures) {
    const named =
      failure.verdict.kind === "assertion"
        ? "the product answered wrongly, with no clock involved"
        : failure.verdict.budget
          ? `ran out its whole ${failure.verdict.budget.ms}ms ${failure.verdict.budget.name} budget`
          : "ran out a clock the suite does not own and cannot raise (T124)";
    lines.push(`   [${failure.project}] ${failure.location} — ${failure.title}`);
    lines.push(`      ${named}`);
    if (failure.verdict.evidence) lines.push(`      ${failure.verdict.evidence}`);
  }
  if (report.allClocks) {
    lines.push("   A wait that ran out has not seen the product say no; it stopped asking, so nothing here");
    lines.push("   is yet evidence about the tree — the serial re-run in scripts/agent-check.sh is what asks.");
    lines.push('   docs/ROUTINES.md, "When the box is the problem", is what to do with its answer.');
  } else {
    lines.push("   At least one failure is the product answering, so this run is evidence about the tree.");
  }
  return lines;
}
