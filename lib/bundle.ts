// Assemble everything a summary needs from the DB. Used by /api/patient/[id], /api/sour, and Sweetie's status.

import { db } from "./db";
import { averageGlucose, detectSpikes, downsample, timeInRange } from "./glucose";
import { labelVisits } from "./location";
import { matchSpikesToVisits } from "./match";
import { SWEETIE_QUESTIONS } from "./prompts";
import type { GlucoseReading, IntakeStatus, PatientBundle, SleepNight, Spike, Summary, Visit } from "./types";

/** Accepts a patient id or their presigned token, so /patient/<token> works straight from the invite link. */
export async function loadBundle(idOrToken: string): Promise<PatientBundle | null> {
  const patient = await db.patient.findFirst({
    where: { OR: [{ id: idOrToken }, { token: idOrToken }] },
    include: {
      provider: true,
      uploads: { orderBy: { createdAt: "desc" } },
      messages: { orderBy: { createdAt: "asc" } },
      summaries: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!patient) return null;

  const latest = (kind: string) => patient.uploads.find((u) => u.kind === kind);
  const glucose = parseOr<GlucoseReading[]>(latest("dexcom")?.parsed, []);
  const rawVisits = parseOr<Visit[]>(latest("timeline")?.parsed, []);
  const labelled = parseOr<Visit[]>(latest("visits")?.parsed, []);
  const visits = rawVisits.length ? labelVisits(rawVisits, labelled) : labelled;
  const sleep = parseOr<SleepNight[]>(latest("whoop")?.parsed, []);

  const spikes: Spike[] = matchSpikesToVisits(detectSpikes(glucose), visits).slice(0, 5);

  const answered = patient.messages.filter((m) => m.role === "patient").length;
  const status: IntakeStatus = {
    hasDexcom: glucose.length > 0,
    hasLocation: visits.length > 0,
    hasWhoop: sleep.length > 0,
    answered: Math.min(answered, SWEETIE_QUESTIONS.length),
    done: glucose.length > 0 && answered >= SWEETIE_QUESTIONS.length,
  };

  const pick = (aud: string) => {
    const s = patient.summaries.find((x) => x.audience === aud);
    return s ? parseOr<Summary | null>(s.json, null) : null;
  };

  return {
    patient: {
      id: patient.id,
      name: patient.name,
      token: patient.token,
      apptAt: patient.apptAt?.toISOString() ?? null,
      notes: patient.notes,
      provider: { id: patient.provider.id, name: patient.provider.name, practice: patient.provider.practice },
    },
    glucose: downsample(glucose),
    visits,
    sleep,
    spikes,
    status,
    providerSummary: pick("provider"),
    patientSummary: pick("patient"),
  };
}

/** Deterministic half of the Summary. The LLM adds patterns and questions on top. */
export function baseSummary(glucose: GlucoseReading[], spikes: Spike[], patientNotes: string): Summary {
  return {
    timeInRange: Math.round(timeInRange(glucose) * 1000) / 1000,
    avgGlucose: averageGlucose(glucose),
    spikes,
    patterns: [],
    questions: [],
    patientNotes,
  };
}

function parseOr<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
