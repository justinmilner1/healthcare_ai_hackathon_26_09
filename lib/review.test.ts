// Unit tests for the sign-off (T16, design §2.6, §7.3, §4.4, §4.7).
//
// Two halves, the same split as lib/consent.test.ts. The pure half checks how a reviewer is named, including
// the account that is no longer there. The second drives the real write through a throwaway schema on
// whatever server DATABASE_URL points at, and skips when there is none — because every rule §7.3 has is a
// rule about what the database already holds (the first sign-off wins, there has to be a summary, a
// cancelled visit is not reviewable), and none of them can be asserted against a stub.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { FORMER_COLLEAGUE, markReviewed, REVIEWABLE_FROM, reviewRecord, reviewerLabel, reviewerNames } from "./review";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const LATER = new Date("2026-10-14T16:45:00.000Z");

describe("reviewerLabel: who signed it off, in words", () => {
  it("prefers the name the clinician gave", () => {
    assert.equal(reviewerLabel({ name: "Dr. Rivera", email: "rivera@example-endo.com" }), "Dr. Rivera");
  });

  it("falls back to the address, which every provider has from the magic link (§5.1)", () => {
    for (const name of [null, undefined, "", "   "]) {
      assert.equal(reviewerLabel({ name, email: "rivera@example-endo.com" }), "rivera@example-endo.com");
    }
  });

  it("names a departed account rather than printing a blank: the record outlives the user", () => {
    assert.equal(reviewerLabel(null), FORMER_COLLEAGUE);
    assert.equal(reviewerLabel(undefined), FORMER_COLLEAGUE);
    assert.equal(reviewerLabel({ name: null, email: null }), FORMER_COLLEAGUE);
  });
});

describe("REVIEWABLE_FROM: the statuses a sign-off may move a visit out of (§4.4)", () => {
  it("is every stage before `reviewed`, and never `reviewed` or `cancelled`", () => {
    assert.deepEqual([...REVIEWABLE_FROM], ["invited", "verified", "in_intake", "intake_done", "summary_ready"]);
    assert.ok(!REVIEWABLE_FROM.includes("reviewed" as never), "a second sign-off must not overwrite the first");
    assert.ok(!REVIEWABLE_FROM.includes("cancelled" as never), "a cancelled visit is outside the lifecycle");
  });
});

// ---------------------------------------------------------------------------------------------
// The write itself, against Postgres

const SERVER_URL = process.env.DATABASE_URL;
const schema = `rvtest_${randomBytes(4).toString("hex")}`;

