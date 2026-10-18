// Shared shapes. Front end and back end both depend on these. Change with care (see AGENTS.md).
//
// No lib/types.test.ts, and no row in the `npm run test:coverage` table (design §12.1): this file is
// declarations only. TypeScript erases every line of it, so there is nothing at runtime to instrument and
// nothing a test could assert that `npm run typecheck` does not already enforce at every call site.

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

export type SleepNight = { date: string; hours: number; recovery?: number };

export type Summary = {
  timeInRange: number; // 0..1, 70..180 mg/dL
  avgGlucose: number;
  spikes: Spike[]; // top 3 to 5, with matched visit when found
  patterns: string[]; // max 3, plain language
  questions: string[]; // max 3, for the doctor to ask
  patientNotes: string; // from Sweetie chat
  flags?: string[]; // deterministic safety flags computed in code (lib/sour.ts safetyFlags), never by the model
};

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
  spikes: Spike[];
  stats: GlucoseStats;
  status: IntakeStatus;
  intake: IntakeState;
  intakeFields: IntakeFieldDef[]; // the template Sweetie is working from for this visit
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
};
