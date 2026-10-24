// Unit tests for the consent screen's logic (T09, design §2.4).
//
// Two halves, the same split as lib/patientSession.test.ts. The pure half checks the four statements §2.4
// requires and the "first open only" rule, and runs anywhere. The second drives the real write through a
// throwaway schema on whatever server DATABASE_URL points at, and skips when there is none.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { CONSENT_POINT_IDS, consentPoints, needsConsent, recordConsent } from "./consent";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const LATER = new Date("2026-10-15T09:30:00.000Z");
const AUDIENCE = { clinicianName: "Dr. Rivera", practiceName: "Birch Street Endocrinology" };

describe("consentPoints: the four things §2.4 requires the screen to say", () => {
  it("says all four, in the order §2.4 lists them", () => {
    assert.deepEqual(
      consentPoints(AUDIENCE).map((point) => point.id),
      [...CONSENT_POINT_IDS],
    );
  });

  it("names what is collected: the questions, and the three optional exports", () => {
    const { body } = point("collects");
    for (const source of ["Dexcom", "Timeline", "WHOOP"]) assert.match(body, new RegExp(source));
    assert.match(body, /question/i);
  });

  it("says it is optional in words a patient would use, and that care does not depend on it", () => {
    const collected = point("optional");
    assert.match(collected.title, /optional/i);
    assert.match(collected.body, /skip/i);
    assert.match(collected.body, /appointment goes ahead/i);
  });

  it("says a clinician reviews it, and names the clinician and the practice", () => {
    const reviewed = point("reviewed");
    assert.match(reviewed.title, /clinician/i);
    assert.match(reviewed.body, /Dr\. Rivera/);
    assert.match(reviewed.body, /Birch Street Endocrinology/);
    // §2.5's standing promise, in the one place the patient reads before saying yes.
    assert.match(reviewed.body, /cannot give you medical advice/i);
  });

  it("says how to have it deleted, and who to ask (§2.8, §10.5)", () => {
    const deletion = point("delete");
    assert.match(deletion.title, /delet/i);
    assert.match(deletion.body, /Birch Street Endocrinology/);
    assert.match(deletion.body, /answers/i);
  });

  it("falls back to 'the practice' rather than printing nothing when the practice has no name", () => {
    for (const practiceName of [null, "", "   "]) {
      const points = consentPoints({ ...AUDIENCE, practiceName });
      for (const id of ["reviewed", "delete"] as const) {
        const { body } = points.find((p) => p.id === id)!;
        assert.match(body, /the practice/);
        assert.doesNotMatch(body, /\s{2,}|undefined|null/);
      }
    }
  });

  // T138, the rule T100 → T114 → T116 → T123 → T132 → T136 has been taking off the patient path one screen
  // at a time: the span comes from the data, not from the brand. The `collects` point promised "your week"
  // for three uploads whose span the patient picks, on the screen that renders before any of them exists —
  // the earliest surface of the claim, and the only one read before the patient has decided anything.
  //
  // The negative is over every point rather than that one sentence, and over the titles as well as the
  // bodies, because the defect was a reword away from any of them and this screen has no legitimate span to
  // protect: no day count is in scope here. Both audiences go through it since the copy interpolates, and a
  // practice called "Week Street Diabetes" would be a false positive worth hearing about — the fixture names
  // stay ordinary so it cannot be one silently.
  it("names no span anywhere on the screen: it renders before a single file exists (T138, §2.4)", () => {
    for (const practiceName of [AUDIENCE.practiceName, null, "", "   "]) {
      for (const { id, title, body } of consentPoints({ ...AUDIENCE, practiceName })) {
        assert.doesNotMatch(title, /\bweek\b/i, `the ${id} point's title names a week`);
        assert.doesNotMatch(body, /\bweek\b/i, `the ${id} point's body names a week`);
      }
    }
  });

  // And the sentence still does the job §2.4 gives it (the assertion above cannot tell a reword from a
  // deletion): all three sources by name, and the sharing still optional.
  it("still names the three sources and still says the uploads are optional", () => {
    const { body } = point("collects");
    for (const source of ["Dexcom", "Google Timeline", "WHOOP"]) assert.match(body, new RegExp(source));
    assert.match(body, /if you want to/i);
  });

  const point = (id: (typeof CONSENT_POINT_IDS)[number]) => {
    const found = consentPoints(AUDIENCE).find((p) => p.id === id);
    assert.ok(found, `no ${id} point`);
    return found!;
  };
});

describe("needsConsent: first open only (§2.4)", () => {
  it("asks a visit that has not answered, and never asks again once it has accepted", () => {
    assert.equal(needsConsent({ isSandbox: false, intakeConsentAt: null }), true);
    assert.equal(needsConsent({ isSandbox: false, intakeConsentAt: NOW }), false);
  });

  it("exempts the sandbox demonstration, for the reason it skips the code screen too (§9.2)", () => {
    assert.equal(needsConsent({ isSandbox: true, intakeConsentAt: null }), false);
  });
});

// ---------------------------------------------------------------------------------------------
// The write itself, against Postgres

const SERVER_URL = process.env.DATABASE_URL;
const schema = `cstest_${randomBytes(4).toString("hex")}`;

describe("recordConsent against the database", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let visitId: string;

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
    await db.visit.deleteMany({});
    await db.patient.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const visit = await db.visit.create({
      data: {
        token: randomBytes(8).toString("base64url"),
        patient: { create: { practiceId: practice.id, name: "Fixture Patient", email: "fixture@example.test" } },
      },
    });
    visitId = visit.id;
  });

  const read = () => db.visit.findUniqueOrThrow({ where: { id: visitId } });

  it("stores the acceptance on the visit with the time (§2.4), and the gate stops asking", async () => {
    await recordConsent(visitId, true, NOW, db);
    const visit = await read();
    assert.deepEqual(visit.intakeConsentAt, NOW);
    assert.equal(visit.intakeConsentDeclinedAt, null);
    assert.equal(needsConsent(visit), false);
  });

  it("keeps the first acceptance: a reload is not a second consent", async () => {
    await recordConsent(visitId, true, NOW, db);
    await recordConsent(visitId, true, LATER, db);
    assert.deepEqual((await read()).intakeConsentAt, NOW);
  });

  it("stores a decline on its own, leaving nothing accepted", async () => {
    await recordConsent(visitId, false, NOW, db);
    const visit = await read();
    assert.deepEqual(visit.intakeConsentDeclinedAt, NOW);
    assert.equal(visit.intakeConsentAt, null);
    assert.equal(needsConsent(visit), true, "a patient who comes back is asked again");
  });

  it("keeps both times when a patient declines and later changes their mind", async () => {
    await recordConsent(visitId, false, NOW, db);
    await recordConsent(visitId, true, LATER, db);
    const visit = await read();
    assert.deepEqual(visit.intakeConsentDeclinedAt, NOW);
    assert.deepEqual(visit.intakeConsentAt, LATER);
    assert.equal(needsConsent(visit), false);
  });
});
