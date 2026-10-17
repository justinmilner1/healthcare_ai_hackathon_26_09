// Unit tests for the audience split in the bundle (T63, design §2.7, §5.2, §10.6).
//
// `loadBundle` itself is a database query and is exercised by the e2e suite; `patientView` is the pure part
// worth pinning here, because what it drops is the difference between a patient's page and a clinician's
// one. Every field of a PatientBundle is accounted for below on purpose: a field added later lands in one of
// the two lists rather than reaching a patient's browser because nobody thought about it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patientView } from "./bundle";
import type { PatientBundle, Summary } from "./types";

const summary = (patterns: string[], flags?: string[]): Summary => ({
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
  providerSummary: summary(["3 of 4 overnight highs followed dinners out after 8pm"], ["2 readings below 54 mg/dL"]),
  providerSummaryAt: "2026-10-11T12:05:00.000Z",
  patientSummary: summary(["Your evenings out ran high"]),
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
};

describe("patientView", () => {
  const view = patientView(BUNDLE);

  it("keeps everything the patient's own page renders", () => {
    for (const key of ["visitId", "visitStatus", "intakeConsentAt", "patient", "glucose", "visits", "sleep", "spikes", "stats", "status", "intake", "intakeFields", "patientSummary", "patientSummaryAt"] as const) {
      assert.deepEqual(view[key], BUNDLE[key], `${key} is the patient's own`);
    }
  });

  it("hands over none of the clinician's half", () => {
    assert.equal(view.providerSummary, null, "the clinician's patterns, questions and safety flags (§7)");
    assert.equal(view.providerSummaryAt, null);
    assert.equal(view.sourJob, null, "the job's state and its error text (§7.2)");
    assert.equal(view.summaryStale, false);
    assert.equal(view.review, null, "the sign-off is the clinician's record (§7.3)");
  });

  it("leaks nothing through the JSON a patient's browser receives", () => {
    const json = JSON.stringify(view);
    assert.doesNotMatch(json, /overnight highs followed dinners/, "the clinician's narrative");
    assert.doesNotMatch(json, /below 54 mg\/dL/, "a safety flag is phrased for a clinician");
    assert.doesNotMatch(json, /gateway timeout/, "an operational error message");
    // T63's own reason for being here: the provider summary carries why no model wrote the narrative, and
    // that is the practice's deployment state, not the patient's business (§10.6).
    const withState = patientView({ ...BUNDLE, providerSummary: { ...summary([]), narrativeMissing: "unconfigured" } });
    assert.doesNotMatch(JSON.stringify(withState), /narrativeMissing|unconfigured/);
  });

  it("does not touch the bundle it was given, which the provider path still answers with", () => {
    assert.ok(BUNDLE.providerSummary, "the clinician's own response is the whole bundle");
    assert.equal(BUNDLE.review?.byName, "Dr. Demo Endo");
  });
});
