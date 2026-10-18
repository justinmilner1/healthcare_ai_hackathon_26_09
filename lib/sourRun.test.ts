// Unit tests for one Sour run (T15 and T42, design §6.3, §7.1, §7.2, §8.2).
//
// Two halves, one fixture schema.
//
// `existingSummaryFor` is the "unchanged inputs return the existing summary" rule (§7.1). The hash itself is
// lib/sourInput.test.ts; this is the lookup around it: which saved pair counts as the answer to a fresh run,
// and — just as important — which ones must not, because handing a clinician a summary that does not describe
// this week is worse than spending two model calls.
//
// `runSour` is the run. It is the one function in the product that writes a clinician's brief, so what it does
// when the model is not there matters as much as what it does when it is: §6.3's degraded run must save the
// numbers, say which of the two outages it was, and leave nothing behind that a later run would reuse or that
// would email anybody about a placeholder.
//
// Postgres only (§3.2), so the fixture is a throwaway schema in whatever server DATABASE_URL points at,
// migrated with `prisma migrate deploy` and dropped at the end (lib/fixtures.ts). `runSour` reads the `db`
// singleton rather than taking a client, so the schema is adopted as DATABASE_URL and the modules are pulled
// in afterwards with `await import`; nothing here may import them statically. Without DATABASE_URL both
// halves skip, so `npm test` still works with no database up.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { setLogSink } from "./log";
import type { GlucoseReading, Summary } from "./types";

let fx: FixtureSchema | undefined;
let sourInput: typeof import("./sourInput");
let sourRun: typeof import("./sourRun");

before(async () => {
  if (SKIP_WITHOUT_DB === false) fx = await fixtureSchema("sourruntest", { useAsDefault: true });
  sourInput = await import("./sourInput");
  sourRun = await import("./sourRun");
});

after(async () => {
  setLogSink();
  await fx?.drop();
});

const summary = (patterns: string[]): Summary => ({
  timeInRange: 0.72,
  avgGlucose: 148,
  spikes: [],
  patterns,
  questions: ["What changed in August?"],
  patientNotes: "Meals: pasta most nights",
});

describe("existingSummaryFor", { skip: SKIP_WITHOUT_DB }, () => {
  let db: FixtureSchema["db"];
  let visitId: string;
  let otherVisitId: string;
  const existingSummaryFor: typeof import("./sourRun").existingSummaryFor = (...args) => sourRun.existingSummaryFor(...args);
  const uploadRefs: typeof import("./sourRun").uploadRefs = (...args) => sourRun.uploadRefs(...args);
  const sourInputHash: typeof import("./sourInput").sourInputHash = (...args) => sourInput.sourInputHash(...args);
  const sourInputsFor: typeof import("./sourInput").sourInputsFor = (...args) => sourInput.sourInputsFor(...args);

  before(async () => {
    db = fx!.db;
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient" } });
    const visit = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(16).toString("base64url"), visitType: "follow_up", reason: "mornings running high", notes: "Meals: pasta most nights", intake: JSON.stringify({ turns: 2, wrapped: true }) } });
    const other = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(16).toString("base64url") } });
    visitId = visit.id;
    otherVisitId = other.id;
  });

  after(async () => {
    await db.summary.deleteMany({});
    await db.upload.deleteMany({});
    await db.visit.deleteMany({});
    await db.patient.deleteMany({});
    await db.practice.deleteMany({});
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

// ---------------------------------------------------------------------------------------------
// The run itself

/** Readings with a real spike in them, so the brief has numbers and `detectSpikes` has something to find. */
function readings(count = 288): GlucoseReading[] {
  const t0 = Date.parse("2026-10-05T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => ({
    t: new Date(t0 + i * 5 * 60_000).toISOString(),
    mgdl: Math.round(120 + 80 * Math.sin((i / 36) * Math.PI)),
  }));
}

