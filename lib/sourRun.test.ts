// Unit tests for Sour's "unchanged inputs return the existing summary" rule (T15, design §7.1), against a
// real fixture database.
//
// The hash itself is lib/sourInput.test.ts. This is the lookup around it: which saved pair counts as the
// answer to a fresh run, and — just as important — which ones must not, because handing a clinician a
// summary that does not describe this week is worse than spending two model calls.
//
// Postgres only (§3.2), so the fixture is a throwaway schema in whatever server DATABASE_URL points at,
// migrated with `prisma migrate deploy` and dropped at the end, exactly like lib/jobs.test.ts. Without
// DATABASE_URL the suite skips, so `npm test` still works with no database up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { sourInputHash, sourInputsFor } from "./sourInput";
import { existingSummaryFor, uploadRefs } from "./sourRun";
import type { Summary } from "./types";

const SERVER_URL = process.env.DATABASE_URL;
const schema = `sourruntest_${randomBytes(4).toString("hex")}`;

const fixtureUrl = (base: string) => {
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
};

const summary = (patterns: string[]): Summary => ({
  timeInRange: 0.72,
  avgGlucose: 148,
  spikes: [],
  patterns,
  questions: ["What changed in August?"],
  patientNotes: "Meals: pasta most nights",
});

describe("existingSummaryFor", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let visitId: string;
  let otherVisitId: string;

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
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient" } });
    const visit = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(16).toString("base64url"), visitType: "follow_up", reason: "mornings running high", notes: "Meals: pasta most nights", intake: JSON.stringify({ turns: 2, wrapped: true }) } });
    const other = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(16).toString("base64url") } });
    visitId = visit.id;
    otherVisitId = other.id;
  });

  after(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await db.summary.deleteMany({});
    await db.upload.deleteMany({});
  });

  /** One run's worth of rows: the pair Sour saves, with the fingerprint it saved them under. */
  const savePair = async (inputHash: string | null, patterns = ["3 of 4 overnight highs followed dinners out after 8pm"], id = visitId) => {
    for (const audience of ["provider", "patient"]) {
      await db.summary.create({ data: { visitId: id, audience, json: JSON.stringify(summary(patterns)), inputHash } });
      // Distinct createdAt values, so "the newest row per audience" is a question with one answer.
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  it("finds nothing before Sour has ever run", async () => {
    assert.equal(await existingSummaryFor(visitId, "a".repeat(64), db), null);
  });

  it("returns the saved pair when the inputs are the ones it was generated from", async () => {
    await savePair("hash-week-1");
    const found = await existingSummaryFor(visitId, "hash-week-1", db);
    assert.ok(found, "unchanged inputs must not cost two more model calls (§7.1)");
    assert.deepEqual(found.provider.patterns, ["3 of 4 overnight highs followed dinners out after 8pm"]);
    assert.deepEqual(found.patient.patterns, ["3 of 4 overnight highs followed dinners out after 8pm"]);
    assert.equal(found.summaryIds.length, 2);
  });

  it("regenerates once the patient has added something", async () => {
    await savePair("hash-week-1");
    assert.equal(await existingSummaryFor(visitId, "hash-week-2", db), null);
  });

  it("never reuses a placeholder from a run the gateway was down for", async () => {
    // lib/sourRun.ts stores a null fingerprint in that case precisely so the retry really retries.
    await savePair(null, ["Model gateway unavailable: …"]);
    assert.equal(await existingSummaryFor(visitId, "hash-week-1", db), null);
  });

  it("will not answer with half a pair", async () => {
    // notify.summary sends a link to the clinician and one to the patient; one summary is not a run.
    await db.summary.create({ data: { visitId, audience: "provider", json: JSON.stringify(summary(["only half"])), inputHash: "hash-week-1" } });
    assert.equal(await existingSummaryFor(visitId, "hash-week-1", db), null);
  });

  it("prefers the newest pair, so it never returns one the page is not showing", async () => {
    // Inputs went week-1 -> week-2. A later run back on week-1's fingerprint must not hand back the older
    // narrative while the page renders the newest row per audience.
    await savePair("hash-week-1", ["older narrative"]);
    await savePair("hash-week-2", ["newer narrative"]);
    assert.equal(await existingSummaryFor(visitId, "hash-week-1", db), null);
    const found = await existingSummaryFor(visitId, "hash-week-2", db);
    assert.deepEqual(found?.provider.patterns, ["newer narrative"]);
  });

  it("ignores another visit's summaries", async () => {
    await savePair("hash-week-1", ["someone else's week"], otherVisitId);
    assert.equal(await existingSummaryFor(visitId, "hash-week-1", db), null);
  });

  it("treats an empty fingerprint as no answer rather than matching every null row", async () => {
    await savePair(null);
    assert.equal(await existingSummaryFor(visitId, "", db), null);
  });

  it("regenerates rather than throwing when a saved row cannot be read", async () => {
    await db.summary.create({ data: { visitId, audience: "provider", json: "{not json", inputHash: "hash-week-1" } });
    await db.summary.create({ data: { visitId, audience: "patient", json: "{not json", inputHash: "hash-week-1" } });
    assert.equal(await existingSummaryFor(visitId, "hash-week-1", db), null);
  });

  describe("uploadRefs", () => {
    it("reads only this visit's uploads, and only the three columns the fingerprint uses", async () => {
      await db.upload.create({ data: { visitId, kind: "dexcom", filename: "clarity.csv", bytes: 1200, parsedRows: 2016 } });
      await db.upload.create({ data: { visitId: otherVisitId, kind: "dexcom", filename: "other.csv", bytes: 10, parsedRows: 3 } });
      const refs = await uploadRefs(visitId, db);
      assert.equal(refs.length, 1);
      assert.deepEqual(Object.keys(refs[0]).sort(), ["id", "kind", "parsedRows"]);
      assert.equal(refs[0].parsedRows, 2016);
    });

    it("gives the fingerprint the visit is actually described by", async () => {
      // The round trip the runner makes: visit columns plus upload refs, hashed, matched against a saved pair.
      const visit = await db.visit.findUniqueOrThrow({ where: { id: visitId } });
      const before = sourInputHash(sourInputsFor(visit, await uploadRefs(visitId, db), "model"));
      await savePair(before);
      assert.ok(await existingSummaryFor(visitId, before, db), "the run that just saved it must see itself");

      await db.upload.create({ data: { visitId, kind: "whoop", filename: "cycles.csv", bytes: 300, parsedRows: 7 } });
      const afterUpload = sourInputHash(sourInputsFor(visit, await uploadRefs(visitId, db), "model"));
      assert.notEqual(afterUpload, before, "a WHOOP export is new input");
      assert.equal(await existingSummaryFor(visitId, afterUpload, db), null);
    });
  });
});
