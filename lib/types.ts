// Shared shapes. Front end and back end both depend on these. Change with care (see AGENTS.md).

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

// Everything a summary page needs in one fetch: GET /api/patient/[id]  (a visit id or the invite token).
// Keyed by the visit (design §4.4): `visitId` is what the pages send back to /api/sour and /api/invite, while
// `patient` describes the person the visit is for.
export type PatientBundle = {
  visitId: string;
  visitStatus: string; // invited | verified | in_intake | intake_done | summary_ready | reviewed | cancelled (§4.4)
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
};
