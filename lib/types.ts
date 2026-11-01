// Shared shapes. Front end and back end both depend on these. Change with care (see AGENTS.md).
//
// No lib/types.test.ts, and no row in the `npm run test:coverage` table (design §12.1): this file is
// declarations only. TypeScript erases every line of it, so there is nothing at runtime to instrument and
// nothing a test could assert that `npm run typecheck` does not already enforce at every call site.

import type { DexcomConnectControl } from "./dexcomHint";

export type GlucoseReading = { t: string; mgdl: number }; // ISO time

export type Visit = {
  start: string;
  end: string;
  place: string;
  lat: number;
  lng: number;
  placeId?: string;
};

export type Spike = {
  start: string;
  peak: string;
  from: number;
  to: number;
  visit?: Visit;
};

/** `date` is the night the patient went to bed, not the morning the cycle ended; `parseWhoopCsv` in
 *  lib/sleep.ts states the contract and is the one place that decides it (T212). Nothing shifts it. */
export type SleepNight = { date: string; hours: number; recovery?: number };

export type Summary = {
  timeInRange: number; // 0..1, 70..180 mg/dL
  avgGlucose: number;
  spikes: Spike[]; // top 3 to 5, with matched visit when found
  patterns: string[]; // max 3, plain language
  questions: string[]; // max 3, for the doctor to ask
  patientNotes: string; // from Sweetie chat
  flags?: string[]; // deterministic safety flags computed in code (lib/sour.ts safetyFlags), never by the model
  // Why `patterns` and `questions` are empty, when no model could write them (design §6.3, §11.3): either no
  // model is configured for this deployment, or a configured gateway was unreachable. Absent on a narrative
  // the model wrote, and absent from the patient's copy — the provider page renders it as page state beside
  // the §7.2 chip, and the patient's summary simply omits both sections (lib/sourRun.ts, lib/sourState.ts).
  narrativeMissing?: NarrativeMissing;
};

export type NarrativeMissing = "unconfigured" | "unavailable";

export type UploadKind = "dexcom" | "timeline" | "whoop" | "visits";

export type ChatRole = "sweetie" | "patient";
export type ChatMessage = { role: ChatRole; content: string; createdAt?: string };

// Sweetie's structured intake. One entry per field she is trying to fill; the next question targets the
// first required field that is still below "medium". Same shape of idea as a clinical history template.
export type IntakeFieldId = string; // from the visit template: base fields plus visit-type extras (lib/sweetie.ts)
export type Confidence = "unfilled" | "low" | "medium" | "high";
export type IntakeFieldState = { value: string | null; confidence: Confidence };
export type IntakeFieldDef = { id: IntakeFieldId; label: string; goal: string; fallbackQuestion: string; required: boolean };
export type IntakeState = {
  fields: Record<IntakeFieldId, IntakeFieldState>;
  skipped: ("dexcom" | "timeline" | "whoop")[]; // uploads the patient declined or doesn't have; Sweetie stops asking
  flagged: string | null; // red-flag id if the safety scan fired
  turns: number; // patient messages so far
  wrapped: boolean; // Sweetie has said goodbye
  questionsSkipped?: boolean; // patient explicitly chose to finish without more questions
};

// What Sweetie knows about the patient's progress. Drives which question comes next.
export type IntakeStatus = {
  hasDexcom: boolean;
  hasLocation: boolean;
  hasWhoop: boolean;
  answered: number; // how many of Sweetie's questions have an answer
  done: boolean;
};

// Deterministic numbers computed from the full-resolution data (not the downsampled chart series).
export type GlucoseStats = {
  readings: number;
  days: number; // distinct calendar days with readings
  tir: number; // 0..1 in 70..180
  tbr: number; // 0..1 below 70
  tar: number; // 0..1 above 180
  avg: number; // mg/dL
  gmi: number; // glucose management indicator, % (estimated A1c): 3.31 + 0.02392 * avg
  sleepAvgHours: number | null;
  recoveryAvg: number | null;
};

// The state of the `sour.run` job behind a visit's summary, as the provider page shows it (design §7.2).
// Times are ISO strings because this crosses the wire inside PatientBundle. Nothing here is PHI: a job
// payload is a visit id and `lastError` is scrubbed on the way into the row (lib/jobs.ts).
export type SourJobState = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  /** Why the last attempt failed, scrubbed. Set on a retrying job too, not only on a failed one. */
  lastError: string | null;
  /** When a queued job becomes due; a retry is waiting out its backoff until then. */
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

// §7.3 A clinician's sign-off on a visit's summary: who marked it reviewed and when. `byName` is joined at
// read time from the user id (lib/review.ts), never stored beside it, so a renamed account reads correctly
// and a departed one reads as a former colleague rather than as a blank.
export type ReviewRecord = {
  at: string; // ISO time
  by: string | null; // the reviewer's user id
  byName: string; // their name, or their address, in the words the screens print
};

// §7.5 One follow-up question a clinician asked Sour about a visit, and the answer they were given.
// `byName` is joined at read time from the user id (lib/followUps.ts), the same way the sign-off above names
// its reviewer. `answer` is null while a question is on the record unanswered: the row is written before the
// model call, so an outage leaves what was asked rather than losing it.
export type FollowUp = {
  id: string;
  at: string; // ISO time the question was asked
  by: string | null; // the clinician's user id
  byName: string; // their name, or their address, in the words the screens print
  question: string;
  answer: string | null;
};

