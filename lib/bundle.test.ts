// Unit tests for the bundle (T42, design §4.4, §7.1, §7.2, §12.1).
//
// `GET /api/patient/[id]` is the only way a page gets data, so `loadBundle` is the shape of every screen in
// the product: what it leaves out, a page cannot show. Three things are worth pinning. It is keyed on a visit
// and never on a patient (§4.4). A stored row it cannot parse degrades to "no data" rather than taking the
// page down with it — a corrupt summary must not turn the provider brief into a 500. And `summaryStale` is
// computed with the same fingerprint Sour hashes with (§7.1), so "stale" here and "regenerate" there cannot
// disagree.
//
// `computeStats` and `baseSummary` are pure and tested without rows.
//
// lib/bundle.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the module is
// pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it statically.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { setLogSink } from "./log";
import type { GlucoseReading, PatientBundle, SleepNight, Summary, Visit } from "./types";

/** A week of readings at `step` minutes, walking a sine so there are real spikes to detect. */
function readings(count: number, startIso = "2026-10-05T00:00:00.000Z", stepMin = 5): GlucoseReading[] {
  const t0 = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    t: new Date(t0 + i * stepMin * 60_000).toISOString(),
    mgdl: Math.round(120 + 80 * Math.sin((i / 36) * Math.PI)),
  }));
}

const summary = (patterns: string[]): Summary => ({
  timeInRange: 0.71, avgGlucose: 149, spikes: [], patterns, questions: ["What changed?"], patientNotes: "pasta",
});

