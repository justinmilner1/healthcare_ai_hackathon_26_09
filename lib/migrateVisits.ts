// The one-time conversion to the visit-centric model (design §4.11). Run by scripts/migrate-visits.ts.
//
// The bulk of the move is SQL, in prisma/migrations/20261010223000_visit_model: `prisma migrate deploy`
// cannot pause for a script, so the migration itself turns each hackathon patient row into a patient plus
// one visit carrying its token, appointment and intake. What is left for a script is the backfill — a
// patient row that reaches the new schema without a visit, which is what happens when the old code writes
// one while the deploy is in flight, or when a patient is restored from a pre-migration backup. Such a
// patient is invisible in the app: every page is reached through a visit token.
//
// Idempotent on purpose. Running it twice converts nothing the second time, so it is safe to run after
// every deploy and from a cron while the old code is still being drained.

import { randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";

/** Just the delegates this needs, so a test can hand it a client pointed at a fixture database. */
export type VisitMigrationClient = Pick<PrismaClient, "patient" | "visit" | "user">;

export type MigrationReport = {
  /** Live patients with no visit at all: the rows this script exists for. */
  patientsWithoutVisit: number;
  visitsCreated: number;
  /** Set when nothing was written because the caller asked for a dry run. */
  dryRun?: true;
};

/** Same shape of token as an invite from /api/book, so the link behaves identically. */
export const newVisitToken = () => randomBytes(16).toString("base64url");

/**
 * Give every patient that has no visit exactly one (§4.11). A soft-deleted patient is left alone: a
 * deletion is not undone by a migration.
 */
export async function migrateVisits(db: VisitMigrationClient, opts: { dryRun?: boolean } = {}): Promise<MigrationReport> {
  const orphans = await db.patient.findMany({
    where: { visits: { none: {} }, deletedAt: null },
    select: { id: true, practiceId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (opts.dryRun) return { patientsWithoutVisit: orphans.length, visitsCreated: 0, dryRun: true };

  let visitsCreated = 0;
  for (const patient of orphans) {
    // Whoever has run the practice longest owns the visit until staff reassign it (§5.2).
    const provider = await db.user.findFirst({
      where: { practiceId: patient.practiceId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    await db.visit.create({
      data: {
        patientId: patient.id,
        providerUserId: provider?.id ?? null,
        token: newVisitToken(),
        status: "invited",
        // The visit stands in for the patient's original row, so it keeps that row's age and sorts with it.
        createdAt: patient.createdAt,
      },
    });
    visitsCreated += 1;
  }
  return { patientsWithoutVisit: orphans.length, visitsCreated };
}