// Everything a summary page needs in one fetch: GET /api/patient/[id]  (a visit id or the invite token).
// Keyed by the visit (design §4.4): `visitId` is what the pages send back to /api/sour and /api/invite, while
// `patient` describes the person the visit is for.
export type PatientBundle = {
  visitId: string;
  visitStatus: string; // invited | verified | in_intake | intake_done | summary_ready | reviewed | cancelled (§4.4)
  /** When the patient accepted the consent screen (§2.4), or null if they have not been past it yet. */
  intakeConsentAt: string | null;
  patient: {
    id: string;
    name: string;
    token: string;
    isSandbox: boolean;
    apptAt: string | null;
    visitType: string | null;
    reason: string | null;
    notes: string | null;
    provider: { id: string; name: string; practice: string | null };
  };
  glucose: GlucoseReading[]; // downsampled for charts
  visits: Visit[]; // places the patient went (Timeline), not appointments
  sleep: SleepNight[];
  /** The rises the surfaces *list*: the top 5 by rise, matched to places, as `Summary.spikes` is defined
   *  (top 3 to 5). A presentation cut, so nothing may read `.length` as a count of the week's excursions —
   *  `spikeTotal` below is that number (T164). */
  spikes: Spike[];
  /** How many spikes the readings actually contain, before the cut above: a §7 number, code-generated, and
   *  what the clinician's "Spikes > 180" tile and summary line report (§2.6, §7.4). On the seeded demo week
   *  it is 7 where `spikes` holds 5, and the surfaces disclose the difference rather than quietly reporting
   *  the smaller figure (T164). Computed on the full readings, so it cannot be recovered from `glucose`,
   *  which is downsampled for charts. */
  spikeTotal: number;
  stats: GlucoseStats;
  status: IntakeStatus;
  intake: IntakeState;
  intakeFields: IntakeFieldDef[]; // the template Sweetie is working from for this visit
  /** What the patient themselves typed or said during the check-in, oldest first — their chat rows, not
   *  Sweetie's half of the conversation and not `Visit.notes`' rendering of them. The clinician's brief
   *  quotes these when the notes hold no answer of the patient's, which is the ending the §2.5 scan
   *  produces (§2.6, T154; lib/patientWords.ts decides). Their own words, so `patientView` keeps them the
   *  way it keeps the patient's summary and uploads; the page at /patient/[id] reads them from nowhere. */
  patientMessages: string[];
  providerSummary: Summary | null;
  providerSummaryAt: string | null;
  patientSummary: Summary | null;
  patientSummaryAt: string | null;
  /** The newest `sour.run` job for this visit, or null if one has never been queued (§7.2). */
  sourJob: SourJobState | null;
  /** True when a saved summary no longer matches the current intake and uploads, so a run would redo it
   *  rather than return the saved pair (§7.1). False when there is no summary yet. */
  summaryStale: boolean;
  /** The clinician's sign-off, or null while nobody has marked this summary reviewed (§7.3). */
  review: ReviewRecord | null;
  /** §2.3, §5.3, §8.1 Whether a six-digit code can reach this patient at all, so the clinician's two
   *  surfaces cannot tell the office to send a link that will not open (§2.6, §7.4, T183). `canHandOver`'s
   *  answer (lib/notify.ts) over every detail on file — nothing §13.4 forbids, nothing §8.1 has closed, and
   *  a sender behind what is left — settled once in lib/bundle.ts off the same patient row
   *  `POST /api/invite` reads for the brief's invite note, so the note and the empty state under it cannot
   *  answer one patient differently. `lib/sourState.ts` `waitingOnPatientNote` is what reads it. */
  codeCanReach: boolean;
  /** §6.3, §7.5 Whether this deployment has a model at all — `llmStatus().configured`, settled once in
   *  lib/bundle.ts. A fact about the deployment and not about this visit or this practice, and a boolean and
   *  nothing else: §3.7 and §10.6 keep the key, its variable name and the gateway's URL server-side, and
   *  T96's rule holds for whatever is said about it — there is no practice setting to go looking for.
   *
   *  Here because the saved summary cannot answer the question. `Summary.narrativeMissing` is written by a
   *  run, so it reads `undefined` both on a deployment whose model wrote the narrative *and* on every visit
   *  with no summary yet — and the clinician's follow-up composer branched on it, so from the patient's
   *  first answer until the wrap's `sour.run` saved a pair, an unconfigured deployment offered a live Send
   *  that `POST /api/sour` can only answer `LLMUnavailable` to, after §7.5 has written the question to the
   *  visit's follow-up log and §10.2 an audit row for it (T196). Nothing already on the bundle could stand
   *  in: `sourJob` says where a run got to, not whether a model exists. `lib/sourState.ts`
   *  `askSourClosedNote` is what reads it.
   *
   *  `patientView` keeps it, for T183's reason: no patient-facing surface renders it, and `false` on the one
   *  view a patient reaches is a claim rather than an absence. It is not the clinician's half of anything
   *  either — `GET /api/sweetie` already hands the patient's own browser the same boolean as
   *  `agent.connected`, which is what the intake page's "Demo mode" is (app/s/[token]/page.tsx). */
  assistantConfigured: boolean;
  /** Which Dexcom connect control, if any, `/s/<token>` can offer this visit (§2.5, §9.2) — the same
   *  decision lib/dexcomHint.ts makes for the data panel itself. The patient's own summary renders its
   *  empty-state invitation from this, so it cannot promise a connection the destination has not got
   *  (T118). `"none"` on the default offline deployment, where the file upload is the only way in. */
  dexcomConnect: DexcomConnectControl;
};
