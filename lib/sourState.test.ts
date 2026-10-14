// Unit tests for what the provider page says about a summary (T15, design §7.2).
//
// This walks one job through the transitions a clinician actually watches — queued, the first attempt, a
// failure that will be retried, the backoff wait, giving up, the retry that works — and asserts on the three
// things the page does with each: the word in the chip, whether the reason is in front of the clinician, and
// whether Generate is offered, withheld, or replaced by Retry.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summaryState } from "./sourState";
import type { SourJobState } from "./types";

const JOB: SourJobState = {
  id: "job_1",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  lastError: null,
  runAfter: "2026-10-11T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-10-11T12:00:00.000Z",
};

const job = (patch: Partial<SourJobState> = {}): SourJobState => ({ ...JOB, ...patch });
const view = (j: SourJobState | null, over: { hasSummary?: boolean; stale?: boolean; summaryAt?: string | null } = {}) =>
  summaryState({ job: j, hasSummary: false, stale: false, summaryAt: null, ...over });

describe("summaryState", () => {
  it("has nothing to report before anyone has run Sour", () => {
    const s = view(null);
    assert.equal(s.phase, "none");
    assert.equal(s.label, "Not generated");
    assert.equal(s.busy, false, "Generate is the whole point of this state");
    assert.equal(s.canRetry, false);
    assert.equal(s.at, null);
  });

  it("says queued while the job waits for the runner, and holds Generate shut", () => {
    const s = view(job());
    assert.equal(s.phase, "queued");
    assert.equal(s.label, "Queued");
    assert.equal(s.busy, true, "a second run would be the same work twice");
    assert.equal(s.canRetry, false);
    assert.equal(s.at, null, "there is no backoff to wait out on a first attempt");
  });

  it("says running, with the attempt and when it started", () => {
    const s = view(job({ status: "running", attempts: 1, startedAt: "2026-10-11T12:00:05.000Z" }));
    assert.equal(s.phase, "running");
    assert.equal(s.label, "Running");
    assert.match(s.detail, /Attempt 1 of 3/);
    assert.equal(s.at, "2026-10-11T12:00:05.000Z");
    assert.equal(s.busy, true);
  });

  it("puts the reason in front of the clinician while a retry is still waiting out its backoff", () => {
    // A job between attempts is `queued` again, and "Queued" on its own would hide the one thing worth
    // reading: the error that is about to be retried.
    const s = view(job({ attempts: 1, lastError: "Error: the model gateway did not respond", runAfter: "2026-10-11T12:01:00.000Z" }));
    assert.equal(s.phase, "queued");
    assert.match(s.detail, /Attempt 2 of 3/);
    assert.match(s.detail, /model gateway did not respond/);
    assert.equal(s.at, "2026-10-11T12:01:00.000Z", "the clinician can see when it comes due");
    assert.equal(s.busy, true);
    assert.equal(s.canRetry, false, "the queue is already going to retry this one");
  });

  it("names the failure and offers the retry once the attempts are spent", () => {
    const s = view(job({ status: "failed", attempts: 3, lastError: "Error: visit not found", finishedAt: "2026-10-11T12:06:00.000Z" }));
    assert.equal(s.phase, "failed");
    assert.equal(s.label, "Failed");
    assert.match(s.detail, /visit not found/);
    assert.match(s.detail, /3 of 3 attempts/);
    assert.equal(s.canRetry, true);
    assert.equal(s.busy, false, "nothing is coming unless the clinician asks");
    assert.equal(s.at, "2026-10-11T12:06:00.000Z");
  });

  it("still offers the retry when a job failed without recording why", () => {
    const s = view(job({ status: "failed", attempts: 3 }));
    assert.equal(s.canRetry, true);
    assert.match(s.detail, /No reason was recorded/);
  });

  it("reads ready once the job is done and the summary is on screen", () => {
    const s = view(job({ status: "done", attempts: 1, finishedAt: "2026-10-11T12:00:30.000Z" }), { hasSummary: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "ready");
    assert.equal(s.label, "Ready");
    assert.equal(s.at, "2026-10-11T12:00:29.000Z", "the summary's time, not the job's");
    assert.equal(s.busy, false);
    assert.equal(s.canRetry, false);
  });

  it("reads out of date when the patient has added data since the summary (§7.1)", () => {
    const s = view(job({ status: "done", attempts: 1 }), { hasSummary: true, stale: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "stale");
    assert.equal(s.label, "Out of date");
    assert.match(s.detail, /regenerate to include them/i);
    assert.equal(s.busy, false, "Regenerate must be reachable: that is the whole suggestion");
  });

  it("lets a job in flight outrank the summary already on screen", () => {
    for (const status of ["queued", "running"] as const) {
      const s = view(job({ status, attempts: 1 }), { hasSummary: true, stale: true, summaryAt: "2026-10-11T12:00:29.000Z" });
      assert.equal(s.busy, true, `${status} means something is still coming`);
      assert.notEqual(s.phase, "stale", `${status} is more useful than "regenerate" advice`);
    }
  });

  it("reports a summary with no job at all, which is how a reused one reads after a reload", () => {
    const s = view(null, { hasSummary: true, summaryAt: "2026-10-11T12:00:29.000Z" });
    assert.equal(s.phase, "ready");
    assert.equal(s.at, "2026-10-11T12:00:29.000Z");
  });

  it("does not claim a summary is ready when the job finished without writing one", () => {
    const s = view(job({ status: "done", attempts: 1 }));
    assert.equal(s.phase, "none");
    assert.equal(s.canRetry, false);
  });

  it("falls back to the job's own ceiling rather than hardcoding three", () => {
    const s = view(job({ status: "running", attempts: 2, maxAttempts: 5, startedAt: "2026-10-11T12:00:05.000Z" }));
    assert.match(s.detail, /Attempt 2 of 5/);
  });
});
