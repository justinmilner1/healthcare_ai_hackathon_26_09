import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/** The one wiring in this repo whose failure is silence. Design §12.4 asks for a check on main after every
 *  commit, and for three merges nothing ran on main at all (T47). Nothing goes red when this wiring is
 *  dropped — the runs simply stop happening — so these assertions stand in for the alarm the Actions tab does
 *  not raise. Since 2026-10-18 the routines push to main directly and the sandbox check is the gate; ci.yml
 *  is the second opinion, and this keeps its triggers and its main-red reporting in place. docs/ROUTINES.md,
 *  "The state of main", is the prose version. */
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test("ci runs on main after every push, on demand, and on a schedule", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^on:$/m);
  assert.match(ci, /^\s{2}workflow_dispatch:$/m, "ci.yml must be dispatchable, so a run on main can be asked for by hand");
  assert.match(ci, /^\s{2}schedule:$/m, "ci.yml needs the scheduled backstop for a dispatch that never happened");
  assert.match(ci, /^\s{4}- cron: /m);
  assert.match(ci, /^\s{2}push:\n\s{4}branches: \[main\]$/m, "every push to main is checked");
  // Fail open. An errored lookup in `sweep` leaves the output empty, and the job that exists to catch a
  // check that did not happen must not answer that by not happening.
  assert.match(ci, /needs\.sweep\.outputs\.unchecked != 'false'/, "the scheduled check runs unless sweep positively said main is covered");
});

test("a red main reports itself", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^\s{2}main-state:$/m, "the job that turns a red main into an open issue");
  assert.match(ci, /issues: write/, "main-state opens and closes the main-red issue");
  assert.match(ci, /"main-red"/, "the label the routines look for");
  // Not `ready`, and no T-number: the builder picks tickets off `ready`, and a red main is a diagnosis for
  // the reviewer sweep rather than a ticket anyone can start.
  assert.ok(!/labels: \[label, "bug", "area:quality", "ready"\]/.test(ci));
  assert.match(read("docs/ROUTINES.md"), /main-red/, "§12.4's post-merge check is written down for both routines");
});

test("the procedure cannot read a blocked Actions account as a red main (T92)", () => {
  // A blocked account still schedules runs; they get no runner and fail in seconds with no steps, so
  // `conclusion=failure` on its own says nothing about the tree. The one call that tells the two apart has
  // to be in the doc, because a routine that reads the wall of red as a verdict reverts good work on main.
  // That signature is history since Actions came back on 2026-11-01 (T215) and the doc now says so, but the
  // assertions below are about the shape of the diagnosis rather than that one cause: the jobs call, the
  // step count it is read for, and the two conclusions a routine must not act on. Billing can lapse again.
  const routines = read("docs/ROUTINES.md");
  assert.match(routines, /actions\/runs\/[^\s]*\/jobs/, "the jobs call that shows whether a run executed anything");
  assert.match(routines, /steps\|length/, "and the step count it is read for");
  assert.match(routines, /\*\*never\*\* grounds for a revert/, "a run that executed nothing is never grounds for a revert");
  assert.match(
    routines,
    /no\n`main-red` issue can ever be opened/,
    "main-state is an Actions job, so the label's absence is not a green main",
  );
});

test("the check job's budget is big enough for the check, and the doc reads a cancelled run (T215)", () => {
  // Between 2026-11-01T00:52Z and T215 every push run was cancelled at 20m24s part-way through the suite,
  // against a `timeout-minutes: 20` that a roughly 28-minute check never fitted. So §12.4's second opinion
  // never finished, and `main-state` — which needs a `success` or `failure` from `check` — was skipped every
  // time. Both halves are pinned here: a budget that cannot hold the check is the bug, and a routine with no
  // rule for `cancelled` is how a healthy commit gets reverted.
  const ci = read(".github/workflows/ci.yml");
  const budget = /^\s{4}timeout-minutes: (\d+)$/m.exec(ci.slice(ci.indexOf("\n  check:")));
  assert.ok(budget, "the check job needs a timeout-minutes of its own");
  assert.ok(
    Number(budget[1]) >= 40,
    `the check measured about 28 minutes on a runner and longer on a failed suite, which re-runs the failures serially; ${budget[1]} minutes cannot hold it`,
  );
  // The number is only half of it: the next person to touch it needs the evidence, not a round figure.
  assert.match(ci, /run 41328771421/i, "the budget says which run it was sized against");

  const routines = read("docs/ROUTINES.md");
  assert.match(routines, /completed\/cancelled/, "the listing a routine actually gets shows a cancelled run");
  assert.match(
    routines,
    /\*\*never\*\* grounds for a revert/,
    "a cancelled run is no more grounds for a revert than a blocked one: a clock that ran out saw nothing",
  );
  // The hourly backstop's green tick belongs to `sweep`, not to the check, and is not evidence of a pass.
  assert.match(routines, /`check` is `skipped`|`check` is skipped|whose `check` is `skipped`/, "a schedule run that short-circuited is not a verdict");
  // §12.4 is unchanged by any of this: Actions passing is not a licence to skip the sandbox check.
  assert.match(
    routines,
    /Actions passing does\nnot stand in for it/,
    "the gate stays scripts/agent-check.sh in the pushing agent's own sandbox",
  );
});
