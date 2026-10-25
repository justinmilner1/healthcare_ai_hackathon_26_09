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

import type { IntakeState, IntakeStatus, NarrativeMissing, SourJobState } from "./types";

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
 * Has the patient not started this visit at all? (design §2.6, T143, T148)
 *
 * The one state the provider page has nothing to render and nothing to generate: a visit that was booked and
 * then sat there. Both of the clinician's surfaces ask it — the brief
 * (app/provider/[id]/sour.tsx, which shows `EmptyIntake` and disables Generate on it) and the printed
 * one-pager (app/provider/visit/[id]/print/page.tsx, "Nothing to summarize yet") — so it is one function
 * here rather than the same expression written twice, which is how the two drifted from the queue's own
 * idea of empty (lib/sourQueue.ts `wrapQueuesSour`).
 *
 * `wrapped` is the part T148 added, and it is the whole of the bug. A check-in the §2.5 safety scan flagged
 * on the patient's *first* message wraps (lib/sweetieTurn.ts) with every field still `unfilled`, so
 * `answered` is 0; with no upload either, the predicate without `wrapped` called that visit empty — while
 * the wrap had queued a `sour.run`, `runSour` had saved both summaries and §2.6's "the clinician is emailed
 * a link" had already gone out. The clinician followed that link to "Waiting on the patient / Nothing to
 * summarize until the patient has talked to Sweetie", over a brief that existed, about a patient who had
 * described chest pain. A wrap is Sweetie's goodbye: whatever is behind it is what the visit has to say, and
 * the brief written from it is what §2.6 puts in front of the clinician, however thin. A skip wraps too
 * (lib/sweetie.ts sets `questionsSkipped` *and* `wrapped`), so this covers that ending with no second flag
 * to read.
 *
 * `hasDexcom` is the data half and stays as it was: glucose is what a brief is mostly made of, and a visit
 * with readings has one whether anybody talked to Sweetie or not. The other two exports are not in it for
 * the same reason they are not in the brief's own branches — a Timeline with no readings to match against
 * is nothing for Sour to say anything about.
 *
 * Deliberately not `visitStatus`: `invited` and `verified` are the statuses this is true in, but a patient
 * mid-interview is `in_intake` with an answer or two in, which is not empty, and the wrap's own status write
 * is a different commit from the intake it wraps (app/api/sweetie/route.ts). The fields and the uploads are
 * what the two surfaces render, so they are what decides whether there is anything to render.
 */
export const visitNotStarted = (b: {
  intake: Pick<IntakeState, "wrapped">;
  status: Pick<IntakeStatus, "answered" | "hasDexcom">;
}): boolean => !b.intake.wrapped && b.status.answered === 0 && !b.status.hasDexcom;

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

/**
 * What the "Discuss with Sour" composer offers to be asked about (design §2.6, §7.5, T153).
 *
 * The placeholder was a constant naming both exports, so a conversation-only brief read
 * "No glucose data was shared. This summary is from the conversation only." four elements above a box
 * inviting a question about "the glucose spikes or sleep data" — the page contradicting itself in one
 * screenful. Every other element of the brief already branches on `bundle.status`: the no-glucose notice,
 * the metrics card, the chart, the spike and sleep pair (app/provider/[id]/sour.tsx). This was the one that
 * did not, which is why the wording is a function of the same two booleans rather than a string in the JSX —
 * it cannot drift from what the page shows.
 *
 * It is worth branching rather than generalising because of what §7.5 does with the answer: a suggested
 * question about data the visit does not have is one Sour can only answer with "there is no glucose data",
 * and that exchange is then kept on the visit and shown to the practice. With neither export the material is
 * what the patient said — which is the whole of a conversation-only brief — so that is what the box offers
 * instead of an upload the visit never had.
 *
 * `hasLocation` is deliberately not one of the two. A Timeline with no readings to match against is nothing
 * for Sour to say anything about (the same reason `visitNotStarted` above leaves it out), and its places
 * reach the clinician as the place beside a spike rather than as a subject of their own.
 */
export function askSourPlaceholder(status: Pick<IntakeStatus, "hasDexcom" | "hasWhoop">): string {
  if (status.hasDexcom && status.hasWhoop) return "Ask about the glucose spikes or sleep data…";
  if (status.hasDexcom) return "Ask about the glucose spikes…";
  if (status.hasWhoop) return "Ask about the sleep data…";
  return "Ask about what the patient said…";
}

/**
 * The heading over the Sour sidebar's visit list (design §7.2, §2.6, T156).
 *
 * The list is "every visit with a summary, plus the one you are looking at" — the second half is there so a
 * clinician sent here by the dashboard's **Summarize** button can see which visit they are on
 * (app/provider/dashboard.tsx offers that link on any visit with a Dexcom export or an answered question,
 * which is exactly a visit with no summary). The heading over it was the constant "Summaries ready", so that
 * ordinary click produced a sidebar headed SUMMARIES READY whose first row was a visit the panel beside it
 * called NOT GENERATED. The only thing marking the row was the *absence* of the tick.
 *
 * Same shape as T153's placeholder one element over: a claim about the page written as a constant while
 * everything around it branches. So the wording is a function of the list — of the same `hasSummary` the
 * rows and the tick read — and cannot drift from what is under it.
 *
 * Four readings, because the list has four shapes. At most one row can lack a summary (only the selected
 * visit joins the list without one), so the mixed heading can name it in the singular:
 *
 * | the list | heading |
 * |---|---|
 * | every row has a summary | `Summaries ready` |
 * | the selected row has none, others do | `This visit · summaries ready` |
 * | the selected row is the only row, and has none | `This visit` |
 * | empty | `Summaries` |
 *
 * The empty case is a heading over the sentence at the foot of the list ("No summaries yet."), which says
 * the state already and keeps saying it; the heading above it just stops claiming the opposite.
 */
export function summaryListHeading(rows: readonly { hasSummary: boolean }[]): string {
  if (rows.length === 0) return "Summaries";
  const ready = rows.filter((r) => r.hasSummary).length;
  if (ready === rows.length) return "Summaries ready";
  if (ready === 0) return "This visit";
  return "This visit · summaries ready";
}
