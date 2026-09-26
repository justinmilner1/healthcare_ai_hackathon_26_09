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
};

export type UploadKind = "dexcom" | "timeline" | "whoop" | "visits";

export type ChatRole = "sweetie" | "patient";
export type ChatMessage = { role: ChatRole; content: string; createdAt?: string };

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

// Everything a summary page needs in one fetch: GET /api/patient/[id]  (id or presigned token)
export type PatientBundle = {
  patient: {
    id: string;
    name: string;
    token: string;
    apptAt: string | null;
    notes: string | null;
    provider: { id: string; name: string; practice: string | null };
  };
  glucose: GlucoseReading[]; // downsampled for charts
  visits: Visit[];
  sleep: SleepNight[];
  spikes: Spike[];
  stats: GlucoseStats;
  status: IntakeStatus;
  providerSummary: Summary | null;
  providerSummaryAt: string | null;
  patientSummary: Summary | null;
  patientSummaryAt: string | null;
};
