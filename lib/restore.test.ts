import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRestoreReport,
  REQUIRED_TABLES,
  RESTORE_TABLES,
  type RestoreInventory,
  type RestoreTable,
  verifyRestore,
} from "./restore";

// Design §11.4: the drill in docs/BACKUPS.md asks these questions of the instance that came back. Each test
// below is one way a point-in-time restore succeeds and is still the wrong database.

const MIGRATIONS = ["20261010120000_init", "20261010223000_visit_model", "20261011050000_dexcom_state_by_visit"];
const RESTORED_TO = new Date("2026-10-15T09:00:00.000Z");

function inventory(over: Partial<RestoreInventory> = {}): RestoreInventory {
  const counts = Object.fromEntries(RESTORE_TABLES.map((t) => [t, 4])) as Record<RestoreTable, number>;
  return {
    appliedMigrations: [...MIGRATIONS],
    counts,
    newestAuditAt: new Date("2026-10-15T08:55:00.000Z"),
    restoredTo: RESTORED_TO,
    ...over,
  };
}

const check = (inv: RestoreInventory, name: string, maxLagMinutes?: number) => {
  const found = verifyRestore(inv, { expectedMigrations: MIGRATIONS, maxLagMinutes }).checks.find((c) => c.name === name);
  assert.ok(found, `no ${name} check`);
  return found;
};

test("a restore of a healthy database passes every check", () => {
  const verdict = verifyRestore(inventory(), { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, true);
  assert.deepEqual(
    verdict.checks.map((c) => c.name),
    ["migrations", "tables", "audit", "freshness"],
  );
  for (const c of verdict.checks) assert.equal(c.level, "pass", `${c.name}: ${c.detail}`);
});

test("a snapshot from before the last migration fails, and says which ones are missing", () => {
  const verdict = verifyRestore(inventory({ appliedMigrations: MIGRATIONS.slice(0, 1) }), { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, false);
  const migrations = check(inventory({ appliedMigrations: MIGRATIONS.slice(0, 1) }), "migrations");
  assert.equal(migrations.level, "fail");
  // Both, not just the first: an operator reading this decides whether to roll the code back or the data forward.
  assert.match(migrations.detail, /20261010223000_visit_model and 20261011050000_dexcom_state_by_visit/);
});

test("a restore ahead of this checkout is a warning, because that is what a rollback looks like (§13.3)", () => {
  const ahead = inventory({ appliedMigrations: [...MIGRATIONS, "20261016000000_later"] });
  const verdict = verifyRestore(ahead, { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, true, "the data is intact; only the code reading it is older");
  assert.equal(check(ahead, "migrations").level, "warn");
  assert.match(check(ahead, "migrations").detail, /20261016000000_later/);
});

test("an empty database is the loudest failure a drill can have", () => {
  const empty = inventory({
    counts: Object.fromEntries(RESTORE_TABLES.map((t) => [t, 0])) as Record<RestoreTable, number>,
    newestAuditAt: null,
  });
  const verdict = verifyRestore(empty, { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, false);
  const tables = verdict.checks.find((c) => c.name === "tables")!;
  assert.equal(tables.level, "fail");
  for (const table of REQUIRED_TABLES) assert.match(tables.detail, new RegExp(table));
});

test("a practice with no summaries or uploads yet is still a good restore", () => {
  const young = inventory({ counts: { ...inventory().counts, Summary: 0, Upload: 0 } });
  const verdict = verifyRestore(young, { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.checks.find((c) => c.name === "tables")!.level, "pass");
});

test("visits without an audit trail fail: §10.2 is the record a practice cannot rebuild", () => {
  const lost = inventory({ counts: { ...inventory().counts, AuditLog: 0 } });
  assert.equal(verifyRestore(lost, { expectedMigrations: MIGRATIONS }).ok, false);
  assert.match(check(lost, "audit").detail, /no audit trail/);
});

test("an empty database with no audit rows is not blamed twice for it", () => {
  const empty = inventory({ counts: { ...inventory().counts, AuditLog: 0, Visit: 0 }, newestAuditAt: null });
  // The tables check already failed; the audit check has nothing to add beyond a note.
  assert.equal(check(empty, "audit").level, "warn");
});

test("data from after the restore target means this is not the instance the drill asked for", () => {
  const impossible = inventory({ newestAuditAt: new Date("2026-10-15T09:30:00.000Z") });
  const verdict = verifyRestore(impossible, { expectedMigrations: MIGRATIONS });
  assert.equal(verdict.ok, false);
  assert.equal(check(impossible, "freshness").level, "fail");
  assert.match(check(impossible, "freshness").detail, /30 min after/);
});

test("a long way behind the target is a warning with the number in it, not a failure", () => {
  const stale = inventory({ newestAuditAt: new Date("2026-10-15T05:00:00.000Z") });
  assert.equal(verifyRestore(stale, { expectedMigrations: MIGRATIONS }).ok, true);
  assert.equal(check(stale, "freshness").level, "warn");
  assert.match(check(stale, "freshness").detail, /240 min before/);
  // A practice that is quiet overnight is quiet; the drill's own window decides what counts as a long way.
  assert.equal(check(stale, "freshness", 300).level, "pass");
});

test("with nothing to date the restore by, freshness says so instead of guessing", () => {
  assert.equal(check(inventory({ newestAuditAt: null }), "freshness").level, "warn");
  const untargeted = check(inventory({ restoredTo: null }), "freshness");
  assert.equal(untargeted.level, "warn");
  assert.match(untargeted.detail, /no restore target given/);
});

test("the report is one line per check plus the counts, for pasting into the drill record", () => {
  const inv = inventory();
  const text = formatRestoreReport(verifyRestore(inv, { expectedMigrations: MIGRATIONS }), inv);
  assert.match(text, /^restore: ok$/m);
  for (const c of ["migrations", "tables", "audit", "freshness"]) assert.match(text, new RegExp(`^  ${c}\\s`, "m"));
  for (const table of RESTORE_TABLES) assert.match(text, new RegExp(`${table}=4`));
  assert.match(formatRestoreReport(verifyRestore(inventory({ counts: { ...inv.counts, Visit: 0 } }), { expectedMigrations: MIGRATIONS }), inv), /^restore: failed$/m);
});
