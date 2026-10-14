import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { advisoriesOf, assertExceptions, classify, failed, type AuditException, type AuditReport } from "./audit";

/** An `npm audit --json` report, trimmed to the shape the gate reads. The chain here is the real one the
 *  repo has: eslint-config-next depends on a plugin that depends on fast-glob that depends on braces. npm
 *  lists all four, but only braces carries the advisory object; the rest name their dependency as a string. */
const report: AuditReport = {
  vulnerabilities: {
    braces: {
      severity: "high",
      via: [{ source: 1240992, name: "braces", title: "braces stack exhaustion", url: "https://example.test/braces", severity: "high" }],
      nodes: ["node_modules/braces"],
    },
    "fast-glob": { severity: "high", via: ["braces"], nodes: ["node_modules/fast-glob"] },
    "eslint-config-next": { severity: "high", via: ["fast-glob"], nodes: ["node_modules/eslint-config-next"] },
    postcss: {
      severity: "high",
      via: [
        { source: 1117015, name: "postcss", title: "postcss XSS via stringify", url: "https://example.test/a", severity: "moderate" },
        { source: 1124252, name: "postcss", title: "postcss arbitrary file read", url: "https://example.test/b", severity: "high" },
      ],
      nodes: ["node_modules/next/node_modules/postcss"],
    },
  },
};

const exception = (over: Partial<AuditException> = {}): AuditException => ({
  advisory: 1240992,
  package: "braces",
  reason: "devDependency, reached only by eslint over our own globs",
  owner: "compliance",
  expires: "2099-01-01",
  ...over,
});

const NOW = new Date("2026-10-11T00:00:00Z");

test("an advisory is counted once, however many packages npm lists it under", () => {
  const found = advisoriesOf(report);
  assert.deepEqual(
    found.map((a) => a.source),
    [1240992, 1124252],
  );
});

test("a moderate advisory is below the gate", () => {
  // postcss has four advisories; only the high ones fail a build at --audit-level=high.
  assert.equal(advisoriesOf(report).some((a) => a.source === 1117015), false);
});

test("the paths of every package carrying one advisory are merged", () => {
  const braces = advisoriesOf(report).find((a) => a.source === 1240992)!;
  assert.deepEqual(braces.paths, ["node_modules/braces"]);
  assert.equal(braces.package, "braces");
});

test("an empty report has nothing to say", () => {
  assert.deepEqual(advisoriesOf({}), []);
  assert.deepEqual(advisoriesOf({ vulnerabilities: {} }), []);
});

test("an advisory with no exception blocks", () => {
  const verdict = classify(advisoriesOf(report), [exception()], NOW);
  assert.deepEqual(verdict.blocking.map((a) => a.source), [1124252]);
  assert.deepEqual(verdict.allowed.map((a) => a.advisory.source), [1240992]);
  assert.equal(failed(verdict), true);
});

test("every advisory excepted means a pass", () => {
  const verdict = classify(advisoriesOf(report), [exception(), exception({ advisory: 1124252, package: "postcss" })], NOW);
  assert.deepEqual(verdict.blocking, []);
  assert.equal(failed(verdict), false);
});

test("an expired exception fails even though the advisory is listed", () => {
  // The whole point of the date: an exception nobody re-assessed stops working on its own.
  const verdict = classify(advisoriesOf(report), [exception({ expires: "2026-01-01" }), exception({ advisory: 1124252, package: "postcss" })], NOW);
  assert.deepEqual(verdict.expired.map((e) => e.advisory), [1240992]);
  assert.deepEqual(verdict.blocking.map((a) => a.source), [1240992]);
  assert.equal(failed(verdict), true);
});

test("an exception that matches nothing is stale, not a failure", () => {
  const verdict = classify([], [exception()], NOW);
  assert.deepEqual(verdict.stale.map((e) => e.advisory), [1240992]);
  assert.equal(failed(verdict), false);
});

test("an exception missing a reason, an owner, or an expiry is rejected", () => {
  for (const field of ["reason", "owner", "expires"] as const) {
    const broken = { ...exception() };
    delete (broken as Partial<AuditException>)[field];
    assert.throws(() => assertExceptions([broken]), new RegExp(`missing "${field}"`), field);
  }
  assert.throws(() => assertExceptions([exception({ expires: "soon" })]), /unparsable "expires"/);
});

test("the repo's own exception file is well formed and every exception is still live", () => {
  const file = path.join(import.meta.dirname, "..", "security", "audit-exceptions.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { exceptions?: AuditException[] };
  const exceptions = parsed.exceptions ?? [];
  assertExceptions(exceptions);
  for (const e of exceptions) {
    assert.ok(Date.parse(e.expires) > Date.now(), `exception ${e.advisory} for ${e.package} expired on ${e.expires}; re-assess it per docs/SECURITY.md`);
    assert.ok(e.reason.length > 40, `exception ${e.advisory} needs a reason someone can act on`);
  }
});