describe("lib/bundle.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let fx: FixtureSchema;
  let bundle: typeof import("./bundle");
  let sourInput: typeof import("./sourInput");
  const ids = { practice: "", patient: "", visit: "", token: "", provider: "" };

  before(async () => {
    fx = await fixtureSchema("bundletest", { useAsDefault: true });
    bundle = await import("./bundle");
    sourInput = await import("./sourInput");
    setLogSink(() => {});

    const practice = await fx.db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const provider = await fx.db.user.create({ data: { practiceId: practice.id, email: "dr@fixture.local", name: "Dr. Fixture", role: "clinician" } });
    const patient = await fx.db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient" } });
    Object.assign(ids, { practice: practice.id, patient: patient.id, provider: provider.id });
  });

  after(async () => {
    setLogSink();
    await fx?.drop();
  });

  beforeEach(async () => {
    await fx.db.visit.deleteMany({});
    const visit = await fx.db.visit.create({
      data: {
        patientId: ids.patient,
        providerUserId: ids.provider,
        token: randomBytes(16).toString("base64url"),
        scheduledAt: new Date("2026-10-20T15:00:00.000Z"),
        visitType: "follow_up",
        reason: "mornings running high",
        notes: "Meals: pasta most nights",
        intakeConsentAt: new Date("2026-10-12T09:00:00.000Z"),
        status: "in_intake",
      },
    });
    ids.visit = visit.id;
    ids.token = visit.token;
  });

  /** One upload with its parsed rows, the way lib/uploads.ts writes them. */
  const upload = async (kind: string, parsed: unknown, visitId = ids.visit) => {
    const rows = Array.isArray(parsed) ? parsed.length : 0;
    const row = await fx.db.upload.create({ data: { visitId, kind, filename: `${kind}.csv`, parsedRows: rows } });
    await fx.db.uploadData.create({ data: { uploadId: row.id, parsed: JSON.stringify(parsed) } });
    return row;
  };

  describe("loadBundle", () => {
    it("is keyed on a visit, by id or by the invite token, and on nothing else (§4.4)", async () => {
      assert.equal((await bundle.loadBundle(ids.visit))?.visitId, ids.visit);
      assert.equal((await bundle.loadBundle(ids.token))?.visitId, ids.visit);
      assert.equal(await bundle.loadBundle(ids.patient), null, "a patient has many visits");
      assert.equal(await bundle.loadBundle(""), null);
      assert.equal(await bundle.loadBundle("nope"), null);
    });

    it("carries the visit, the patient and the care team as the pages read them", async () => {
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.visitStatus, "in_intake");
      assert.equal(b.intakeConsentAt, "2026-10-12T09:00:00.000Z");
      assert.deepEqual(b.patient, {
        id: ids.patient,
        name: "Fixture Patient",
        token: ids.token,
        isSandbox: false,
        apptAt: "2026-10-20T15:00:00.000Z",
        visitType: "follow_up",
        reason: "mornings running high",
        notes: "Meals: pasta most nights",
        provider: { id: ids.provider, name: "Dr. Fixture", practice: "Fixture Endocrinology" },
      });
    });

    it("is empty but well formed for a visit with no uploads, so a page renders before intake", async () => {
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual([b.glucose, b.visits, b.sleep, b.spikes], [[], [], [], []]);
      assert.deepEqual(b.stats, { readings: 0, days: 0, tir: 0, tbr: 0, tar: 0, avg: 0, gmi: 0, sleepAvgHours: null, recoveryAvg: null });
      assert.deepEqual(b.status, { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 0, done: false });
      assert.equal(b.providerSummary, null);
      assert.equal(b.patientSummary, null);
      assert.equal(b.sourJob, null);
      assert.equal(b.summaryStale, false, "no summary yet is not a stale one");
      assert.equal(b.review, null);
      assert.deepEqual(b.patientMessages, [], "and nobody has said anything yet (T154)");
    });

    it("reads each upload kind, downsamples the chart series, and caps the spikes at five", async () => {
      const glucose = readings(2016); // a week at five minutes
      await upload("dexcom", glucose);
      await upload("whoop", [{ date: "2026-10-05", hours: 6.5, recovery: 44 }] satisfies SleepNight[]);
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.stats.readings, 2016, "the stats are computed on every reading");
      assert.equal(b.glucose.length, 504, "the chart series is downsampled");
      assert.ok(b.spikes.length > 0 && b.spikes.length <= 5, `expected 1..5 spikes, got ${b.spikes.length}`);
      assert.deepEqual(b.sleep, [{ date: "2026-10-05", hours: 6.5, recovery: 44 }]);
      assert.deepEqual([b.status.hasDexcom, b.status.hasWhoop, b.status.hasLocation], [true, true, false]);
    });

    it("labels Timeline places from the hand-labelled list, and uses the list alone when there is no export", async () => {
      const place: Visit = { start: "2026-10-06T19:00:00.000Z", end: "2026-10-06T20:30:00.000Z", place: "Unknown", lat: 37.7749, lng: -122.4194, placeId: "ChIJ-known" };
      const labelled: Visit[] = [{ ...place, place: "Tony's Pizza" }];
      await upload("timeline", [place]);
      await upload("visits", labelled);
      let b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual(b.visits.map((v) => v.place), ["Tony's Pizza"]);
      assert.equal(b.status.hasLocation, true);

      await fx.db.upload.deleteMany({ where: { visitId: ids.visit, kind: "timeline" } });
      b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual(b.visits.map((v) => v.place), ["Tony's Pizza"], "no export, so the labelled list is the list");
    });

    it("takes the newest upload of a kind, not the first one the patient sent", async () => {
      await upload("dexcom", readings(12));
      await new Promise((r) => setTimeout(r, 5));
      await upload("dexcom", readings(300, "2026-10-06T00:00:00.000Z"));
      assert.equal((await bundle.loadBundle(ids.visit))!.stats.readings, 300);
    });

    it("builds the intake template from the visit type and the reason, and counts the answers", async () => {
      const fields = (await bundle.loadBundle(ids.visit))!.intakeFields;
      assert.deepEqual(fields.map((f) => f.id), ["purpose", "update"]);
      assert.match(fields[0].fallbackQuestion, /mornings running high/, "the scheduler's words are quoted back (§6.1)");

      await fx.db.visit.update({
        where: { id: ids.visit },
        data: { intake: JSON.stringify({ fields: { purpose: { value: "worse since August", confidence: "high" }, update: { value: null, confidence: "unfilled" } }, skipped: [], flagged: null, turns: 3, wrapped: false }) },
      });
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.intake.turns, 3);
      assert.equal(b.status.answered, 1);
      assert.equal(b.status.done, false, "one of two required fields is not done");
    });

    // T154 (§2.6): the patient's own half of the transcript, which the clinician's brief quotes where the
    // notes hold no answer of theirs. Sweetie's half is deliberately not in it — the clinician is reading
    // what the patient said — and the order is the order they said it in, because the first message is
    // where a §2.5 flag fires.
    it("carries the patient's own messages, oldest first, and not Sweetie's", async () => {
      for (const [role, content] of [
        ["sweetie", "Hi, I'm Sweetie. What's bringing you in?"],
        ["patient", "I had chest pain yesterday evening and it really scared me."],
        ["sweetie", "Please call the office today."],
        ["patient", "Should I still answer the questions?"],
      ] as const) {
        await fx.db.message.create({ data: { visitId: ids.visit, role, content } });
        await new Promise((r) => setTimeout(r, 2));
      }
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual(b.patientMessages, [
        "I had chest pain yesterday evening and it really scared me.",
        "Should I still answer the questions?",
      ]);
    });

    // T118 (§2.5, §2.7): the bundle carries which connect control /s/<token> has for this visit, so the
    // patient's own empty state asks for something that will be there. The check script and the demo run
    // with no Dexcom credentials, which is the state that used to offer a Connect Dexcom button leading to
    // a page with no Dexcom on it.
    it("says there is no Dexcom connection to offer where the deployment has no credentials", async () => {
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.dexcomConnect, "none");
    });

    it("drops the reason from the template for a sandbox visit, whose reason is not a patient's", async () => {
      await fx.db.visit.update({ where: { id: ids.visit }, data: { isSandbox: true } });
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.patient.isSandbox, true);
      assert.doesNotMatch(b.intakeFields[0].fallbackQuestion, /mornings running high/);
    });

    it("calls intake done when the patient wrapped, or skipped the questions", async () => {
      const intake = (extra: Record<string, unknown>) => JSON.stringify({ fields: {}, skipped: [], flagged: null, turns: 1, wrapped: false, ...extra });
      await fx.db.visit.update({ where: { id: ids.visit }, data: { intake: intake({ wrapped: true }) } });
      assert.equal((await bundle.loadBundle(ids.visit))!.status.done, true);
      await fx.db.visit.update({ where: { id: ids.visit }, data: { intake: intake({ questionsSkipped: true }) } });
      assert.equal((await bundle.loadBundle(ids.visit))!.status.done, true);
    });

    it("returns the newest summary per audience, with its timestamp", async () => {
      await fx.db.summary.create({ data: { visitId: ids.visit, audience: "provider", json: JSON.stringify(summary(["old"])) } });
      await new Promise((r) => setTimeout(r, 5));
      const newest = await fx.db.summary.create({ data: { visitId: ids.visit, audience: "provider", json: JSON.stringify(summary(["new"])) } });
      await fx.db.summary.create({ data: { visitId: ids.visit, audience: "patient", json: JSON.stringify(summary(["yours"])) } });
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual(b.providerSummary?.patterns, ["new"]);
      assert.deepEqual(b.patientSummary?.patterns, ["yours"]);
      assert.equal(b.providerSummaryAt, newest.createdAt.toISOString());
    });

    it("degrades a stored row it cannot parse to no data, rather than taking the page down", async () => {
      // parseOr: a truncated write or a schema change must not turn the provider brief into a 500.
      const row = await fx.db.upload.create({ data: { visitId: ids.visit, kind: "dexcom", filename: "d.csv", parsedRows: 9 } });
      await fx.db.uploadData.create({ data: { uploadId: row.id, parsed: '[{"t":"2026-10-05T00:00' } });
      await fx.db.summary.create({ data: { visitId: ids.visit, audience: "provider", json: "{not json" } });

      const b = (await bundle.loadBundle(ids.visit))!;
      assert.deepEqual(b.glucose, [], "a corrupt dexcom upload reads as no readings");
      assert.equal(b.status.hasDexcom, false);
      assert.equal(b.providerSummary, null, "a corrupt summary reads as no summary");
      assert.equal(b.providerSummaryAt, (await fx.db.summary.findFirstOrThrow({ where: { visitId: ids.visit } })).createdAt.toISOString(), "the row is still there, so the page can say when it was written");
    });

    it("reports the newest sour.run job for this visit and no other kind (§7.2)", async () => {
      await fx.db.job.create({ data: { kind: "notify.summary", payload: JSON.stringify({ visitId: ids.visit }) } });
      assert.equal((await bundle.loadBundle(ids.visit))!.sourJob, null, "another kind of job is not Sour's");
      const job = await fx.db.job.create({ data: { kind: "sour.run", payload: JSON.stringify({ visitId: ids.visit }), status: "failed", attempts: 3, lastError: "model gateway unavailable" } });
      const view = (await bundle.loadBundle(ids.visit))!.sourJob;
      assert.equal(view?.id, job.id);
      assert.equal(view?.status, "failed");
      assert.equal(view?.attempts, 3);
      assert.equal(view?.lastError, "model gateway unavailable");
    });

    it("calls a summary stale exactly when its fingerprint is not the current one (§7.1)", async () => {
      await upload("dexcom", readings(60));
      const visit = await fx.db.visit.findUniqueOrThrow({ where: { id: ids.visit }, include: { uploads: true } });
      const current = sourInput.sourInputHash(sourInput.sourInputsFor(visit, visit.uploads, sourInput.narrativeSource(false)));

      const pair = async (hash: string | null) => {
        await fx.db.summary.deleteMany({ where: { visitId: ids.visit } });
        for (const audience of ["provider", "patient"]) {
          await fx.db.summary.create({ data: { visitId: ids.visit, audience, json: JSON.stringify(summary(["p"])), inputHash: hash } });
        }
        return (await bundle.loadBundle(ids.visit))!.summaryStale;
      };

      assert.equal(await pair(current), false, "the summary describes these inputs");
      assert.equal(await pair("stale-from-last-week"), true);
      assert.equal(await pair(null), true, "a degraded run saved no fingerprint, so it always reads stale");

      // A new upload changes the fingerprint, which is what the provider page's "regenerate" offer is for.
      await pair(current);
      await upload("whoop", [{ date: "2026-10-06", hours: 7 }] satisfies SleepNight[]);
      assert.equal((await bundle.loadBundle(ids.visit))!.summaryStale, true);
    });

    it("carries only half a pair as stale, because notify.summary sends a link to each", async () => {
      await upload("dexcom", readings(60));
      const visit = await fx.db.visit.findUniqueOrThrow({ where: { id: ids.visit }, include: { uploads: true } });
      const current = sourInput.sourInputHash(sourInput.sourInputsFor(visit, visit.uploads, sourInput.narrativeSource(false)));
      await fx.db.summary.create({ data: { visitId: ids.visit, audience: "provider", json: JSON.stringify(summary(["p"])), inputHash: current } });
      assert.equal((await bundle.loadBundle(ids.visit))!.summaryStale, true, "no patient row matches the fingerprint");
    });

    it("joins the clinician's sign-off on (§7.3)", async () => {
      await fx.db.visit.update({ where: { id: ids.visit }, data: { status: "reviewed", reviewedBy: ids.provider, reviewedAt: new Date("2026-10-14T17:30:00.000Z") } });
      const b = (await bundle.loadBundle(ids.visit))!;
      assert.equal(b.review?.at, "2026-10-14T17:30:00.000Z");
      assert.equal(b.review?.by, ids.provider);
      assert.equal(b.review?.byName, "Dr. Fixture");
    });

    it("keeps one visit's uploads out of another's", async () => {
      const other = await fx.db.visit.create({ data: { patientId: ids.patient, token: randomBytes(16).toString("base64url") } });
      await upload("dexcom", readings(60), other.id);
      assert.equal((await bundle.loadBundle(ids.visit))!.stats.readings, 0);
      assert.equal((await bundle.loadBundle(other.id))!.stats.readings, 60);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The pure half: §7's deterministic numbers. No database, so these run everywhere.

describe("computeStats", () => {
  it("is all zeroes and nulls for nothing, rather than NaN on the page", async () => {
    const { computeStats } = await import("./bundle");
    assert.deepEqual(computeStats([], []), { readings: 0, days: 0, tir: 0, tbr: 0, tar: 0, avg: 0, gmi: 0, sleepAvgHours: null, recoveryAvg: null });
  });

  it("counts time below and above range beside time in range, and rounds to three places", async () => {
    const { computeStats } = await import("./bundle");
    const glucose: GlucoseReading[] = [
      { t: "2026-10-05T00:00:00.000Z", mgdl: 62 },  // below
      { t: "2026-10-05T00:05:00.000Z", mgdl: 90 },  // in
      { t: "2026-10-05T00:10:00.000Z", mgdl: 150 }, // in
      { t: "2026-10-05T00:15:00.000Z", mgdl: 240 }, // above
    ];
    const s = computeStats(glucose, []);
    assert.equal(s.readings, 4);
    assert.equal(s.tir, 0.5);
    assert.equal(s.tbr, 0.25);
    assert.equal(s.tar, 0.25);
    assert.equal(s.avg, 136);
    assert.equal(s.gmi, Math.round((3.31 + 0.02392 * 136) * 10) / 10);
  });

  it("measures the span in days rather than counting UTC dates", async () => {
    const { computeStats } = await import("./bundle");
    // A 7-day export in local time straddles 8 UTC dates; it is still seven days of data.
    const week: GlucoseReading[] = [
      { t: "2026-10-05T07:30:00.000Z", mgdl: 110 },
      { t: "2026-10-12T06:30:00.000Z", mgdl: 115 },
    ];
    assert.equal(computeStats(week, []).days, 7);
    const oneDay: GlucoseReading[] = [{ t: "2026-10-05T07:30:00.000Z", mgdl: 110 }, { t: "2026-10-05T09:30:00.000Z", mgdl: 115 }];
    assert.equal(computeStats(oneDay, []).days, 1, "a part of a day is a day, never zero");
  });

  it("averages sleep and recovery, and leaves recovery null when WHOOP did not report it", async () => {
    const { computeStats } = await import("./bundle");
    const nights: SleepNight[] = [{ date: "2026-10-05", hours: 6.2, recovery: 41 }, { date: "2026-10-06", hours: 7.9, recovery: 68 }];
    const s = computeStats([], nights);
    assert.equal(s.sleepAvgHours, 7.1);
    assert.equal(s.recoveryAvg, 55);
    assert.equal(computeStats([], [{ date: "2026-10-05", hours: 6 }]).recoveryAvg, null);
  });
});

describe("baseSummary", () => {
  it("is the deterministic half: numbers and spikes in, patterns and questions left to the model", async () => {
    const { baseSummary } = await import("./bundle");
    const glucose = readings(288);
    const base = baseSummary(glucose, [], "Meals: pasta most nights");
    assert.deepEqual(base.patterns, []);
    assert.deepEqual(base.questions, []);
    assert.equal(base.patientNotes, "Meals: pasta most nights");
    assert.ok(base.timeInRange > 0 && base.timeInRange < 1);
    assert.equal(base.timeInRange, Math.round(base.timeInRange * 1000) / 1000);
    assert.equal(base.flags, undefined, "lib/sour.ts adds the flags; this is the shared half");
  });
});

// T63 (design §2.7, §5.2, §10.6): the audience split. `patientView` is the pure part worth pinning, because
// what it drops is the difference between a patient's page and a clinician's one. Every field of a
// PatientBundle is accounted for below on purpose: a field added later lands in one of the two lists rather
// than reaching a patient's browser because nobody thought about it.
const summaryWith = (patterns: string[], flags?: string[]): Summary => ({
  timeInRange: 0.72,
  avgGlucose: 148,
  spikes: [],
  patterns,
  questions: ["What changed in August?"],
  patientNotes: "Meals: pasta most nights",
  ...(flags ? { flags } : {}),
});

const BUNDLE: PatientBundle = {
  visitId: "vis_1",
  visitStatus: "summary_ready",
  intakeConsentAt: "2026-10-11T12:00:00.000Z",
  patient: {
    id: "pat_1",
    name: "Fixture Patient",
    token: "tok_1",
    isSandbox: false,
    apptAt: "2026-10-20T15:00:00.000Z",
    visitType: "follow_up",
    reason: "spikes after dinner",
    notes: "Meals: pasta most nights",
    provider: { id: "usr_1", name: "Dr. Demo Endo", practice: "Sweet Spot Endocrinology" },
  },
  glucose: [{ t: "2026-10-11T12:00:00.000Z", mgdl: 132 }],
  visits: [],
  sleep: [],
  spikes: [],
  stats: { readings: 2016, days: 7, tir: 0.72, tbr: 0.01, tar: 0.27, avg: 148, gmi: 6.9, sleepAvgHours: 6.9, recoveryAvg: null },
  status: { hasDexcom: true, hasLocation: false, hasWhoop: false, answered: 2, done: true },
  intake: { fields: {}, skipped: [], flagged: null, turns: 2, wrapped: true },
  intakeFields: [],
  patientMessages: ["Pasta most nights, and I ate out twice."],
  providerSummary: summaryWith(["3 of 4 overnight highs followed dinners out after 8pm"], ["2 readings below 54 mg/dL"]),
  providerSummaryAt: "2026-10-11T12:05:00.000Z",
  patientSummary: summaryWith(["Your evenings out ran high"]),
  patientSummaryAt: "2026-10-11T12:05:01.000Z",
  sourJob: {
    id: "job_1",
    status: "failed",
    attempts: 3,
    maxAttempts: 3,
    lastError: "model gateway timeout",
    runAfter: "2026-10-11T12:04:00.000Z",
    startedAt: "2026-10-11T12:04:30.000Z",
    finishedAt: "2026-10-11T12:05:00.000Z",
    createdAt: "2026-10-11T12:03:00.000Z",
  },
  summaryStale: true,
  review: { by: "usr_1", byName: "Dr. Demo Endo", at: "2026-10-11T12:30:00.000Z" },
  // The control the patient's own empty state renders its invitation from (T118), so it is the patient's
  // half: `patientView` keeps it, and the assertion below says so.
  dexcomConnect: "oauth",
};

describe("patientView", () => {
  // lib/bundle.ts is imported lazily (see the top of this file), so the view is built inside each test.
  const viewOf = async () => (await import("./bundle")).patientView(BUNDLE);

  it("keeps everything the patient's own page renders", async () => {
    const view = await viewOf();
    // `patientMessages` is in this list rather than the one below: it is the patient's own half of their
    // own transcript (T154), which they can already read at GET /api/sweetie, and not the clinician's
    // material §5.2 keeps from them.
    for (const key of ["visitId", "visitStatus", "intakeConsentAt", "patient", "glucose", "visits", "sleep", "spikes", "stats", "status", "intake", "intakeFields", "patientMessages", "patientSummary", "patientSummaryAt", "dexcomConnect"] as const) {
      assert.deepEqual(view[key], BUNDLE[key], `${key} is the patient's own`);
    }
  });

  it("hands over none of the clinician's half", async () => {
    const view = await viewOf();
    assert.equal(view.providerSummary, null, "the clinician's patterns, questions and safety flags (§7)");
    assert.equal(view.providerSummaryAt, null);
    assert.equal(view.sourJob, null, "the job's state and its error text (§7.2)");
    assert.equal(view.summaryStale, false);
    assert.equal(view.review, null, "the sign-off is the clinician's record (§7.3)");
  });

  it("leaks nothing through the JSON a patient's browser receives", async () => {
    const view = await viewOf();
    const { patientView } = await import("./bundle");
    const json = JSON.stringify(view);
    assert.doesNotMatch(json, /overnight highs followed dinners/, "the clinician's narrative");
    assert.doesNotMatch(json, /below 54 mg\/dL/, "a safety flag is phrased for a clinician");
    assert.doesNotMatch(json, /gateway timeout/, "an operational error message");
    // T63's own reason for being here: the provider summary carries why no model wrote the narrative, and
    // that is the practice's deployment state, not the patient's business (§10.6).
    const withState = patientView({ ...BUNDLE, providerSummary: { ...summaryWith([]), narrativeMissing: "unconfigured" } });
    assert.doesNotMatch(JSON.stringify(withState), /narrativeMissing|unconfigured/);
  });

  it("does not touch the bundle it was given, which the provider path still answers with", () => {
    assert.ok(BUNDLE.providerSummary, "the clinician's own response is the whole bundle");
    assert.equal(BUNDLE.review?.byName, "Dr. Demo Endo");
  });
});
