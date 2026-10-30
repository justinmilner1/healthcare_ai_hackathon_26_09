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
 * What stands where the "Discuss with Sour" composer was, on a deployment with no assistant to ask
 * (T195, design §7.5, §6.3, §2.6). Null is "offer the composer", which is most deployments.
 *
 * `askSourPlaceholder` above keeps the box from offering a subject this visit has no data for. This is the
 * same question one step out: not what the box may be asked about, but whether it may be asked at all. With
 * no model configured the brief says so at the top — `narrativeNote("unconfigured")` — and then offered an
 * inviting placeholder and a live Send four cards below it. Pressing it cannot work: `POST /api/sour`
 * answers `LLMUnavailable`. And the attempt is not free, which is why this is a bug and not a blemish: §7.5
 * writes the question to the visit's follow-up log *before* the model is asked, and §10.2 writes an audit
 * row for it, so every press left a question on the visit for the practice to read as one Sour never
 * answered — and a clinician learnt that only by pressing it.
 *
 * Only the `"unconfigured"` half. The two values of `NarrativeMissing` are not alike, which `narrativeNote`
 * above is explicit about: `"unavailable"` is a gateway that clears on its own, so a retry is worth
 * offering and the composer stays exactly as it is (T63). `"unconfigured"` does not clear from inside the
 * product at all, so there the control can never do anything.
 *
 * **Why the summary is not the whole of the question (T196).** `narrativeMissing` is written by a run, so it
 * only exists once a summary has been saved — and before that it is `undefined`, which is the same value it
 * carries on a deployment whose model *did* write the narrative. So the one signal meant two opposite
 * things, and T195's withdrawal had a window it could not see: from the patient's first answer (or their
 * Dexcom export) until the wrap's `sour.run` saved a pair, `visitNotStarted` above is already false, the
 * card is rendered, and an unconfigured deployment offered a placeholder and a live Send again. The press is
 * not free there either — `loadSourContext` builds a brief with or without a saved `Summary` row
 * (lib/sourRun.ts), so §7.5 writes the question to the follow-up log and §10.2 an audit row for it, and
 * *then* the model is asked and answers `LLMUnavailable`. Same harm as T195's, one state earlier.
 *
 * So the deployment answers it: `assistantConfigured` off the bundle (lib/bundle.ts), which is a fact about
 * the deployment rather than about any run of it, and the only thing on the wire that can speak for the
 * window with no summary in it. Nothing already there could be read instead — "no summary yet" is not "no
 * model", and reading it that way would take a working composer off every fresh visit on a configured
 * deployment; `sourJob` says where a run got to, not whether a model exists.
 *
 * It is `||` and not a replacement, because the two inputs answer the same question about two different
 * moments and either one saying "no model" is a reason not to offer the control: the boolean is the state
 * the press will actually meet, and the saved `"unconfigured"` is what the last run met, which keeps T195's
 * withdrawal to the letter. The one combination they disagree on — a narrative a model wrote on a
 * deployment whose model has since gone — withdraws, which is the truthful answer about what pressing Send
 * would now do.
 *
 * The sentence is the same one in both windows, deliberately. It reads as the standing state either way,
 * and one wording is what keeps the two states from drifting apart (T195). What differs is its
 * surroundings: `narrativeNote` above is about why a *saved* summary has no patterns and no questions, so
 * with no summary yet there is nothing for it to explain and the brief carries this sentence alone, without
 * the caveat at the top that normally names whoever set Sweet Spot up for the office.
 *
 * §6.3 is not an argument the other way. The quiet note it asks for comes with "questions continue", and
 * they do — on Sweetie, where lib/sweetie.ts answers from a scripted path with no model at all. This
 * composer has no scripted fallback to continue with: there is nothing for it to say. So withdrawing it is
 * what §6.3 asks for here rather than a departure from it.
 *
 * The sentence is shaped like its sibling above and holds to the same two rules: it names no environment
 * variable, and it invents no practice setting for anybody to go looking for in Settings (T96). It does not
 * repeat "ask whoever set Sweet Spot up for your office" — the caveat at the top of this same brief says
 * that, and what this sentence is about is the one control being withdrawn. Nor does it tell anyone to
 * retry, because this is the state a retry does not reach.
 *
 * It withdraws the offer and not the record: follow-ups already on the visit stay on the page in both
 * states (§7.5), which is the page's job rather than this sentence's.
 */
