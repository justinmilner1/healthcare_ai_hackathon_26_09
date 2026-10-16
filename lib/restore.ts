// Is a restored database a usable Sweet Spot database? (design §11.4). Owner: ops.
//
// §11.4 asks for two things: RDS automated backups with seven days of retention, and "a documented restore
// drill". The backups are infra/lib/sweetspot-stack.ts; the drill is docs/BACKUPS.md. This module is the
// step in the middle of that drill that a person should not have to do by eye — looking at the database
// that came back and saying whether it is the one that went in.
//
// Why that step needs code at all: a point-in-time restore always *succeeds*. RDS hands back an instance
// that accepts connections whatever is in it, so the failure modes a drill exists to catch are all quiet
// ones — a snapshot from before the last migration, an empty database because the restore ran against the
// wrong identifier, a target time that silently resolved hours earlier than the one asked for. Each of
// those is an instance a tired operator at 3am would call a successful restore.
//
// The split is the usual one (lib/health.ts, lib/retention.ts): everything here is pure and unit-tested
// against the shapes below, and scripts/restore-drill.ts is the half that opens a connection and counts.

/** The tables the drill counts. Not every table — the ones whose emptiness means something. */
export const RESTORE_TABLES = ["Practice", "User", "Patient", "Visit", "AuditLog", "Summary", "Upload"] as const;
export type RestoreTable = (typeof RESTORE_TABLES)[number];

/**
 * A table that cannot legitimately be empty in a practice worth restoring. A restore whose `Visit` table is
 * empty is either the wrong instance or a point in time before the practice existed; either way it is not
 * the backup anybody meant to take. `Summary` and `Upload` are counted but not required: a practice can be
 * live for a week with neither.
 */
export const REQUIRED_TABLES: readonly RestoreTable[] = ["Practice", "User", "Patient", "Visit"];

/** What scripts/restore-drill.ts reads out of the candidate database. */
export type RestoreInventory = {
  /** `_prisma_migrations`: the migrations the restored database has finished applying. */
  appliedMigrations: string[];
  counts: Record<RestoreTable, number>;
  /** The newest `AuditLog.at`. The audit trail (§10.2) records every read, send and deletion, so it is the
   *  closest thing the schema has to a clock of its own. Null when the table is empty. */
  newestAuditAt: Date | null;
  /** The point in time the instance was restored to, as RDS reports it. Null when the drill was not told. */
  restoredTo: Date | null;
};

export type CheckLevel = "pass" | "warn" | "fail";
export type RestoreCheck = { name: string; level: CheckLevel; detail: string };
export type RestoreVerdict = { ok: boolean; checks: RestoreCheck[] };

export type RestoreExpectation = {
  /** The migration directory names this checkout has, oldest first — `prisma/migrations/*`. */
  expectedMigrations: readonly string[];
  /** How far the newest audit row may sit behind the restore target before it is worth a second look.
   *  A warning, never a failure: a quiet practice is quiet, and an hour of no reads is not data loss. */
  maxLagMinutes?: number;
};

const MINUTE_MS = 60_000;
const DEFAULT_MAX_LAG_MINUTES = 60;

/** `a, b and c`, so a failure names every missing thing rather than the first one. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Every migration this checkout knows about is applied in the restored database.
 *
 * Missing ones are a failure: the application that would be pointed at this instance is this checkout, and
 * it expects columns the restore has not got. Extra ones are only a warning — the snapshot is *newer* than
 * the code reading it, which is what restoring yesterday's backup during a rollback looks like (§13.3), and
 * the operator doing that already knows.
 */
function migrationCheck(inventory: RestoreInventory, expected: readonly string[]): RestoreCheck {
  const applied = new Set(inventory.appliedMigrations);
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    return { name: "migrations", level: "fail", detail: `${missing.length} not applied: ${list(missing)}` };
  }
  const known = new Set(expected);
  const extra = inventory.appliedMigrations.filter((name) => !known.has(name));
  if (extra.length > 0) {
    return { name: "migrations", level: "warn", detail: `${extra.length} ahead of this checkout: ${list(extra)}` };
  }
  return { name: "migrations", level: "pass", detail: `${expected.length} applied, none missing` };
}

