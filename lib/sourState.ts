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

import type { NarrativeMissing, SourJobState } from "./types";

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
      detail: "The patient has added intake or files since this summary — regenerate to include them. This one was written",
      at: summaryAt,
      canRetry: false,
      busy: false,
    };
  }
  if (hasSummary) return { phase: "ready", label: "Ready", detail: "Written", at: summaryAt, canRetry: false, busy: false };
  return { phase: "none", label: "Not generated", detail: "Nothing has been summarized for this visit yet.", at: null, canRetry: false, busy: false };
}

/**
 * Why this summary has no patterns and no questions, for the line beside the chip (§6.3, §7.2, §11.3).
 *
 * Here rather than in the JSX for the same reason as everything above it: the provider page and the printed
 * sheet both say it, and §6.3's "quiet note" is one sentence that should read the same in both places —
 * which is also why neither sentence says "above" or "below": the screen puts it over the numbers and the
 * sheet puts it under them. Null for a summary the model wrote, which is every summary on a deployment with
 * a working gateway.
 *
 * Neither sentence names an environment variable or tells anyone to go and set one: the patient reads a
 * version of this screen (§2.7) and a clinician cannot fix a deployment from the exam room. What the
 * clinician gets is which of the two it is — one clears on its own, the other does not clear from inside
 * the product at all — and the assurance that the numbers are complete, because they are: lib/sour.ts
 * computes them.
 *
 * Nor does either sentence promise a remedy nobody has (T96). `Practice` is `name`, `retentionDays` and
 * `isDemo` (prisma/schema.prisma) and the settings page offers the first two, so there is no assistant to
 * enable for a practice and no administrator who can enable one: whether a narrative is written is
 * `OPENAI_API_KEY` and `BEDROCK_OPENAI_MODEL_ID`, which §3.7 and §10.6 make the deployment's and SSM
 * Parameter Store's. The person to name is therefore the one lib/delivery.ts names for a sender nobody has
 * configured — whoever set Sweet Spot up for the office — and the note says outright that no practice
 * setting is the answer, so a clinician does not go looking for one in Settings.
 */
export function narrativeNote(missing: NarrativeMissing | undefined): string | null {
  if (missing === "unavailable") {
    // T63 keeps this wording: a clinician can act on it, and a minute later the retry may well work.
    return "Model gateway unavailable: the numbers are complete; patterns and questions were not generated. Retry in a minute.";
  }
  if (missing === "unconfigured") {
    // T96: the state, and then the one true thing a reader can do about it — shaped like the sibling above,
    // because §6.3 asks for a note that says what the state is and not one that invents a control.
    return "Assistant not configured: the numbers are complete; patterns and questions were not generated. No practice setting turns this on — ask whoever set Sweet Spot up for your office.";
  }
  return null;
}

/** What an empty Patterns or Ask-the-patient list says: "None found." is a finding, and a run with no
 *  narrative has not looked (§6.3). */
export const emptyNarrativeText = (missing: NarrativeMissing | undefined, found: string): string =>
  missing ? "Not generated." : found;
