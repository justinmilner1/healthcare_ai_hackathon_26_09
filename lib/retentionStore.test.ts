// Unit tests for the deleting itself (T14, design §2.8, §10.4, §10.5), against a real fixture database.
//
// Postgres only (§3.2), so this follows lib/migrateVisits.test.ts and lib/jobs.test.ts: a throwaway schema in
// whatever server DATABASE_URL points at, migrated with `prisma migrate deploy` and dropped at the end, and a
// skip when there is no DATABASE_URL so `npm test` still works on a laptop with no database up.
//
// The two things the real database is here for are exactly the two a fake would get wrong: what cascades when
// a row goes (an `Upload` taking its `UploadData` with it, a `Visit` taking everything hanging off it), and
// whether running a purge twice is really a no-op.
//
// Storage and the audit log are injected rather than real. Not to make the test easier — to make it *able to
// assert*: the keys a purge asked the backend to remove, and the rows it wrote, are the behaviour §10.5
// promises, and with the live modules both would go to a bucket and a schema this test cannot read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import type { AuditWrite } from "./auditStore";
import { setLogSink } from "./log";
import { DELETED_PATIENT_NAME } from "./retention";
import {
  purgePatient,
  requestPatientDeletion,
  scheduleRetentionSweep,
  sweepRetention,
  sweepStorageOrphans,
  SWEEP_INTERVAL_MS,
} from "./retentionStore";

const SERVER_URL = process.env.DATABASE_URL;
const schema = `retentiontest_${randomBytes(4).toString("hex")}`;

const fixtureUrl = (base: string) => {
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
};

const NOW = new Date("2026-10-14T09:00:00.000Z");
const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * 86_400_000);

