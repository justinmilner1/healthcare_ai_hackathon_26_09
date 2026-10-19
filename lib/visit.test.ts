// Unit tests for the visit gate (T42, design §4.4, §5.3, §10.4, §13.4).
//
// Three claims, and all three are about what is *not* a way in: a patient id resolves nothing, a guessed
// visit id does not open an invite link, and a visit the retention sweep has emptied is not reachable by its
// link any more. The fourth is §13.4's label, applied here once for every visit the app resolves.
//
// lib/visit.ts reads the `db` singleton rather than taking a client, so the fixture schema is adopted as
// DATABASE_URL and the module is pulled in afterwards with `await import` (lib/fixtures.ts says why). That
// also means nothing in this file may import it statically.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { runWithRequestContext, setLogSink } from "./log";

const token = () => randomBytes(16).toString("base64url");

describe("lib/visit.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let fx: FixtureSchema;
  let visit: typeof import("./visit");

  // The rows every test reads: one ordinary visit, one the sweep has cleared, one whose provider has no name.
  const ids = { patient: "", open: "", openToken: "", swept: "", sweptToken: "", nameless: "", demoVisit: "" };

  before(async () => {
    fx = await fixtureSchema("visittest", { useAsDefault: true });
    visit = await import("./visit");
    const db = fx.db;

    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const named = await db.user.create({ data: { practiceId: practice.id, email: "dr.named@fixture.local", name: "Dr. Named", role: "clinician" } });
    const unnamed = await db.user.create({ data: { practiceId: practice.id, email: "no.name@fixture.local", role: "clinician" } });
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient" } });
    ids.patient = patient.id;

    const open = await db.visit.create({ data: { patientId: patient.id, providerUserId: named.id, token: token() } });
    ids.open = open.id;
    ids.openToken = open.token;

    // §10.4: the sweep emptied this one and stamped it. The row is still there; the link is not a way in.
    const swept = await db.visit.create({ data: { patientId: patient.id, providerUserId: named.id, token: token(), retentionSweptAt: new Date("2026-10-01T00:00:00.000Z") } });
    ids.swept = swept.id;
    ids.sweptToken = swept.token;

    const nameless = await db.visit.create({ data: { patientId: patient.id, providerUserId: unnamed.id, token: token() } });
    ids.nameless = nameless.id;

    // §13.4's practice, for the label test. A separate practice, because the flag is the thing under test.
    const demo = await db.practice.create({ data: { name: "Demo Endocrinology", isDemo: true } });
    const demoPatient = await db.patient.create({ data: { practiceId: demo.id, name: "Demo Patient" } });
    ids.demoVisit = (await db.visit.create({ data: { patientId: demoPatient.id, token: token() } })).id;
  });

  after(async () => {
    setLogSink();
    await fx?.drop();
  });

  describe("findVisit", () => {
    it("resolves a visit by its id, with the practice and the provider joined on", async () => {
      const found = await visit.findVisit(ids.open);
      assert.equal(found?.id, ids.open);
      assert.equal(found?.patient.practice.name, "Fixture Endocrinology");
      assert.equal(found?.providerUser?.name, "Dr. Named");
    });

    it("resolves the same visit by its invite token", async () => {
      assert.equal((await visit.findVisit(ids.openToken))?.id, ids.open);
    });

    it("still resolves a swept visit, because the provider path reads by id", async () => {
      // The emptied row is what the clinician sees on the dashboard (§10.4); only the patient link is closed.
      assert.equal((await visit.findVisit(ids.swept))?.id, ids.swept);
    });

    it("resolves nothing for a patient id, an unknown id, or an empty string", async () => {
      assert.equal(await visit.findVisit(ids.patient), null, "a patient has many visits; a patient id is not a visit");
      assert.equal(await visit.findVisit("cl000000000000000000000000"), null);
      assert.equal(await visit.findVisit(""), null);
    });
  });

  describe("visitByToken", () => {
    it("opens a visit by its token and nothing else", async () => {
      assert.equal((await visit.visitByToken(ids.openToken))?.id, ids.open);
      assert.equal(await visit.visitByToken(ids.open), null, "a guessed visit id is not a way in (§5.3)");
    });

    it("refuses a visit the retention sweep has cleared", async () => {
      // Letting the patient back in would have them refill a row the sweep has already marked swept (§10.4).
      assert.equal(await visit.visitByToken(ids.sweptToken), null);
    });

    it("refuses a missing token without going to the database", async () => {
      for (const given of [null, undefined, ""]) assert.equal(await visit.visitByToken(given), null);
    });
  });

  describe("providerName", () => {
    it("names the provider the patient is talking to", () => {
      assert.equal(visit.providerName({ providerUser: { name: "Dr. Named" } }), "Dr. Named");
    });

    it("falls back to the care team when the provider row has no name yet (§5.1)", () => {
      assert.equal(visit.providerName({ providerUser: { name: null } }), visit.CARE_TEAM);
      assert.equal(visit.providerName({ providerUser: null }), visit.CARE_TEAM);
      assert.equal(visit.CARE_TEAM, "your care team");
    });

    it("reads the fallback off a visit the gate resolved", async () => {
      const found = await visit.findVisit(ids.nameless);
      assert.equal(visit.providerName(found!), visit.CARE_TEAM);
    });
  });

  // T86 (§7.4, §7.3): the other audience. The printed one-pager goes in a chart, so the line under the
  // practice name is read by the practice — and §2.2 never asks staff for a clinician, so the unassigned
  // visit is the ordinary one and this is the ordinary line.
  describe("clinicianLine", () => {
    it("names the clinician the practice has attached to the visit", () => {
      assert.equal(visit.clinicianLine({ providerUser: { name: "Dr. Named" } }), "Dr. Named");
      // The sign-off does not displace an assignment, even when it is someone else's.
      assert.equal(visit.clinicianLine({ providerUser: { name: "Dr. Named" } }, "Dr. Covering"), "Dr. Named");
    });

    it("says in the practice's own words that nobody is assigned, never the patient's (§5.1)", () => {
      for (const given of [{ providerUser: null }, { providerUser: { name: null } }]) {
        assert.equal(visit.clinicianLine(given), visit.NO_CLINICIAN);
      }
      assert.equal(visit.NO_CLINICIAN, "No clinician assigned");
      assert.notEqual(visit.NO_CLINICIAN, visit.CARE_TEAM);
      assert.doesNotMatch(visit.NO_CLINICIAN, /\byour\b/i, "'your ...' addresses the reader as the patient");
    });

    it("names whoever signed the summary off when nobody is assigned (§7.3)", () => {
      // The sheet's banner reads "Reviewed by Dr. Okafor" four lines below this one; the header may not
      // answer "nobody" to the same question.
      assert.equal(visit.clinicianLine({ providerUser: null }, "Dr. Okafor"), "Dr. Okafor");
      assert.equal(visit.clinicianLine({ providerUser: { name: null } }, "Dr. Okafor"), "Dr. Okafor");
    });

    it("treats a blank or whitespace name as no name, so the slot is never empty", () => {
      assert.equal(visit.clinicianLine({ providerUser: { name: "   " } }), visit.NO_CLINICIAN);
      assert.equal(visit.clinicianLine({ providerUser: { name: "" } }, " "), visit.NO_CLINICIAN);
      assert.equal(visit.clinicianLine({ providerUser: { name: " " } }, "Dr. Okafor"), "Dr. Okafor");
      assert.equal(visit.clinicianLine({ providerUser: { name: " Dr. Padded " } }), "Dr. Padded");
    });

    it("reads a visit the gate resolved, the one the print page holds", async () => {
      assert.equal(visit.clinicianLine((await visit.findVisit(ids.nameless))!), visit.NO_CLINICIAN);
      assert.equal(visit.clinicianLine((await visit.findVisit(ids.open))!), "Dr. Named");
    });
  });

  describe("the demo label (§13.4)", () => {
    /** Resolve a visit inside a request context and report whether the lines that request writes are labelled. */
    const labelAfterResolving = async (visitId: string) => {
      const lines: string[] = [];
      setLogSink((_level, line) => lines.push(line));
      await runWithRequestContext({ requestId: "11111111-2222-3333-4444-555555555555" }, async () => {
        await visit.findVisit(visitId);
        // A line written *after* the gate, by code with no practice in hand: the `request_failed` and
        // `job_failed` case §11.1's alarms count.
        const { log } = await import("./log");
        log.info("probe");
      });
      setLogSink();
      return lines.map((l) => JSON.parse(l) as { event: string; demo?: boolean }).find((l) => l.event === "probe")?.demo;
    };

    it("marks the whole request when the visit belongs to a demo practice", async () => {
      assert.equal(await labelAfterResolving(ids.demoVisit), true);
    });

    it("leaves a real practice's request unlabelled", async () => {
      assert.equal(await labelAfterResolving(ids.open), undefined);
    });
  });
});
