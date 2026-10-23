import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/** scripts/gh-issues.sh, the read both routines' opening question goes through (T127). The bug it exists for
 *  cannot be reproduced on demand against GitHub — an intermittent HTTP 200 with an empty array, about one
 *  read in three — so the listing command is stubbed and the plan of what each successive read returns is
 *  the test input. Design §12.4's loop starts with a routine asking GitHub what to do; docs/ROUTINES.md,
 *  "An empty listing that is not an empty list", is the prose version.
 *
 *  Like lib/workflows.test.ts, this file has no module of its own under lib/: its subject is a script in
 *  scripts/, and `npm test` only collects lib/*.test.ts. */

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts", "gh-issues.sh");

/** One read of the stub's plan. `empty` is the fault being reproduced, `fail` a `gh` that exits non-zero,
 *  and anything else is sent to stdout verbatim — a JSON array for a healthy read. The last line of a plan
 *  repeats for every read after it, so a plan says what changes and not how many times it is asked. */
type Reply = "empty" | "fail" | string;

type Stub = {
  dir: string;
  /** What each successive read of a query returns. The key is a substring of the query, "*" the fallback. */
  plan: (replies: Record<string, Reply[]>) => void;
  /** How many times the stub was asked a query (any query when the substring is omitted). */
  reads: (match?: string) => number;
  cleanup: () => void;
};

