// Assemble everything a summary needs from the DB. Used by /api/patient/[id], /api/sour, and Sweetie's status.

import { db } from "./db";
import { averageGlucose, detectSpikes, downsample, timeInRange } from "./glucose";
import { labelVisits } from "./location";
import { matchSpikesToVisits } from "./match";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "./sweetie";
import type { GlucoseReading, GlucoseStats, IntakeStatus, PatientBundle, SleepNight, Spike, Summary, Visit } from "./types";

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

  const intakeFields = fieldsFor(patient.visitType, patient.reason);
  const intake = parseIntake(patient.intake, intakeFields);
  const answered = answeredCount(intake, intakeFields);
  const required = requiredCount(intakeFields);
  const status: IntakeStatus = {
    hasDexcom: glucose.length > 0,
    hasLocation: visits.length > 0,
    hasWhoop: sleep.length > 0,
    answered,
    done: answered >= required || intake.wrapped,
  };

  const pick = (aud: string) => patient.summaries.find((x) => x.audience === aud);
  const prov = pick("provider");
  const pat = pick("patient");

  return {
    patient: {
      id: patient.id,
      name: patient.name,
      token: patient.token,
      apptAt: patient.apptAt?.toISOString() ?? null,
      visitType: patient.visitType,
      reason: patient.reason,
      notes: patient.notes,
      provider: { id: patient.provider.id, name: patient.provider.name, practice: patient.provider.practice },
    },
    glucose: downsample(glucose),
    visits,
    sleep,
    spikes,
    stats: computeStats(glucose, sleep),
    status,
    intake,
    intakeFields,
    providerSummary: prov ? parseOr<Summary | null>(prov.json, null) : null,
    providerSummaryAt: prov?.createdAt.toISOString() ?? null,
    patientSummary: pat ? parseOr<Summary | null>(pat.json, null) : null,
    patientSummaryAt: pat?.createdAt.toISOString() ?? null,
  };
}

export function computeStats(glucose: GlucoseReading[], sleep: SleepNight[]): GlucoseStats {
  const n = glucose.length;
  const avg = averageGlucose(glucose);
  const below = n ? glucose.filter((r) => r.mgdl < 70).length / n : 0;
  const above = n ? glucose.filter((r) => r.mgdl > 180).length / n : 0;
  // Span-based, not distinct UTC dates: a 7-day local export straddles 8 UTC dates.
  const days = n ? Math.max(1, Math.round((Date.parse(glucose[n - 1].t) - Date.parse(glucose[0].t)) / 86400000)) : 0;
  const sleepAvg = sleep.length ? sleep.reduce((s, x) => s + x.hours, 0) / sleep.length : null;
  const recs = sleep.map((x) => x.recovery).filter((x): x is number => typeof x === "number");
  const recAvg = recs.length ? recs.reduce((s, x) => s + x, 0) / recs.length : null;
  return {
    readings: n,
    days,
    tir: round3(timeInRange(glucose)),
    tbr: round3(below),
    tar: round3(above),
    avg,
    gmi: n ? Math.round((3.31 + 0.02392 * avg) * 10) / 10 : 0,
    sleepAvgHours: sleepAvg === null ? null : Math.round(sleepAvg * 10) / 10,
    recoveryAvg: recAvg === null ? null : Math.round(recAvg),
  };
}

/** Deterministic half of the Summary. The LLM adds patterns and questions on top. */
export function baseSummary(glucose: GlucoseReading[], spikes: Spike[], patientNotes: string): Summary {
  return {
    timeInRange: round3(timeInRange(glucose)),
    avgGlucose: averageGlucose(glucose),
    spikes,
    patterns: [],
    questions: [],
    patientNotes,
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function parseOr<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