describe("markReviewed against the database", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let visitId: string;
  let clinician: { id: string; name: string | null; email: string };
  let colleague: { id: string; name: string | null; email: string };

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(SERVER_URL!);
    url.searchParams.set("schema", schema);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: "pipe" });
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url.toString() });
  });

  after(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await db.summary.deleteMany({});
    await db.visit.deleteMany({});
    await db.patient.deleteMany({});
    await db.user.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    clinician = await db.user.create({ data: { practiceId: practice.id, email: "rivera@example-endo.com", name: "Dr. Rivera", role: "clinician" } });
    colleague = await db.user.create({ data: { practiceId: practice.id, email: "okafor@example-endo.com", name: "Dr. Okafor", role: "clinician" } });
    const visit = await db.visit.create({
      data: {
        token: randomBytes(8).toString("base64url"),
        status: "summary_ready",
        patient: { create: { practiceId: practice.id, name: "Fixture Patient", email: "fixture@example.test" } },
      },
    });
    visitId = visit.id;
  });

  const read = () => db.visit.findUniqueOrThrow({ where: { id: visitId } });
  const current = () => db.visit.findUniqueOrThrow({ where: { id: visitId }, select: { id: true, status: true } });
  const addSummaries = () =>
    db.summary.createMany({
      data: [
        { visitId, audience: "provider", json: "{}", inputHash: "h1" },
        { visitId, audience: "patient", json: "{}", inputHash: "h1" },
      ],
    });

  it("records the reviewer and the time and moves the visit to `reviewed` (§7.3, §4.4)", async () => {
    await addSummaries();
    const outcome = await markReviewed(await current(), clinician, NOW, db);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.already, false);
    assert.deepEqual(outcome.ok && outcome.record, { at: NOW.toISOString(), by: clinician.id, byName: "Dr. Rivera" });

    const visit = await read();
    assert.equal(visit.status, "reviewed");
    assert.equal(visit.reviewedBy, clinician.id);
    assert.deepEqual(visit.reviewedAt, NOW);
  });

  it("stamps the same pair on the summaries the sign-off covers (§4.7)", async () => {
    await addSummaries();
    await markReviewed(await current(), clinician, NOW, db);
    const summaries = await db.summary.findMany({ where: { visitId }, orderBy: { audience: "asc" } });
    assert.equal(summaries.length, 2);
    for (const summary of summaries) {
      assert.equal(summary.reviewedBy, clinician.id, `${summary.audience} summary`);
      assert.deepEqual(summary.reviewedAt, NOW, `${summary.audience} summary`);
    }
  });

  it("keeps the first sign-off: a second press returns the record that stands", async () => {
    await addSummaries();
    await markReviewed(await current(), clinician, NOW, db);
    const second = await markReviewed(await current(), colleague, LATER, db);
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.already, true);
    assert.deepEqual(second.ok && second.record, { at: NOW.toISOString(), by: clinician.id, byName: "Dr. Rivera" });

    const visit = await read();
    assert.equal(visit.reviewedBy, clinician.id, "the second clinician must not take the first one's place");
    assert.deepEqual(visit.reviewedAt, NOW);
  });

  it("refuses a visit with no summary: nothing is reviewed before there is something to review", async () => {
    const outcome = await markReviewed(await current(), clinician, NOW, db);
    assert.deepEqual(outcome, { ok: false, reason: "no_summary" });
    const visit = await read();
    assert.equal(visit.status, "summary_ready");
    assert.equal(visit.reviewedAt, null);
  });

  it("refuses a cancelled visit, which §4.4 puts outside the lifecycle", async () => {
    await addSummaries();
    await db.visit.update({ where: { id: visitId }, data: { status: "cancelled" } });
    const outcome = await markReviewed(await current(), clinician, NOW, db);
    assert.deepEqual(outcome, { ok: false, reason: "cancelled" });
    const visit = await read();
    assert.equal(visit.status, "cancelled");
    assert.equal(visit.reviewedAt, null);
  });

  it("signs off a visit that is still mid-intake, which is the clinician's call and not the status's", async () => {
    // A clinician who has read what there is may sign it off before the patient finishes: §7.3 puts no
    // condition on the stage, only on there being a summary.
    await addSummaries();
    await db.visit.update({ where: { id: visitId }, data: { status: "in_intake" } });
    const outcome = await markReviewed(await current(), clinician, NOW, db);
    assert.equal(outcome.ok, true);
    assert.equal((await read()).status, "reviewed");
  });

  it("reviewRecord reads back null, then the sign-off with the reviewer's name joined on", async () => {
    assert.equal(await reviewRecord(await read(), db), null);
    await addSummaries();
    await markReviewed(await current(), clinician, NOW, db);
    assert.deepEqual(await reviewRecord(await read(), db), { at: NOW.toISOString(), by: clinician.id, byName: "Dr. Rivera" });
  });

  it("reviewRecord names a reviewer whose account has since gone", async () => {
    await addSummaries();
    await markReviewed(await current(), clinician, NOW, db);
    await db.user.delete({ where: { id: clinician.id } });
    const record = await reviewRecord(await read(), db);
    assert.equal(record?.byName, FORMER_COLLEAGUE);
    assert.equal(record?.at, NOW.toISOString(), "the sign-off itself is untouched");
  });

  it("reviewerNames answers for a whole list in one query, blanks and all", async () => {
    assert.deepEqual(await reviewerNames([], db), {});
    assert.deepEqual(await reviewerNames([null, null], db), {});
    assert.deepEqual(await reviewerNames([clinician.id, colleague.id, clinician.id, null], db), {
      [clinician.id]: "Dr. Rivera",
      [colleague.id]: "Dr. Okafor",
    });
    assert.deepEqual(await reviewerNames(["user-that-never-existed"], db), { "user-that-never-existed": FORMER_COLLEAGUE });
  });
});
