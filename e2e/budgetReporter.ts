import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { type Budget, type FailedTest, reportFailures, summariseFailures } from "../lib/budgetFailure";
import { BUDGETS } from "./budget";

// What this run's failures are evidence about, said in the run's own log (T161, design §12.4).
//
// docs/ROUTINES.md, "When the box is the problem", tells a routine to read the timings table before it
// believes a failure. That works when the whole box is crawling and not when one wait loses a scheduling
// race: 30s of stalled wait is 4% of an eleven-minute e2e stage, so the table is unremarkable while the
// failure names the product. The reviewer run of 2026-10-26 spent a serial re-run and a second full check
// working that out on a `main` that was never red, and `lib/budgetFailure.ts` is the comment that explains
// the distinction this prints.
//
// It is a reporter rather than something inside the specs because the question is about the run and not
// about one test: "did anything fail that was not a clock?" is what decides whether a serial re-run can
// excuse the run at all, and only something that sees every test can answer it. The file it writes is how
// scripts/agent-check.sh reads that answer without parsing the log.

/** Where the run leaves its verdict for scripts/agent-check.sh. Gitignored, like every other run artefact. */
export const FAILURES_FILE = process.env.E2E_FAILURES_FILE ?? "e2e/.failures.json";

/** The per-test ceiling, which is the test's own rather than the suite's: three specs raise theirs (T89). */
const perTest = (test: TestCase): Budget => ({
  name: "the per-test ceiling (E2E_TEST_TIMEOUT_MS)",
  ms: test.timeout,
});

export default class BudgetReporter implements Reporter {
  private failed: FailedTest[] = [];

  onBegin(): void {
    // So that a stale verdict can never be read as this run's — the same reason scripts/agent-check.sh
    // empties e2e/screenshots/ and the mailboxes before anything that can fail. A run that dies before
    // `onEnd` leaves no file rather than the last run's.
    rmSync(FAILURES_FILE, { force: true });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // `failed` and `timedOut` only. An `interrupted` test is one the run never finished asking, so it is
    // not a failure to classify, and leaving it out keeps `allClocks` false for a run that was cut short —
    // which is the safe direction: nothing gets excused on the strength of tests that never ran.
    if (result.status !== "failed" && result.status !== "timedOut") return;
    this.failed.push({
      project: test.parent.project()?.name ?? "unknown",
      title: test.title,
      location: `${test.location.file.replace(`${process.cwd()}/`, "")}:${test.location.line}`,
      error: result.errors
        .map((error) => [error.message, error.snippet].filter(Boolean).join("\n"))
        .join("\n\n"),
      budgets: [...BUDGETS, perTest(test)],
    });
  }

  onEnd(): void {
    const report = reportFailures(this.failed);
    if (report.failures.length === 0) return;
    for (const line of summariseFailures(report)) process.stdout.write(`${line}\n`);
    mkdirSync(dirname(FAILURES_FILE), { recursive: true });
    // The whole report, not just the one flag the check script reads: a routine that wants to know which
    // test it was and what clock it ran has it without re-reading the log.
    writeFileSync(FAILURES_FILE, `${JSON.stringify(report, null, 2)}\n`);
  }

  printsToStdio(): boolean {
    return true;
  }
}