export type AskSourInput = {
  /** The saved summary's `narrativeMissing`. `undefined` is two different things — a narrative a model
   *  wrote, and no summary at all — which is why it is not the whole of the question (T196). */
  missing: NarrativeMissing | undefined;
  /** `PatientBundle.assistantConfigured`: whether this deployment has a model at all. */
  assistantConfigured: boolean;
};

export function askSourClosedNote({ missing, assistantConfigured }: AskSourInput): string | null {
  if (assistantConfigured && missing !== "unconfigured") return null;
  return "Assistant not configured: there is no model to answer a question, so none can be asked on this visit.";
}

/**
 * The sub-line under the "Discuss with Sour" heading (design §7.5, T195).
 *
 * A function of the same state as the note above, for the reason T153 gave for the placeholder and T156 for
 * the sidebar heading: a claim about the page written as a constant while what it describes branches. The
 * constant read "Ask about this patient's data · questions are kept with the visit and shown to this
 * practice", so on an unconfigured deployment the card's own heading invited what the sentence in its body
 * says cannot be done. What the closed state drops is that invitation and nothing else: the second clause
 * is true either way and is the one §7.5 makes about the log, which is what the card holds now.
 *
 * It is the clause unchanged rather than a rewording of it, because the card is just as often empty as not
 * — a brief nobody has asked anything about — and "questions already asked are kept" over no rows at all
 * describes a set that is not there. "Questions are kept" reads as the standing rule it is, with rows or
 * without.
 */
export function askSourSubheading(input: AskSourInput): string {
  return askSourClosedNote(input)
    ? "Questions are kept with the visit and shown to this practice"
    : "Ask about this patient’s data · questions are kept with the visit and shown to this practice";
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

/**
 * How the "waiting on the patient" block ends, on both of the clinician's surfaces (design §2.3, §2.6,
 * §5.3, §7.4, §8.1, T183).
 *
 * The lead sentence differs between the two — the brief says what there is nothing to summarize *until*,
 * the sheet says what the patient has not done — but the sentence after it was the same literal in both
 * (`EmptyIntake` in app/provider/[id]/sour.tsx, the `sour-print-empty` card in
 * app/provider/visit/[id]/print/page.tsx): *"Send the link again if they have not opened it."*
 *
 * That instruction rests on the link opening, and the link opens on a six-digit code reaching the patient
 * (§2.3, §5.3). Where no channel between them and a code is open, sending it again does nothing, and the
 * brief said so four inches apart from itself: the invite note above it ends on `NO_HANDOVER_SENTENCE`
 * (lib/delivery.ts) — "Handing the link over will not get this patient in either." — over an empty state
 * still telling the clinician to send the link. T140, T168, T170, T173, T175, T177 and T179 are the same
 * disagreement on the other six surfaces; this was the one no rule in `lib/` could reach, because both
 * lines were static JSX on `visitNotStarted`'s branch above, which asks whether there is anything to
 * summarize and nothing about whether the patient can be reached.
 *
 * So it is one function, read by both surfaces, the way `visitNotStarted` and `narrativeNote` already are.
 * `codeCanReach` is `canHandOver`'s answer (lib/notify.ts), carried on `PatientBundle` and settled once in
 * lib/bundle.ts off the patient row `POST /api/invite` reads for the note above — so the two elements
 * cannot answer one patient differently.
 *
 * **What the second sentence is, and is not.** Where the link can open the instruction is right and is
 * unchanged, to the word. Where it cannot, this *withdraws an instruction* rather than an offer, which is
 * why it is not `NO_HANDOVER_SENTENCE` itself: the other six surfaces are taking back "hand the link over
 * yourself", and nobody offered to hand anything over here. It also names no remedy — the clinician's
 * brief is not where a dead link gets fixed, and the one remedy there is belongs to the dashboard row that
 * owns the visit's contact details (`NO_CODE_CAN_REACH`, "call them", lib/delivery.ts): the T170 split, so
 * one surface states the consequence and one offers the fix, rather than both doing half of each. And, like
 * `narrativeNote` above, it names no variable, no backend and no administrator (§3.7, §10.6) — a clinician
 * cannot fix a deployment from the exam room.
 */
export function waitingOnPatientNote(codeCanReach: boolean): string {
  if (codeCanReach) return "Send the link again if they have not opened it.";
  return "Sending the link again will not open it for this patient.";
}