describe("runSour", { skip: SKIP_WITHOUT_DB }, () => {
  let db: FixtureSchema["db"];
  const ids = { practice: "", patient: "", visit: "" };
  const savedKey = { key: process.env.OPENAI_API_KEY };

  before(async () => {
    db = fx!.db;
    setLogSink(() => {});
    const practice = await db.practice.create({ data: { name: "Run Endocrinology" } });
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Run Patient" } });
    Object.assign(ids, { practice: practice.id, patient: patient.id });
  });

  after(() => {
    if (savedKey.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey.key;
  });

  beforeEach(async () => {
    await db.job.deleteMany({});
    await db.visit.deleteMany({});
    const visit = await db.visit.create({
      data: {
        patientId: ids.patient,
        token: randomBytes(16).toString("base64url"),
        visitType: "follow_up",
        reason: "mornings running high",
        notes: "Meals: pasta most nights",
        intake: JSON.stringify({ turns: 3, wrapped: true }),
        status: "intake_done",
      },
    });
    ids.visit = visit.id;
    const upload = await db.upload.create({ data: { visitId: visit.id, kind: "dexcom", filename: "clarity.csv", parsedRows: 288 } });
    await db.uploadData.create({ data: { uploadId: upload.id, parsed: JSON.stringify(readings()) } });
    // The run is never a real model call here; `narrate` is injected and OPENAI_API_KEY only decides which of
    // §6.3's two outages a failure is reported as.
    process.env.OPENAI_API_KEY = "test-key-not-used";
  });

  /** A narrator that writes whatever it is told to, and records that it was asked. */
  const narrator = (provider: unknown, patient: unknown = provider) => {
    const calls: string[] = [];
    const narrate = async (c: { brief: string }) => {
      calls.push(c.brief);
      return { provider, patient } as { provider: { patterns: string[]; questions: string[] }; patient: { patterns: string[]; questions: string[] } };
    };
    return { calls, narrate };
  };

  const narrative = { patterns: ["3 of 4 overnight highs followed dinners out after 8pm"], questions: ["What changed in August?"] };

  const rows = () => db.summary.findMany({ where: { visitId: ids.visit }, orderBy: { audience: "asc" } });

  it("saves a pair, hands them back, and queues the two links (§7.1, §8.2)", async () => {
    const { calls, narrate } = narrator(narrative);
    const result = await sourRun.runSour(ids.visit, { narrate });

    assert.equal(calls.length, 1, "one narrator call writes both audiences");
    assert.match(calls[0], /OVERALL \(.*readings\): TIR /, "the narrator is handed the rendered brief, not raw rows");
    assert.equal(result.reused, false);
    assert.deepEqual(result.provider.patterns, narrative.patterns);
    assert.ok(result.provider.avgGlucose > 0, "the numbers are code-generated and come back filled in");

    const saved = await rows();
    assert.deepEqual(saved.map((r) => r.audience), ["patient", "provider"]);
    assert.ok(saved.every((r) => r.inputHash), "a narrative worth reusing is saved with its fingerprint");

    assert.ok("queued" in result.notified, `expected a queued job, got ${JSON.stringify(result.notified)}`);
    const job = await db.job.findFirstOrThrow({ where: { kind: "notify.summary" } });
    assert.equal(job.idempotencyKey, `notify.summary:${ids.visit}`, "a second run must not send a second email");
    assert.deepEqual(JSON.parse(job.payload), { visitId: ids.visit }, "no clinical text is ever queued (§10.3)");
  });

  it("gives the clinician the safety flags and the patient none", async () => {
    const { narrate } = narrator(narrative);
    const result = await sourRun.runSour(ids.visit, { narrate });
    // The flags are lib/sour.ts's, deterministic and never the model's; the patient's copy carries none.
    assert.ok(Array.isArray(result.provider.flags));
    assert.deepEqual(result.patient.flags, []);
  });

  it("keeps at most three patterns and three questions, trimmed, and drops what is not a string", async () => {
    const { narrate } = narrator({
      patterns: ["  first  ", "second", "", "   ", 42, null, "third", "fourth"],
      questions: ["only one", { q: "no" }],
    });
    const result = await sourRun.runSour(ids.visit, { narrate });
    assert.deepEqual(result.provider.patterns, ["first", "second", "third"]);
    assert.deepEqual(result.provider.questions, ["only one"]);
  });

  it("survives a narrator that returns nothing shaped like a narrative", async () => {
    // A model that answered with prose instead of the JSON the prompt asked for: lib/llm.ts has already had
    // its one retry by now, so the brief ships with its numbers and no narrative rather than failing the job.
    const { narrate } = narrator({ patterns: "not an array", questions: undefined });
    const result = await sourRun.runSour(ids.visit, { narrate });
    assert.deepEqual(result.provider.patterns, []);
    assert.deepEqual(result.provider.questions, []);
    assert.ok(result.provider.avgGlucose > 0, "the numbers are still there");
    assert.ok("queued" in result.notified, "the model answered, so the links go out");
  });

  it("moves the visit to summary_ready, and only ever forwards (§4.4)", async () => {
    const { narrate } = narrator(narrative);
    await sourRun.runSour(ids.visit, { narrate });
    assert.equal((await db.visit.findUniqueOrThrow({ where: { id: ids.visit } })).status, "summary_ready");

    // Re-running Sour on a visit a clinician has signed off must not pull it back out of `reviewed` (§7.3).
    await db.visit.update({ where: { id: ids.visit }, data: { status: "reviewed" } });
    await db.summary.deleteMany({ where: { visitId: ids.visit } });
    await sourRun.runSour(ids.visit, { narrate });
    assert.equal((await db.visit.findUniqueOrThrow({ where: { id: ids.visit } })).status, "reviewed");
  });

  it("returns the saved pair for unchanged inputs: no second rows, no second email (§7.1)", async () => {
    const { calls, narrate } = narrator(narrative);
    await sourRun.runSour(ids.visit, { narrate });
    await db.job.deleteMany({});

    const again = await sourRun.runSour(ids.visit, { narrate });
    assert.equal(again.reused, true);
    assert.equal(calls.length, 1, "the second run cost no model call");
    assert.equal((await rows()).length, 2, "and wrote no second pair");
    assert.ok("skipped" in again.notified && /unchanged/i.test(again.notified.skipped), JSON.stringify(again.notified));
    assert.equal(await db.job.count({ where: { kind: "notify.summary" } }), 0, "the clinician was already told");
    assert.deepEqual(again.provider.patterns, narrative.patterns);
  });

  it("really regenerates once a new upload has changed the inputs", async () => {
    const { calls, narrate } = narrator(narrative);
    await sourRun.runSour(ids.visit, { narrate });
    await db.upload.create({ data: { visitId: ids.visit, kind: "whoop", filename: "cycles.csv", parsedRows: 7 } });
    const again = await sourRun.runSour(ids.visit, { narrate });
    assert.equal(again.reused, false);
    assert.equal(calls.length, 2);
    assert.equal((await rows()).length, 4, "the new pair is saved beside the old one; the page reads the newest");
  });

  describe("when the model is not there (§6.3)", () => {
    /** A narrator that fails the way lib/llm.ts fails: LLMUnavailable covers no key and a dead gateway alike. */
    const unavailable = async () => {
      const { LLMUnavailable } = await import("./llm");
      return async () => {
        throw new LLMUnavailable("model gateway unavailable (timeout)");
      };
    };

    it("saves the numbers, marks the narrative unavailable, and keeps no fingerprint when a configured gateway is down", async () => {
      const result = await sourRun.runSour(ids.visit, { narrate: await unavailable() });
      assert.equal(result.provider.questions.length, 0);
      assert.deepEqual(result.provider.patterns, [], "no pattern is rendered: a pattern cites data (§7, T63)");
      assert.equal(result.provider.narrativeMissing, "unavailable", "it says which of the two outages this is");
      assert.ok(result.provider.avgGlucose > 0, "the numbers above the note are complete");

      // Null fingerprint, so the next run really runs rather than handing the clinician "retry in a minute"
      // forever (§7.1).
      assert.deepEqual((await rows()).map((r) => r.inputHash), [null, null]);
      const again = await sourRun.runSour(ids.visit, { narrate: narrator(narrative).narrate });
      assert.equal(again.reused, false);
      assert.deepEqual(again.provider.patterns, narrative.patterns);
    });

    it("marks the narrative unconfigured, and does save a fingerprint, when no model is configured at all", async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await sourRun.runSour(ids.visit, { narrate: await unavailable() });
      assert.equal(result.provider.narrativeMissing, "unconfigured");
      assert.equal(result.patient.narrativeMissing, undefined, "the patient's copy carries no deployment state (§10.6)");
      // Deterministic and the whole of what this deployment can produce, so it is worth reusing — and its
      // fingerprint says `unconfigured`, so setting a key invalidates it.
      const saved = await rows();
      assert.ok(saved.every((r) => r.inputHash), "the scripted placeholder is reusable");
      assert.equal((await sourRun.runSour(ids.visit, { narrate: await unavailable() })).reused, true);

      process.env.OPENAI_API_KEY = "test-key-not-used";
      assert.equal((await sourRun.runSour(ids.visit, { narrate: narrator(narrative).narrate })).reused, false, "configuring a key invalidates it");
    });

    it("never emails anybody about a placeholder", async () => {
      const result = await sourRun.runSour(ids.visit, { narrate: await unavailable() });
      assert.ok("skipped" in result.notified, JSON.stringify(result.notified));
      assert.equal(await db.job.count({ where: { kind: "notify.summary" } }), 0);
    });

    it("gives the patient the same note and still no flags", async () => {
      const result = await sourRun.runSour(ids.visit, { narrate: await unavailable() });
      assert.deepEqual(result.patient.patterns, result.provider.patterns);
      assert.deepEqual(result.patient.flags, []);
    });

    it("lets any other failure through, rather than saving a brief that is not one", async () => {
      // A bug, a Prisma error, an out-of-memory: the job must fail and be retried, not quietly write a
      // placeholder over the clinician's brief. Only LLMUnavailable is an outage (§3.5).
      const boom = async () => {
        throw new TypeError("cannot read properties of undefined");
      };
      await assert.rejects(sourRun.runSour(ids.visit, { narrate: boom }), /cannot read properties/);
      assert.deepEqual(await rows(), [], "nothing was saved");
      assert.equal((await db.visit.findUniqueOrThrow({ where: { id: ids.visit } })).status, "intake_done");
    });
  });

  it("sends nothing for sandbox data, which is nobody's appointment (§13.4)", async () => {
    await db.visit.update({ where: { id: ids.visit }, data: { isSandbox: true } });
    const result = await sourRun.runSour(ids.visit, { narrate: narrator(narrative).narrate });
    assert.ok("skipped" in result.notified && /sandbox/i.test(result.notified.skipped), JSON.stringify(result.notified));
    assert.equal(await db.job.count({ where: { kind: "notify.summary" } }), 0);
    assert.equal((await rows()).length, 2, "the summary is still generated and saved; only the email is off");
  });

  it("marks a sandbox brief as synthetic in the text the model is handed", async () => {
    await db.visit.update({ where: { id: ids.visit }, data: { isSandbox: true } });
    const { calls, narrate } = narrator(narrative);
    await sourRun.runSour(ids.visit, { narrate });
    assert.match(calls[0], /SYNTHETIC DEXCOM SANDBOX DATA/);
  });

  it("runs from the invite token as well as the visit id (§4.4)", async () => {
    const visit = await db.visit.findUniqueOrThrow({ where: { id: ids.visit } });
    const result = await sourRun.runSour(visit.token, { narrate: narrator(narrative).narrate });
    assert.equal(result.reused, false);
    assert.equal((await rows()).length, 2);
  });

  it("throws for a visit that is not there, so the job says so rather than doing nothing", async () => {
    await assert.rejects(sourRun.runSour("cl000000000000000000000000", { narrate: narrator(narrative).narrate }), /visit not found/);
    await assert.rejects(sourRun.runSour("", { narrate: narrator(narrative).narrate }), /visit not found/);
  });

  describe("loadSourContext", () => {
    it("computes the brief from full-resolution readings, not the downsampled chart series", async () => {
      const upload = await db.upload.create({ data: { visitId: ids.visit, kind: "dexcom", filename: "week.csv", parsedRows: 2016 } });
      await db.uploadData.create({ data: { uploadId: upload.id, parsed: JSON.stringify(readings(2016)) } });
      const ctx = (await sourRun.loadSourContext(ids.visit))!;
      assert.equal(ctx.glucose.length, 2016);
      assert.equal(ctx.bundle.glucose.length, 504, "the bundle's series is for the chart");
      assert.equal(ctx.notes, "Meals: pasta most nights");
      assert.ok(ctx.inputHash.length > 0);
    });

    it("is null for a visit that is not there", async () => {
      assert.equal(await sourRun.loadSourContext("cl000000000000000000000000"), null);
    });

    it("is reused by runSour rather than being paid for twice", async () => {
      const ctx = (await sourRun.loadSourContext(ids.visit))!;
      const { calls, narrate } = narrator(narrative);
      await sourRun.runSour(ids.visit, { ctx, narrate });
      assert.equal(calls[0], ctx.brief, "the caller's brief is the one the model is handed");
    });
  });
});