function stubGh(): Stub {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-issues-test-"));
  const bin = path.join(dir, "gh");
  // A `gh` on PATH that answers `api <query>` from plan.json: the key is the first plan entry the query
  // contains ("*" is the fallback), and the reply is that key's nth element for the nth read of the same
  // query, the last element repeating for ever. Everything it is asked goes in the log, which is how a test
  // asserts that a read happened twice, or that a page was never asked for.
  writeFileSync(
    bin,
    `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const query = process.argv[3] || "";
const logPath = dir + "/log";
const prior = fs.readFileSync(logPath, "utf8").split("\\n").filter(Boolean);
fs.appendFileSync(logPath, query + "\\n");
const plan = JSON.parse(fs.readFileSync(dir + "/plan.json", "utf8"));
const key = Object.keys(plan).find((k) => k !== "*" && query.includes(k)) || (plan["*"] ? "*" : null);
if (!key) {
  process.stderr.write("gh stub: no plan for " + query + "\\n");
  process.exit(1);
}
const sequence = plan[key];
const nth = prior.filter((q) => q === query).length;
const reply = sequence[Math.min(nth, sequence.length - 1)];
if (reply === "fail") {
  process.stderr.write("gh stub: asked to fail\\n");
  process.exit(1);
}
process.stdout.write((reply === "empty" ? "[]" : reply) + "\\n");
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, "log"), "");
  return {
    dir,
    plan(replies) {
      writeFileSync(path.join(dir, "plan.json"), JSON.stringify(replies));
    },
    reads(match) {
      const log = readFileSync(path.join(dir, "log"), "utf8").split("\n").filter(Boolean);
      return match ? log.filter((q) => q.includes(match)).length : log.length;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Run = { status: number; stdout: string; stderr: string };

function run(stub: Stub, args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync("bash", [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${stub.dir}:${process.env.PATH}`,
        R: "owner/repo",
        GH_ISSUES_SLEEP: "0",
        GH_ISSUES_MAX_READS: "8",
        GH_ISSUES_EMPTY_READS: "4",
        ...env,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** `n` issues shaped like the listing the routines read, titled T1.. so a page can be told from another. */
const issues = (numbers: number[]) =>
  JSON.stringify(
    numbers.map((n) => ({ number: n, title: `T${n}: ticket ${n}`, state: "open", pull_request: null })),
  );

const SEVEN = issues([1, 2, 3, 4, 5, 6, 7]);
const open = "state=open";

test("a listing that reads the same twice is the answer", () => {
  const stub = stubGh();
  try {
    stub.plan({ "*": [SEVEN] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map((i: { number: number }) => i.number), [1, 2, 3, 4, 5, 6, 7]);
    // Two reads, not one: an answer nothing corroborates is the thing this replaces.
    assert.equal(stub.reads(open), 2);
  } finally {
    stub.cleanup();
  }
});

test("the intermittent empty answer does not end the run", () => {
  const stub = stubGh();
  try {
    // The measured shape: about one read in three comes back `[]` with HTTP 200.
    stub.plan({ "*": ["empty", SEVEN, "empty", SEVEN, SEVEN] });
    const r = run(stub, ["list", "repos/owner/repo/issues?labels=ready&state=open&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 7, "the seven open issues, not the empty replica's answer");
  } finally {
    stub.cleanup();
  }
});

test("two empties in a row are not an empty list", () => {
  const stub = stubGh();
  try {
    // The criterion this script is written against: the fault produces consecutive empties, so agreement
    // between two of them proves nothing. The rows on the third read must still win.
    stub.plan({ "*": ["empty", "empty", SEVEN, SEVEN] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 7);
  } finally {
    stub.cleanup();
  }
});

test("a genuinely empty listing is answered, after more than agreement", () => {
  const stub = stubGh();
  try {
    stub.plan({ "*": ["empty"] });
    const r = run(stub, ["list", "repos/owner/repo/issues?labels=blocked&state=open&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), []);
    // Four consecutive empties, which is 0.33^4 against a listing that has rows.
    assert.equal(stub.reads("labels=blocked"), 4);
  } finally {
    stub.cleanup();
  }
});

test("reads that disagree to the end exit non-zero rather than answer", () => {
  const stub = stubGh();
  try {
    // Alternating for ever: no two consecutive reads ever agree.
    stub.plan({ "*": ["empty", SEVEN, "empty", SEVEN, "empty", SEVEN, "empty", SEVEN, "empty"] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.notEqual(r.status, 0, "an answer that cannot be corroborated must not be printed");
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /never agreed/);
    assert.match(r.stderr, /rows per read: ?0 7 0 7/, "the counts it saw, for the record on the issue");
    assert.equal(stub.reads(open), 8, "bounded: GH_ISSUES_MAX_READS reads and no more");
  } finally {
    stub.cleanup();
  }
});

test("a shorter listing is never the answer, however often it repeats", () => {
  const stub = stubGh();
  try {
    // Fewer rows than a read of this run has already seen is the suspect direction, and the empty body is
    // only its extreme: two identical three-row reads after a seven-row one are not an answer either.
    stub.plan({ "*": [SEVEN, issues([1, 2, 3])] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /rows per read: ?7 3 3/);
  } finally {
    stub.cleanup();
  }
});

test("a listing that grows between reads settles on the larger answer", () => {
  const stub = stubGh();
  try {
    // Someone filed an issue mid-run. The new listing is bigger, so it is not the suspect direction, and
    // two reads of it agree.
    stub.plan({ "*": [SEVEN, issues([1, 2, 3, 4, 5, 6, 7, 8])] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 8);
  } finally {
    stub.cleanup();
  }
});

test("a gh that fails is retried, and a gh that only fails is a failure", () => {
  const stub = stubGh();
  try {
    stub.plan({ "*": ["fail", SEVEN, SEVEN] });
    const good = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).length, 7);

    const broken = stubGh();
    try {
      broken.plan({ "*": ["fail"] });
      const r = run(broken, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /error error/, "every read errored, and the history says so");
    } finally {
      broken.cleanup();
    }
  } finally {
    stub.cleanup();
  }
});

test("a response that is not an array is not an answer", () => {
  const stub = stubGh();
  try {
    // What a rate limit or a bad path returns. Retried like any other unusable read, then a loud failure.
    stub.plan({ "*": ['{"message":"API rate limit exceeded"}'] });
    const r = run(stub, ["list", "repos/owner/repo/issues?state=open&per_page=100"]);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /rate limit/, "the body is never printed as a listing");
  } finally {
    stub.cleanup();
  }
});

test("the page walk stops at a corroborated short page", () => {
  const stub = stubGh();
  try {
    stub.plan({ "&page=1": [issues([1, 2])], "*": ["empty"] });
    const r = run(stub, ["pages", "repos/owner/repo/issues?state=all&per_page=100"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 2);
    assert.equal(stub.reads("&page=2"), 0, "a page past the end is never asked for");
  } finally {
    stub.cleanup();
  }
});

test("the next number is the highest T<nn> across every page, plus one", () => {
  const stub = stubGh();
  try {
    const full = issues(Array.from({ length: 100 }, (_, i) => i + 1));
    stub.plan({ "&page=1": [full], "&page=2": [issues([120, 125])] });
    const r = run(stub, ["next-number"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "T126");
  } finally {
    stub.cleanup();
  }
});

test("the next number fails rather than coming back lower when a page cannot be read", () => {
  const stub = stubGh();
  try {
    // The failure this is most meant to prevent: page 2 holds T125, and the pass that loses it answers
    // T63 — a number taken since September — instead of erroring.
    const full = issues(Array.from({ length: 100 }, (_, i) => i + 1));
    stub.plan({
      "&page=1": [full],
      "&page=2": ["empty", issues([120, 125]), "empty", issues([120, 125]), "empty", issues([120, 125]), "empty", issues([120, 125]), "empty"],
    });
    const r = run(stub, ["next-number"]);
    assert.notEqual(r.status, 0, `answered ${r.stdout.trim()} on a walk that lost a page`);
    assert.doesNotMatch(r.stdout, /T/, "no number is printed at all");
    assert.match(r.stderr, /never agreed/);
  } finally {
    stub.cleanup();
  }
});

test("the page walk refuses to answer when there are more pages than it walked", () => {
  const stub = stubGh();
  try {
    // Every page full to the last one it is allowed to read: the old snippet's fixed `for p in 1 2 3 4`
    // would have returned the first four pages as though they were all of them.
    const full = issues(Array.from({ length: 100 }, (_, i) => i + 1));
    stub.plan({ "*": [full] });
    const r = run(stub, ["pages", "repos/owner/repo/issues?state=all&per_page=100"], { GH_ISSUES_MAX_PAGES: "2" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /there are more; raise GH_ISSUES_MAX_PAGES/);
  } finally {
    stub.cleanup();
  }
});

test("a dependency resolves to the issue that owns the number, not to a pull request", () => {
  const stub = stubGh();
  try {
    const page = JSON.stringify([
      { number: 55, title: "T42: Unit tests for the lib/ modules", state: "closed", pull_request: null },
      { number: 67, title: "T42: the node:crypto edge-bundle build break", state: "closed", pull_request: { url: "x" } },
      { number: 66, title: "T42: the node:crypto edge-bundle build break", state: "closed", pull_request: null },
    ]);
    stub.plan({ "&page=1": [page] });
    const r = run(stub, ["depends", "T42"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 2, "both issues titled T42, so the collision table gets read");
    assert.ok(lines.every((l) => !l.startsWith("67 ")), "the pull request is excluded");
    assert.ok(lines.some((l) => l.startsWith("55 closed ")));
  } finally {
    stub.cleanup();
  }
});

test("a dependency nothing owns is a failure, not an absence", () => {
  const stub = stubGh();
  try {
    stub.plan({ "&page=1": [issues([1, 2])] });
    const r = run(stub, ["depends", "T99"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not one that is closed/);
  } finally {
    stub.cleanup();
  }
});

test("both procedures read their listings through the helper", () => {
  const routines = readFileSync(path.join(repoRoot, "docs", "ROUTINES.md"), "utf8");
  assert.match(routines, /scripts\/gh-issues\.sh/, "the helper is in the doc the routines follow");
  assert.match(
    routines,
    /an empty list from a routine's opening read is not evidence that there is nothing to do/i,
    "the rule, in the words the ticket asked for",
  );
  // The third trap, beside --paginate and per_page=100.
  const traps = routines.slice(routines.indexOf("## GitHub from the sandbox: REST only"));
  for (const expected of ["`gh api --paginate` does not work here", "`per_page=100` is one page", "answer `HTTP 200` with `[]`"]) {
    assert.ok(traps.includes(expected), `the trap list must still name: ${expected}`);
  }
  // Each procedure's opening read, and the two page walks, point at the helper rather than at a bare call.
  const builder = routines.slice(routines.indexOf("## The builder"), routines.indexOf("## The reviewer"));
  assert.match(builder, /gh-issues\.sh/, "the builder's ticket pick goes through the helper");
  const reviewer = routines.slice(routines.indexOf("## The reviewer"), routines.indexOf("## The state of `main`"));
  assert.match(reviewer, /gh-issues\.sh/, "the reviewer's `review` listing goes through the helper");
  assert.match(routines, /gh-issues\.sh next-number/, "the next-number rule's snippet");
  assert.match(routines, /gh-issues\.sh depends/, "the dependency snippet");
});
