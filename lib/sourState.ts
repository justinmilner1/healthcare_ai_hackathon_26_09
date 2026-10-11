// What the provider page says about a visit's summary (design §7.2). Owner: front end.
//
// Pure on purpose — no database, no model, no React — so the states a clinician can be shown are one
// function with one test (lib/sourState.test.ts) instead of a ladder of ternaries inside JSX. §7.2 names
// three of them (queued, running, failed with a reason) and asks for a retry; the other three are the ones
// a clinician also has to be able to tell apart: a summary that is current, one the data has moved on from
// (§7.1), and a visit nobody has run yet.
//
// Precedence is deliberate: a job that is in flight or has failed outranks whatever summary is on screen,
// because what the clinician needs to know first is whether anything is still coming.

import type { SourJobState } from "./types";

export type SummaryPhase = "none" | "queued" | "running" | "failed" | "ready" | "stale";

export type SummaryState = {
  phase: SummaryPhase;
  /** The word in the chip. */
  label: string;
  /** The sentence beside it. Carries no timestamp of its own; `at` is the time to render, if any. */
  detail: string;
  /** The one time worth showing: when a queued retry comes due, when the attempt started, when it gave up,
   *  or when the summary on screen was written. Null when there is nothing to say. */
  at: string | null;
  /** §7.2: offer the clinician a retry instead of the ordinary Generate button. */
  canRetry: boolean;
  /** A run is in flight, so Generate must not start a second one. */
  busy: boolean;
};

export type SummaryStateInput = {
  job: SourJobState | null;
  hasSummary: boolean;
  /** The saved summary was generated from different intake or uploads than the visit has now (§7.1). */
  stale: boolean;
  summaryAt: string | null;
};

export function summaryState({ job, hasSummary, stale, summaryAt }: SummaryStateInput): SummaryState {
  const of = (attempt: number) => `Attempt ${attempt} of ${job?.maxAttempts ?? 3}`;

  if (job?.status === "queued") {
    // An attempt already spent means this is a retry waiting out its backoff, and the clinician wants the
    // reason far more than the word "queued": it is the same text they would otherwise only see if the third
    // attempt also failed.
    const retrying = job.attempts > 0;
    return {
      phase: "queued",
      label: "Queued",
      detail: retrying
        ? `${of(job.attempts + 1)} after an error — ${job.lastError ?? "no reason recorded"}. Next try`
        : "Waiting for the summary runner.",
      at: retrying ? job.runAfter : null,
      canRetry: false,
      busy: true,
    };
  }

  if (job?.status === "running") {
    return { phase: "running", label: "Running", detail: `${of(Math.max(job.attempts, 1))}, started`, at: job.startedAt, canRetry: false, busy: true };
  }

  if (job?.status === "failed") {
    return {
      phase: "failed",
      label: "Failed",
      detail: `${job.lastError ?? "No reason was recorded"} — gave up after ${job.attempts} of ${job.maxAttempts} attempts.`,
      at: job.finishedAt,
      canRetry: true,
      busy: false,
    };
  }

  // Nothing in flight: the summary on screen is the whole story.
  if (hasSummary && stale) {
    return {
      phase: "stale",
      label: "Out of date",
      detail: "The patient has added intake or files since this summary. Regenerate to include them. Written",
      at: summaryAt,
      canRetry: false,
      busy: false,
    };
  }
  if (hasSummary) return { phase: "ready", label: "Ready", detail: "Written", at: summaryAt, canRetry: false, busy: false };
  return { phase: "none", label: "Not generated", detail: "Nothing has been summarized for this visit yet.", at: null, canRetry: false, busy: false };
}