describe("retention and deletion", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient; // used only to create and drop the fixture schema
  let db: PrismaClient; // the fixture schema itself
  let practiceId: string;
  let providerId: string;

  /** The keys the purge asked storage to remove, newest call last. */
  let removed: string[];
  /** Prefixes the fake backend refuses, so the orphan path can be tested without breaking a bucket. */
  let refuse: Set<string>;
  let rows: AuditWrite[];

  const deps = () => ({
    client: db,
    now: NOW,
    removePrefix: async (prefix: string) => {
      removed.push(prefix);
      if (refuse.has(prefix)) return { deleted: 0, failed: 1 };
      // One object per upload is what the fixtures below store, so the count is readable in the assertions.
      const count = await db.upload.count({ where: { visitId: prefix.replace(/^visits\//, "").replace(/\/$/, ""), s3Key: { not: null } } });
      return { deleted: count, failed: 0 };
    },
    audit: async (entry: AuditWrite) => {
      rows.push(entry);
    },
  });

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = fixtureUrl(SERVER_URL!);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url });
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    removed = [];
    refuse = new Set();
    rows = [];
    await db.job.deleteMany({});
    await db.auditLog.deleteMany({});
    // No foreign keys on purpose (T70), so nothing cascades this one away with the practice below.
    await db.storageOrphan.deleteMany({});
    await db.patient.deleteMany({});
    await db.user.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology", retentionDays: 365 } });
    practiceId = practice.id;
    const provider = await db.user.create({ data: { practiceId, email: "doctor@fixture.local", name: "Dr. Fixture", role: "admin" } });
    providerId = provider.id;
  });

  /**
   * A patient with one visit carrying a bit of everything §10.4 and §10.5 are about: two uploads with stored
   * objects and parsed rows, a transcript, both summaries, a verified session, a delivery result, a pending
   * Dexcom OAuth state, and the intake and notes on the visit itself.
   */
  async function seedVisit(opts: { name: string; scheduledAt?: Date | null; createdAt?: Date; dexcom?: boolean } ) {
    const patient = await db.patient.create({
      data: { practiceId, name: opts.name, phone: "+14155550101", email: `${opts.name.replace(/\s+/g, ".").toLowerCase()}@example.com` },
    });
    const visit = await db.visit.create({
      data: {
        patientId: patient.id,
        providerUserId: providerId,
        token: randomBytes(8).toString("base64url"),
        scheduledAt: opts.scheduledAt ?? null,
        createdAt: opts.createdAt ?? NOW,
        visitType: "follow_up",
        reason: "mornings running high",
        status: "reviewed",
        notes: "Ate out twice this week.",
        intake: JSON.stringify({ fields: {}, wrapped: true }),
      },
    });
    for (const kind of ["dexcom", "whoop"] as const) {
      await db.upload.create({
        data: {
          visitId: visit.id,
          kind,
          filename: `${kind}.csv`,
          s3Key: `visits/${visit.id}/${kind}/${randomBytes(8).toString("hex")}.csv`,
          bytes: 1024,
          parsedRows: 288,
          data: { create: { parsed: "[]" } },
        },
      });
    }
    await db.message.createMany({
      data: [
        { visitId: visit.id, role: "sweetie", content: "How was your week?" },
        { visitId: visit.id, role: "patient", content: "Mornings were high." },
      ],
    });
    await db.summary.createMany({
      data: [
        { visitId: visit.id, audience: "provider", json: "{}" },
        { visitId: visit.id, audience: "patient", json: "{}" },
      ],
    });
    await db.patientSession.create({
      data: { visitId: visit.id, codeHash: "hash", codeExpiresAt: NOW, expiresAt: NOW, verifiedAt: NOW },
    });
    await db.visitDelivery.create({ data: { visitId: visit.id, channel: "sms", kind: "notify.invite", status: "sent", providerName: "sns" } });
    await db.dexcomOAuthState.create({ data: { stateHash: randomBytes(8).toString("hex"), browserHash: "b", visitId: visit.id, expiresAt: NOW } });
    if (opts.dexcom) {
      await db.dexcomConnection.create({ data: { patientId: patient.id, encryptedTokens: "cipher", expiresAt: NOW } });
    }
    return { patientId: patient.id, visitId: visit.id };
  }

  // -------------------------------------------------------------------------------------------
  // §10.4 The nightly sweep

  describe("sweepRetention", () => {
    it("clears a visit past the practice's window and leaves the row, marked", async () => {
      const { visitId, patientId } = await seedVisit({ name: "Old Visit", scheduledAt: daysAgo(400) });

      const report = await sweepRetention(deps());
      assert.equal(report.visits, 1);
      assert.deepEqual(report.counts, { visits: 0, uploads: 2, turns: 2, summaries: 2, objects: 2, orphans: 0 });

      // What §10.4 deletes: the data. What it leaves: the appointment, and the patient.
      const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
      assert.equal(visit.notes, null);
      assert.equal(visit.intake, null);
      assert.equal(visit.reason, null, "what the patient called about is theirs too");
      assert.equal(visit.retentionSweptAt?.toISOString(), NOW.toISOString());
      assert.equal(visit.status, "reviewed", "the appointment still happened");
      assert.equal(visit.visitType, "follow_up");
      assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).deletedAt, null, "§4.3's patient persists across visits");

      assert.equal(await db.upload.count({ where: { visitId } }), 0);
      assert.equal(await db.uploadData.count({}), 0, "the parsed rows cascade with the upload (§4.6)");
      assert.equal(await db.message.count({ where: { visitId } }), 0);
      assert.equal(await db.summary.count({ where: { visitId } }), 0);
      assert.equal(await db.patientSession.count({ where: { visitId } }), 0, "no way back into a visit with nothing in it");
      assert.equal(await db.visitDelivery.count({ where: { visitId } }), 0);
      assert.equal(await db.dexcomOAuthState.count({ where: { visitId } }), 0);
      assert.deepEqual(removed, [`visits/${visitId}/`], "the bytes go by prefix, not by key (§10.5)");
    });

    it("leaves a visit inside the window completely alone", async () => {
      const { visitId } = await seedVisit({ name: "Recent Visit", scheduledAt: daysAgo(30) });
      const report = await sweepRetention(deps());
      assert.equal(report.visits, 0);
      assert.deepEqual(removed, []);
      const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
      assert.equal(visit.notes, "Ate out twice this week.");
      assert.equal(await db.upload.count({ where: { visitId } }), 2);
      assert.deepEqual(rows, [], "nothing was deleted, so there is nothing to record");
    });

    it("judges a visit with no appointment by its own age", async () => {
      await seedVisit({ name: "No Appointment", scheduledAt: null, createdAt: daysAgo(400) });
      await seedVisit({ name: "Young Row", scheduledAt: null, createdAt: daysAgo(10) });
      assert.equal((await sweepRetention(deps())).visits, 1);
    });

    it("does not touch a visit booked far ahead, however old its row is", async () => {
      // The reason the anchor is the appointment: this row was entered two years ago for next month.
      await seedVisit({ name: "Booked Ahead", scheduledAt: new Date("2026-11-20T10:00:00.000Z"), createdAt: daysAgo(700) });
      assert.equal((await sweepRetention(deps())).visits, 0);
    });

    it("follows the practice's own setting, not the default", async () => {
      await seedVisit({ name: "Ninety Days", scheduledAt: daysAgo(120) });
      assert.equal((await sweepRetention(deps())).visits, 0, "120 days is inside a 365-day window");
      await db.practice.update({ where: { id: practiceId }, data: { retentionDays: 90 } });
      assert.equal((await sweepRetention(deps())).visits, 1, "and outside a 90-day one");
    });

    it("sweeps each practice on its own window and nobody else's", async () => {
      const other = await db.practice.create({ data: { name: "Other Clinic", retentionDays: 30 } });
      const theirs = await db.patient.create({ data: { practiceId: other.id, name: "Their Patient" } });
      const theirVisit = await db.visit.create({
        data: { patientId: theirs.id, token: randomBytes(8).toString("base64url"), scheduledAt: daysAgo(60), notes: "theirs" },
      });
      await seedVisit({ name: "Ours", scheduledAt: daysAgo(60) });

      // Scoped to one practice: the other clinic's 60-day-old visit is past *their* 30 days and stays put.
      const report = await sweepRetention({ ...deps(), practiceId });
      assert.equal(report.practices, 1);
      assert.equal(report.visits, 0, "60 days is inside our 365");
      assert.equal((await db.visit.findUniqueOrThrow({ where: { id: theirVisit.id } })).notes, "theirs");

      // And unscoped, each practice is judged by its own number.
      assert.equal((await sweepRetention(deps())).visits, 1);
      assert.equal((await db.visit.findUniqueOrThrow({ where: { id: theirVisit.id } })).notes, null);
    });

    it("leaves a demo practice's visits alone, however old (§13.4)", async () => {
      // §13.4: a demo practice is excluded from the sweep. The point is a sales demo whose week of readings
      // is still there next month — so the exclusion has to beat the practice's own window, not soften it.
      const { visitId } = await seedVisit({ name: "Demo Visit", scheduledAt: daysAgo(4000) });
      await db.practice.update({ where: { id: practiceId }, data: { isDemo: true, retentionDays: 30 } });

      const report = await sweepRetention(deps());
      assert.equal(report.visits, 0);
      assert.equal(report.practices, 0, "it was not one of the practices considered");
      assert.equal(report.demoPractices, 1, "and the report says why");
      const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
      assert.equal(visit.notes, "Ate out twice this week.");
      assert.equal(visit.retentionSweptAt, null, "not even marked: the next sweep must skip it again");
      assert.equal(await db.upload.count({ where: { visitId } }), 2);
      assert.deepEqual(rows, [], "nothing was deleted, so there is nothing to record (§10.2)");
      assert.deepEqual(removed, []);

      // Unsetting the flag is all it takes: the same sweep then clears the same visit.
      await db.practice.update({ where: { id: practiceId }, data: { isDemo: false } });
      assert.equal((await sweepRetention(deps())).visits, 1);
    });

    it("skips a demo practice it was pointed at by hand too (§13.4)", async () => {
      await seedVisit({ name: "Demo Visit", scheduledAt: daysAgo(400) });
      await db.practice.update({ where: { id: practiceId }, data: { isDemo: true } });
      // Sweeping one practice by name is the runbook's lever (§13.5), and it is not a way round the flag.
      const report = await sweepRetention({ ...deps(), practiceId });
      assert.equal(report.visits, 0);
      assert.equal(report.demoPractices, 1);
    });

    it("sweeps the real practices in a database that also holds a demo one (§13.4)", async () => {
      const demo = await db.practice.create({ data: { name: "Sweet Spot Endocrinology", isDemo: true, retentionDays: 30 } });
      const theirs = await db.patient.create({ data: { practiceId: demo.id, name: "Sam Sample" } });
      const demoVisit = await db.visit.create({
        data: { patientId: theirs.id, token: randomBytes(8).toString("base64url"), scheduledAt: daysAgo(400), notes: "synthetic" },
      });
      await seedVisit({ name: "Real Visit", scheduledAt: daysAgo(400) });

      const report = await sweepRetention(deps());
      assert.equal(report.visits, 1, "one real practice's one old visit");
      assert.equal(report.practices, 1);
      assert.equal(report.demoPractices, 1);
      assert.equal((await db.visit.findUniqueOrThrow({ where: { id: demoVisit.id } })).notes, "synthetic");
    });

    it("records one audit row per cleared visit, with counts and no contents (§4.8, §10.2)", async () => {
      const { visitId } = await seedVisit({ name: "Audited", scheduledAt: daysAgo(400) });
      await sweepRetention(deps());
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        practiceId,
        actorType: "system",
        action: "retention.swept",
        entityType: "visit",
        entityId: visitId,
        detail: { days: 365, uploads: 2, turns: 2, summaries: 2, objects: 2, orphans: 0 },
      });
      assert.equal(JSON.stringify(rows[0]).includes("Audited"), false, "a deletion records its size, never its contents");
    });

    it("runs twice without clearing anything twice, and writes no second row", async () => {
      await seedVisit({ name: "Swept Once", scheduledAt: daysAgo(400) });
      assert.equal((await sweepRetention(deps())).visits, 1);
      rows = [];
      removed = [];
      const again = await sweepRetention(deps());
      assert.equal(again.visits, 0, "retentionSweptAt is what makes the nightly job idempotent");
      assert.deepEqual(rows, []);
      assert.deepEqual(removed, [], "and it does not go back to the object store either");
    });

    it("says how many objects the storage backend would not remove", async () => {
      const { visitId } = await seedVisit({ name: "Orphaned Bytes", scheduledAt: daysAgo(400) });
      refuse.add(`visits/${visitId}/`);
      const report = await sweepRetention(deps());
      // The rows still go: the patient's data is gone from the app either way, and the audit row is what says
      // bytes were left in the bucket.
      assert.equal(report.counts.orphans, 1);
      assert.equal(report.counts.objects, 0);
      assert.equal(await db.upload.count({ where: { visitId } }), 0);
      assert.deepEqual(rows[0].detail, { days: 365, uploads: 2, turns: 2, summaries: 2, objects: 0, orphans: 1 });
    });
  });

  // -------------------------------------------------------------------------------------------
  // §10.5 The staff action

  describe("purgePatient", () => {
    it("deletes a patient end to end: visits, objects, Dexcom tokens, and their identity", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Sam Sample", scheduledAt: daysAgo(10), dexcom: true });

      const result = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(result.found, true);
      assert.equal(result.dexcom, true, "§4.10's encrypted tokens are part of it (§10.5)");
      assert.deepEqual(result.counts, { visits: 1, uploads: 2, turns: 2, summaries: 2, objects: 2, orphans: 0 });

      assert.equal(await db.visit.count({ where: { id: visitId } }), 0, "no patient for the appointment to belong to");
      assert.equal(await db.upload.count({}), 0);
      assert.equal(await db.uploadData.count({}), 0);
      assert.equal(await db.message.count({}), 0);
      assert.equal(await db.summary.count({}), 0);
      assert.equal(await db.patientSession.count({}), 0);
      assert.equal(await db.dexcomConnection.count({}), 0);
      assert.deepEqual(removed, [`visits/${visitId}/`]);

      // What is left is a row that no longer identifies anybody, which is what the audit record points at.
      const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
      assert.equal(patient.name, DELETED_PATIENT_NAME);
      assert.equal(patient.phone, null);
      assert.equal(patient.email, null);
      assert.equal(patient.deletedAt?.toISOString(), NOW.toISOString());
    });

    it("deletes every visit the patient had, not just the newest", async () => {
      const { patientId } = await seedVisit({ name: "Repeat Patient", scheduledAt: daysAgo(400) });
      // A second visit for the same person, the way §2.2 reuses a patient.
      const second = await db.visit.create({
        data: { patientId, token: randomBytes(8).toString("base64url"), scheduledAt: daysAgo(5), notes: "second visit" },
      });
      await db.message.create({ data: { visitId: second.id, role: "patient", content: "still high" } });

      const result = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(result.counts.visits, 2);
      assert.equal(result.counts.turns, 3);
      assert.equal(await db.visit.count({ where: { patientId } }), 0);
      assert.equal(removed.length, 2, "each visit's objects are their own prefix");
    });

    it("records the deletion against the person who asked for it (§10.2)", async () => {
      const { patientId } = await seedVisit({ name: "On Request", scheduledAt: daysAgo(10), dexcom: true });
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        practiceId,
        actorType: "user",
        actorId: providerId,
        action: "patient.deleted",
        entityType: "patient",
        entityId: patientId,
        detail: { visits: 1, uploads: 2, turns: 2, summaries: 2, objects: 2, orphans: 0, dexcom: true },
      });
      assert.equal(JSON.stringify(rows[0]).includes("On Request"), false);
    });

    it("records it against the job when nobody pressed anything (§13.5)", async () => {
      const { patientId } = await seedVisit({ name: "From The Runbook", scheduledAt: daysAgo(10) });
      await purgePatient({ ...deps(), patientId });
      assert.equal(rows[0].actorType, "system");
      assert.equal(rows[0].actorId ?? null, null);
    });

    it("is safe to run twice: the second time removes nothing and records nothing", async () => {
      const { patientId } = await seedVisit({ name: "Twice Over", scheduledAt: daysAgo(10), dexcom: true });
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      rows = [];
      removed = [];

      const again = await purgePatient({ ...deps(), patientId, requestedBy: providerId, now: new Date("2026-10-15T09:00:00.000Z") });
      assert.equal(again.found, true);
      assert.equal(again.dexcom, false);
      assert.deepEqual(again.counts, { visits: 0, uploads: 0, turns: 0, summaries: 0, objects: 0, orphans: 0 });
      assert.deepEqual(rows, [], "a retry that finds the work done is not a second deletion");
      assert.deepEqual(removed, [], "no visits left, so no prefixes to ask about");
      // And the first deletion's own timestamp is not moved by the retry.
      assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).deletedAt?.toISOString(), NOW.toISOString());
    });

    it("finishes a purge whose first attempt died half way, which is why the bytes go by prefix", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Half Done", scheduledAt: daysAgo(10) });
      // What a crashed first attempt leaves: the rows that said where the objects were, gone; the objects not.
      await db.upload.deleteMany({ where: { visitId } });
      const result = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.deepEqual(removed, [`visits/${visitId}/`], "the prefix is asked for even with no row to name a key");
      assert.equal(result.counts.visits, 1);
      assert.equal(await db.visit.count({ where: { patientId } }), 0);
    });

    it("says so rather than throwing when there is no such patient", async () => {
      const result = await purgePatient({ ...deps(), patientId: "nobody", requestedBy: providerId });
      assert.deepEqual(result, { counts: { visits: 0, uploads: 0, turns: 0, summaries: 0, objects: 0, orphans: 0 }, dexcom: false, found: false });
      assert.deepEqual(rows, []);
    });
  });

  // -------------------------------------------------------------------------------------------
  // §10.5 The prefixes the object store would not empty (T70)

  describe("the orphan ledger", () => {
    it("writes a refused prefix down, and a second purge of the same patient asks the bucket again", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Refused Bytes", scheduledAt: daysAgo(10) });
      const prefix = `visits/${visitId}/`;
      refuse.add(prefix);

      const first = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(first.counts.orphans, 1);
      assert.equal(first.counts.objects, 0);
      assert.equal(await db.visit.count({ where: { patientId } }), 0, "the rows go either way");
      // The prefix is derived from a visit id that no longer exists, so this row is the only thing that
      // still knows it. That is the bug: before T70 nothing wrote it down.
      const row = await db.storageOrphan.findUniqueOrThrow({ where: { prefix } });
      assert.equal(row.patientId, patientId);
      assert.equal(row.practiceId, practiceId);
      assert.equal(row.objects, 1);
      assert.equal(row.attempts, 1);

      // Staff press *Delete data* again. `patient.visits` is empty by now; the ledger is what it walks.
      removed = [];
      const second = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.deepEqual(removed, [prefix], "a second deletion reaches the object store, with no Visit rows left");
      assert.equal(second.counts.orphans, 1, "still refused, so still outstanding");
      assert.equal((await db.storageOrphan.findUniqueOrThrow({ where: { prefix } })).attempts, 2);

      // And once the backend accepts it, the ledger is empty and the deletion is finished.
      refuse.delete(prefix);
      removed = [];
      const third = await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.deepEqual(removed, [prefix]);
      assert.equal(third.counts.orphans, 0);
      assert.equal(third.counts.objects, 0, "the fixture's uploads are long gone; the prefix is simply empty now");
      assert.equal(await db.storageOrphan.count({}), 0, "a prefix that came back empty leaves the ledger");
    });

    it("records an unfinished deletion on the trail every time, so /provider/audit can show it", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Unfinished", scheduledAt: daysAgo(10) });
      refuse.add(`visits/${visitId}/`);
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, "patient.deleted");
      assert.deepEqual(rows[0].detail, { visits: 1, uploads: 2, turns: 2, summaries: 2, objects: 0, orphans: 1, dexcom: false });

      // The second attempt removes nothing and would once have been silent — property 3 reads a run that
      // removed nothing as nothing happening. A deletion the bucket refused is not nothing.
      rows = [];
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.equal(rows.length, 1, "an attempt that left bytes outstanding is still on the trail");
      assert.deepEqual(rows[0].detail, { visits: 0, uploads: 0, turns: 0, summaries: 0, objects: 0, orphans: 1, dexcom: false });
    });

    it("asks about each prefix once per run: the ledger pass skips what the purge has just tried", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Once Per Run", scheduledAt: daysAgo(10) });
      refuse.add(`visits/${visitId}/`);
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      assert.deepEqual(removed, [`visits/${visitId}/`], "the visit walk tried it; the ledger pass did not try it again");
    });

    it("comes back to it on the nightly sweep, and records what it removed (§10.2)", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Nightly Retry", scheduledAt: daysAgo(10) });
      const prefix = `visits/${visitId}/`;
      refuse.add(prefix);
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      rows = [];
      removed = [];

      // Nothing is left for the sweep to clear — the patient's visits are gone — but the prefix is on the
      // ledger, and this is the one nightly clock the app has. The backend takes it this time, and the two
      // objects it reports are the ones it refused before: the `Upload` rows that named them went with the
      // first purge, which is why the pass goes by prefix.
      const report = await sweepRetention({
        ...deps(),
        removePrefix: async (asked: string) => {
          removed.push(asked);
          return { deleted: 2, failed: 0 };
        },
      });
      assert.equal(report.visits, 0);
      assert.deepEqual(removed, [prefix]);
      assert.deepEqual(report.orphans, { prefixes: 1, objects: 2, orphans: 0, cleared: 1 });
      assert.equal(await db.storageOrphan.count({}), 0);
      assert.deepEqual(rows, [
        {
          practiceId,
          actorType: "system",
          action: "storage.orphans_purged",
          entityType: "practice",
          entityId: practiceId,
          detail: { prefixes: 1, objects: 2, orphans: 0 },
        },
      ]);
    });

    it("writes no row for a prefix that was already empty by the time the pass reached it", async () => {
      const { patientId, visitId } = await seedVisit({ name: "Cleaned By Hand", scheduledAt: daysAgo(10) });
      refuse.add(`visits/${visitId}/`);
      await purgePatient({ ...deps(), patientId, requestedBy: providerId });
      rows = [];
      // An operator removed the prefix with the runbook's commands, so the backend has nothing to report.
      refuse.delete(`visits/${visitId}/`);
      const pass = await sweepStorageOrphans(deps());
      assert.deepEqual(pass, { prefixes: 1, objects: 0, orphans: 0, cleared: 1 });
      assert.equal(await db.storageOrphan.count({}), 0, "the ledger is still cleared");
      assert.deepEqual(rows, [], "but nothing was deleted, so there is no deletion to record");
    });

    it("keeps a sweep's own refusal too, because retentionSweptAt stops the visit being considered again", async () => {
      const { visitId } = await seedVisit({ name: "Swept And Refused", scheduledAt: daysAgo(400) });
      const prefix = `visits/${visitId}/`;
      refuse.add(prefix);
      await sweepRetention(deps());
      const row = await db.storageOrphan.findUniqueOrThrow({ where: { prefix } });
      assert.equal(row.patientId, null, "nobody is being deleted: the Visit row stays (§10.4)");
      assert.equal(row.practiceId, practiceId);

      // The next night is what comes back to it, now that the backend will take it.
      refuse.delete(prefix);
      removed = [];
      const report = await sweepRetention(deps());
      assert.equal(report.visits, 0, "retentionSweptAt still holds");
      assert.deepEqual(removed, [prefix], "and the bytes are chased anyway");
      assert.equal(await db.storageOrphan.count({}), 0);
    });

    it("says nothing on a pass that chased a prefix and still could not empty it", async () => {
      const { visitId } = await seedVisit({ name: "Still Refused", scheduledAt: daysAgo(400) });
      refuse.add(`visits/${visitId}/`);
      await sweepRetention(deps());
      rows = [];
      const pass = await sweepStorageOrphans(deps());
      assert.equal(pass.prefixes, 1);
      assert.equal(pass.orphans, 1);
      assert.equal(pass.cleared, 0);
      assert.deepEqual(rows, [], "a pass that removed nothing is not a deletion (property 3)");
      assert.equal((await db.storageOrphan.findUniqueOrThrow({ where: { prefix: `visits/${visitId}/` } })).attempts, 2);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The staff action's two steps, and who asks for the sweep

  describe("requestPatientDeletion", () => {
    it("closes the patient now and queues the purge as a job (§3.4)", async () => {
      const { patientId } = await seedVisit({ name: "Queued Deletion", scheduledAt: daysAgo(10) });

      const { jobId, deduped } = await requestPatientDeletion({ patientId, requestedBy: providerId, client: db, jobs: db, now: NOW });
      assert.equal(deduped, false);
      // Marked at once, so nothing books a new visit onto them while the job waits (lib/visitStore.ts).
      assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).deletedAt?.toISOString(), NOW.toISOString());
      const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      assert.equal(job.kind, "patient.delete");
      assert.equal(job.status, "queued");
      assert.deepEqual(JSON.parse(job.payload), { patientId, requestedBy: providerId });
      assert.equal(job.idempotencyKey, `patient.delete:${patientId}`);
      // §10.3: the row outlives the request, so nothing in the payload may be a name or a contact detail.
      assert.equal(job.payload.includes("Queued Deletion"), false);
    });

    it("collapses a double-pressed button onto one job", async () => {
      const { patientId } = await seedVisit({ name: "Double Pressed", scheduledAt: daysAgo(10) });
      const first = await requestPatientDeletion({ patientId, requestedBy: providerId, client: db, jobs: db, now: NOW });
      const second = await requestPatientDeletion({ patientId, requestedBy: providerId, client: db, jobs: db, now: NOW });
      assert.equal(second.deduped, true);
      assert.equal(second.jobId, first.jobId);
      assert.equal(await db.job.count({ where: { kind: "patient.delete" } }), 1);
    });

    it("can be asked again once the first job has finished, because a failed one has to be retryable", async () => {
      const { patientId } = await seedVisit({ name: "Asked Again", scheduledAt: daysAgo(10) });
      const first = await requestPatientDeletion({ patientId, requestedBy: providerId, client: db, jobs: db, now: NOW });
      // The key is released when a job reaches done or failed (lib/jobs.ts), which is the state staff see.
      await db.job.update({ where: { id: first.jobId }, data: { status: "failed", idempotencyKey: null, lastError: "Error: storage unreachable" } });
      const later = new Date(NOW.getTime() + 3_600_000);
      const second = await requestPatientDeletion({ patientId, requestedBy: providerId, client: db, jobs: db, now: later });
      assert.equal(second.deduped, false);
      assert.notEqual(second.jobId, first.jobId);
      // And the second ask does not move the date the first one recorded: it is the same request, retried.
      assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).deletedAt?.toISOString(), NOW.toISOString());
    });
  });

  describe("scheduleRetentionSweep", () => {
    it("queues one sweep and then nothing for the rest of the day", async () => {
      const queued = await scheduleRetentionSweep(db, NOW);
      assert.ok(queued, "the first tick of the day queues the sweep");
      // The guard below reads the row's own `createdAt`, which the database stamps with the wall clock; this
      // test's clock is NOW, so the row is dated to match rather than to whenever the suite happens to run.
      const job = await db.job.update({ where: { id: queued!.jobId }, data: { createdAt: NOW } });
      assert.equal(job.kind, "retention.sweep");
      assert.deepEqual(JSON.parse(job.payload), {}, "no visit, no patient: the sweep is about every practice");

      // A minute-by-minute runner asks again and again; §10.4 wants it nightly.
      assert.equal(await scheduleRetentionSweep(db, new Date(NOW.getTime() + 60_000)), null);
      assert.equal(await scheduleRetentionSweep(db, new Date(NOW.getTime() + SWEEP_INTERVAL_MS - 1000)), null);
      assert.equal(await db.job.count({ where: { kind: "retention.sweep" } }), 1);
    });

    it("queues the next one once the window has passed, even though the last job is long finished", async () => {
      const first = await scheduleRetentionSweep(db, NOW);
      // The guard is the job's creation time and not its idempotency key, which is released seconds later.
      await db.job.update({ where: { id: first!.jobId }, data: { status: "done", idempotencyKey: null, createdAt: NOW } });
      assert.equal(await scheduleRetentionSweep(db, new Date(NOW.getTime() + 60_000)), null);
      const next = await scheduleRetentionSweep(db, new Date(NOW.getTime() + SWEEP_INTERVAL_MS + 1000));
      assert.ok(next);
      assert.equal(await db.job.count({ where: { kind: "retention.sweep" } }), 2);
    });
  });
});
