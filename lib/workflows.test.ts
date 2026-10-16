import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/** The one wiring in this repo whose failure is silence. Design §12.4 asks for green checks on merges to
 *  main, and for three merges nothing ran on main at all (T47): GitHub starts no workflow run from a push the
 *  repository's own `GITHUB_TOKEN` made, so the squash merges `auto-merge` performs are invisible to the
 *  `push` trigger. Nothing goes red when this wiring is dropped — the runs simply stop happening — so these
 *  assertions stand in for the alarm the Actions tab does not raise. docs/ROUTINES.md, "The state of main",
 *  is the prose version. */
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test("ci runs on main after a merge, and not only before one", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /^on:$/m);
  assert.match(ci, /^\s{2}workflow_dispatch:$/m, "ci.yml must be dispatchable: auto-merge asks for the run on main by hand");
  assert.match(ci, /^\s{2}schedule:$/m, "ci.yml needs the scheduled backstop for a dispatch that never happened");
  assert.match(ci, /^\s{4}- cron: /m);
  assert.match(ci, /^\s{2}push:\n\s{4}branches: \[main\]$/m, "a human push to main is still checked");
});

test("auto-merge asks for the run that checks the merge result", () => {
  const merge = read(".github/workflows/auto-merge.yml");
  assert.match(merge, /actions: write/, "createWorkflowDispatch needs actions: write, not read");
  assert.match(
    merge,
    /createWorkflowDispatch\(\{ owner, repo, workflow_id: "ci\.yml", ref: "main" \}\)/,
    "the merge is only half of it: ci has to be dispatched on main afterwards",
  );
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