// T63 (design §2.7, §6.3, §7, §11.3): what reaches `Summary.json` for each audience when no model wrote the
// narrative. Both of `LLMUnavailable`'s causes go through here, and the thing being asserted is an absence —
// that nothing in either row is addressed to whoever deploys the app. The stringify is not decoration: the
// row is JSON, and a reason smuggled into any field of it would reach the patient's own page.
describe("degradedPair", () => {
  const base: Summary = { ...summary([]), flags: undefined };
  const flags = ["2 readings below 54 mg/dL"];

  for (const [configured, missing] of [[false, "unconfigured"], [true, "unavailable"]] as const) {
    describe(configured ? "a configured gateway that is down" : "no model configured at all", () => {
      // lib/sourRun.ts is imported lazily (see the top of this file), so the pair is built once the module is in.
      let provider: Summary;
      let patient: Summary;
      before(() => ({ provider, patient } = sourRun.degradedPair(base, flags, configured)));

      it("keeps every deterministic number and drops both narrative sections", () => {
        for (const [who, s] of [["provider", provider], ["patient", patient]] as const) {
          assert.equal(s.timeInRange, base.timeInRange, `${who} keeps the numbers lib/sour.ts computed`);
          assert.equal(s.avgGlucose, base.avgGlucose, who);
          assert.equal(s.patientNotes, base.patientNotes, `${who} keeps the patient's own words`);
          assert.deepEqual(s.patterns, [], `${who} must have no pattern to render (§7: a pattern cites data)`);
          assert.deepEqual(s.questions, [], who);
        }
      });

      it("tells the clinician which cause it was, and tells the patient nothing", () => {
        assert.equal(provider.narrativeMissing, missing);
        assert.equal(patient.narrativeMissing, undefined, "the patient cannot act on it and §10.6 keeps it out");
        assert.deepEqual(provider.flags, flags, "safety flags are computed in code and still the clinician's");
        assert.deepEqual(patient.flags, [], "the patient's copy carries none, degraded or not");
      });

      it("writes no variable name, key name, or instruction for whoever deploys the app", () => {
        for (const [who, s] of [["provider", provider], ["patient", patient]] as const) {
          const json = JSON.stringify(s);
          assert.doesNotMatch(json, /OPENAI|API_KEY|apiKey|\.env/i, `${who}: ${json}`);
          assert.doesNotMatch(json, /not configured|unavailable:|set .* to generate/i, `${who} renders no sentence at all`);
        }
      });
    });
  }

  it("marks only the unconfigured pair as one worth reusing (§7.1)", () => {
    // lib/sourRun.ts reads this back: `narrativeMissing === "unconfigured"` is what keeps the fingerprint,
    // because that pair is the whole of what such a deployment can produce. A gateway that was merely down
    // gets a null hash so the next run really runs.
    assert.equal(sourRun.degradedPair(base, flags, false).provider.narrativeMissing, "unconfigured");
    assert.equal(sourRun.degradedPair(base, flags, true).provider.narrativeMissing, "unavailable");
  });
});
