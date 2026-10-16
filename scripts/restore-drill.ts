// npm run restore:drill — the verification step of the §11.4 restore drill. Owner: ops.
//
// docs/BACKUPS.md is the drill: restore the backup to a new instance, point this at it, read the verdict,
// then throw the instance away. This script is only the middle step, and it is a step rather than a glance
// because a point-in-time restore always succeeds — RDS hands back an instance that accepts connections
// whatever is in it. lib/restore.ts says what "whatever is in it" has to look like.
//
//   npm run restore:drill -- --url "postgresql://sweetspot:...@<restored-endpoint>:5432/sweetspot?sslmode=require"
//   npm run restore:drill -- --url "..." --restored-to 2026-10-15T09:00:00Z
//   npm run restore:drill                 against DATABASE_URL — a rehearsal against the local database
//
// `--restored-to` is the `LatestRestorableTime` the restore was given. Without it the drill still checks the
// schema and the contents; with it, it also checks that what came back is dated like the point in time that
// was asked for, which is the failure mode worth the most (docs/BACKUPS.md, "if it goes wrong").
//
// Read-only: it counts rows and reads `_prisma_migrations`. Nothing here writes to the instance it is
// pointed at, so running it against production by mistake costs a few queries and nothing else.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { formatRestoreReport, type RestoreInventory, type RestoreTable, verifyRestore } from "../lib/restore";

loadEnv();

/** `--url x` / `--url=x`, with a default. Same shape as scripts/health-check.ts. */
function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

/** The host and database, never the password. The drill's output is pasted into a record (docs/BACKUPS.md),
 *  and the credential of a restored instance is the credential of the production one it came from. */
function describe(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** The migrations this checkout expects, oldest first — the directory names Prisma records. */
function expectedMigrations(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function inventoryOf(db: PrismaClient, restoredTo: Date | null): Promise<RestoreInventory> {
  // Prisma's own bookkeeping table has no model, so it is the one raw query here. `finished_at` is null for a
  // migration that started and failed, which is exactly a migration that is not applied.
  const rows = await db.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name ASC
  `;
  const [practice, user, patient, visit, auditLog, summary, upload] = await Promise.all([
    db.practice.count(),
    db.user.count(),
    db.patient.count(),
    db.visit.count(),
    db.auditLog.count(),
    db.summary.count(),
    db.upload.count(),
  ]);
  const newest = await db.auditLog.findFirst({ orderBy: { at: "desc" }, select: { at: true } });
  const counts: Record<RestoreTable, number> = { Practice: practice, User: user, Patient: patient, Visit: visit, AuditLog: auditLog, Summary: summary, Upload: upload };
  return { appliedMigrations: rows.map((r) => r.migration_name), counts, newestAuditAt: newest?.at ?? null, restoredTo };
}

async function main(): Promise<number> {
  const url = arg("url", process.env.RESTORE_DATABASE_URL ?? process.env.DATABASE_URL ?? "");
  if (!url) {
    console.error("restore drill: no database. Pass --url, or set RESTORE_DATABASE_URL or DATABASE_URL.");
    return 1;
  }
  const target = arg("restored-to", "");
  const restoredTo = target ? new Date(target) : null;
  if (restoredTo && Number.isNaN(restoredTo.getTime())) {
    console.error(`restore drill: --restored-to ${target} is not a date. Use the ISO timestamp RDS prints as LatestRestorableTime.`);
    return 1;
  }
  const lagArg = arg("max-lag", "60");
  const maxLagMinutes = Number(lagArg);
  // Same refusal as --restored-to above, and for the same reason: a limit that is not a number would make
  // every freshness comparison meaningless, and a drill tool that ignores its own argument is the quiet
  // failure this script exists to catch. lib/restore.ts falls back to 60 if one reaches it anyway.
  if (!Number.isFinite(maxLagMinutes) || maxLagMinutes < 0) {
    console.error(`restore drill: --max-lag ${lagArg} is not a number of minutes.`);
    return 1;
  }

  console.log(`restore drill: ${describe(url)}`);
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const inventory = await inventoryOf(db, restoredTo);
    const verdict = verifyRestore(inventory, { expectedMigrations: expectedMigrations(), maxLagMinutes });
    console.log(formatRestoreReport(verdict, inventory));
    return verdict.ok ? 0 : 1;
  } finally {
    await db.$disconnect();
  }
}

// main() rather than top-level await, for the reason scripts/health-check.ts gives.
main()
  .catch((e) => {
    // A connection that never opened is the commonest way this ends: the wrong endpoint, a security group
    // that does not know the operator's address, or an instance still in `creating`.
    console.error(e instanceof Error ? `restore drill: ${e.message}` : e);
    return 1;
  })
  .then((code) => process.exit(code));
