// Unit tests for the visit backfill (T02, design §4.11) against a real fixture database.
//
// Postgres only (§3.2), so the fixture is a throwaway schema in whatever server DATABASE_URL points at:
// created here, migrated with `prisma migrate deploy`, dropped at the end. That is cheap next to a second
// server and it exercises the same migrations the app runs. Without DATABASE_URL the suite skips, so
// `npm test` still works on a laptop with no database up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { migrateVisits, newVisitToken } from "./migrateVisits";

const SERVER_URL = process.env.DATABASE_URL;
const schema = `migratetest_${randomBytes(4).toString("hex")}`;

const fixtureUrl = (base: string) => {
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
};

describe("migrateVisits", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient; // the database as the app sees it, used to create and drop the fixture schema
  let db: PrismaClient; // the fixture schema itself
  let practiceId: string;

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = fixtureUrl(SERVER_URL!);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    } catch (e) {
      // Without this the failure reads "Command failed", which says nothing about which migration broke.
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url });
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    practiceId = practice.id;
    await db.user.create({ data: { practiceId, email: "first@fixture.local", name: "Dr. First", role: "admin" } });
    await db.user.create({ data: { practiceId, email: "later@fixture.local", name: "Dr. Later", role: "clinician" } });
  });

  after(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  it("gives a patient with no visit exactly one, with the patient's own age", async () => {
    const born = new Date("2026-09-20T12:00:00.000Z");
    const patient = await db.patient.create({ data: { practiceId, name: "No Visit Yet", createdAt: born } });

    const report = await migrateVisits(db);
    assert.equal(report.patientsWithoutVisit, 1);
    assert.equal(report.visitsCreated, 1);

    const visits = await db.visit.findMany({ where: { patientId: patient.id } });
    assert.equal(visits.length, 1);
    assert.equal(visits[0].status, "invited");
    assert.equal(visits[0].createdAt.toISOString(), born.toISOString());
    assert.match(visits[0].token, /^[A-Za-z0-9_-]{20,}$/);
  });

  it("attaches the visit to the longest-standing provider in the practice", async () => {
    await db.patient.create({ data: { practiceId, name: "Needs An Owner" } });
    await migrateVisits(db);

    const visit = await db.visit.findFirst({ where: { patient: { name: "Needs An Owner" } }, include: { providerUser: true } });
    assert.equal(visit?.providerUser?.email, "first@fixture.local");
  });

  it("is idempotent: a second run converts nothing", async () => {
    await db.patient.create({ data: { practiceId, name: "Run Twice" } });
    const first = await migrateVisits(db);
    assert.equal(first.visitsCreated, 1);

    const second = await migrateVisits(db);
    assert.deepEqual(second, { patientsWithoutVisit: 0, visitsCreated: 0 });
    assert.equal(await db.visit.count({ where: { patient: { name: "Run Twice" } } }), 1);
  });

  it("leaves a patient that already has a visit alone", async () => {
    const patient = await db.patient.create({
      data: { practiceId, name: "Already Migrated", visits: { create: { token: newVisitToken(), status: "intake_done", notes: "kept" } } },
    });
    await migrateVisits(db);

    const visits = await db.visit.findMany({ where: { patientId: patient.id } });
    assert.equal(visits.length, 1);
    assert.equal(visits[0].status, "intake_done");
    assert.equal(visits[0].notes, "kept");
  });

  it("does not resurrect a deleted patient", async () => {
    const patient = await db.patient.create({ data: { practiceId, name: "Deleted", deletedAt: new Date() } });
    const report = await migrateVisits(db);

    assert.equal(report.visitsCreated, 0);
    assert.equal(await db.visit.count({ where: { patientId: patient.id } }), 0);
  });

  it("reports without writing when asked for a dry run", async () => {
    const patient = await db.patient.create({ data: { practiceId, name: "Dry Run" } });
    const report = await migrateVisits(db, { dryRun: true });

    assert.deepEqual(report, { patientsWithoutVisit: 1, visitsCreated: 0, dryRun: true });
    assert.equal(await db.visit.count({ where: { patientId: patient.id } }), 0);
    await db.patient.delete({ where: { id: patient.id } }); // leave the fixture clean for the tests above
  });
});
