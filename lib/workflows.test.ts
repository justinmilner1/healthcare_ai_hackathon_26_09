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
