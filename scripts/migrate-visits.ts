// npm run migrate:visits [-- --dry-run]
// The one-time conversion to the visit model (design §4.11). The migration in prisma/migrations does the
// bulk of it; this picks up any patient that reached the new schema without a visit. See lib/migrateVisits.ts.
// Safe to re-run: a patient that already has a visit is left alone.

import { db } from "../lib/db";
import { migrateVisits } from "../lib/migrateVisits";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const report = await migrateVisits(db, { dryRun });
  if (report.patientsWithoutVisit === 0) {
    console.log("Nothing to migrate: every patient already has a visit.");
    return;
  }
  console.log(
    dryRun
      ? `${report.patientsWithoutVisit} patient(s) without a visit. Re-run without --dry-run to create one each.`
      : `${report.visitsCreated} visit(s) created for ${report.patientsWithoutVisit} patient(s) without one.`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