/** The tables that cannot be empty, are not. */
function tableCheck(inventory: RestoreInventory): RestoreCheck {
  const empty = REQUIRED_TABLES.filter((table) => (inventory.counts[table] ?? 0) <= 0);
  if (empty.length > 0) return { name: "tables", level: "fail", detail: `empty: ${list(empty)}` };
  const rows = REQUIRED_TABLES.map((table) => `${table} ${inventory.counts[table]}`);
  return { name: "tables", level: "pass", detail: rows.join(", ") };
}

/**
 * §10.2: the audit trail outlives the data it describes — §10.4's sweep and §10.5's deletion both leave it
 * behind on purpose. So a restore that has visits but no audit rows has lost the one record a practice
 * cannot reconstruct, and that is a failed drill however healthy the rest of it looks.
 */
function auditCheck(inventory: RestoreInventory): RestoreCheck {
  const audit = inventory.counts.AuditLog ?? 0;
  if (audit <= 0 && (inventory.counts.Visit ?? 0) > 0) {
    return { name: "audit", level: "fail", detail: "visits restored with no audit trail (§10.2)" };
  }
  if (audit <= 0) return { name: "audit", level: "warn", detail: "no audit rows" };
  return { name: "audit", level: "pass", detail: `${audit} rows` };
}

/**
 * How close the restored data is to the point in time that was asked for.
 *
 * Two different answers here. An audit row *after* the restore target is not lag, it is arithmetic that
 * cannot happen: the instance holds data from after the moment it was restored to, so it is not the
 * instance the drill thinks it is — a failure. Behind the target is ordinary and only interesting when it
 * is a long way behind, which is a warning worth a look at the real `LatestRestorableTime`.
 */
function freshnessCheck(inventory: RestoreInventory, maxLagMinutes: number): RestoreCheck {
  const { newestAuditAt, restoredTo } = inventory;
  if (!newestAuditAt) return { name: "freshness", level: "warn", detail: "no audit row to date the restore by" };
  if (!restoredTo) return { name: "freshness", level: "warn", detail: `newest row ${newestAuditAt.toISOString()}, no restore target given` };

  const lagMs = restoredTo.getTime() - newestAuditAt.getTime();
  if (lagMs < 0) {
    const ahead = Math.round(-lagMs / MINUTE_MS);
    return { name: "freshness", level: "fail", detail: `newest row is ${ahead} min after the restore target` };
  }
  const lag = Math.round(lagMs / MINUTE_MS);
  const level: CheckLevel = lag > maxLagMinutes ? "warn" : "pass";
  return { name: "freshness", level, detail: `newest row ${lag} min before the restore target (limit ${maxLagMinutes})` };
}

/**
 * The drill's verdict. `ok` is "no check failed" — a warning is something to read, not something that stops
 * a restore being declared good, because every warning above describes a database that is intact.
 */
export function verifyRestore(inventory: RestoreInventory, expectation: RestoreExpectation): RestoreVerdict {
  // `?? DEFAULT` alone would let `NaN` through — it is not nullish — and a `NaN` limit makes every lag
  // comparison false, so the freshness check would quietly report `pass` whatever the gap. The caller reads
  // its limit off a command line (`--max-lag`), so that is one typo away.
  const asked = expectation.maxLagMinutes;
  const maxLag = typeof asked === "number" && Number.isFinite(asked) && asked >= 0 ? asked : DEFAULT_MAX_LAG_MINUTES;
  const checks = [
    migrationCheck(inventory, expectation.expectedMigrations),
    tableCheck(inventory),
    auditCheck(inventory),
    freshnessCheck(inventory, maxLag),
  ];
  return { ok: !checks.some((c) => c.level === "fail"), checks };
}

/** One line per check, for `npm run restore:drill` and for pasting into the drill record (docs/BACKUPS.md). */
export function formatRestoreReport(verdict: RestoreVerdict, inventory: RestoreInventory): string {
  const rows = verdict.checks.map((c) => `  ${c.name.padEnd(11)} ${c.level.padEnd(5)} ${c.detail}`);
  const counts = RESTORE_TABLES.map((table) => `${table}=${inventory.counts[table] ?? 0}`).join(" ");
  return [`restore: ${verdict.ok ? "ok" : "failed"}`, ...rows, `  rows        ${counts}`].join("\n");
}
