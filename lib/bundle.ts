// Assemble everything a summary needs from the DB. Used by /api/patient/[id], /api/sour, and Sweetie's status.

import { db } from "./db";
import { averageGlucose, detectSpikes, downsample, timeInRange } from "./glucose";
import { jobStateView, latestJobForVisit } from "./jobs";
import { llmStatus } from "./llm";
import { labelVisits } from "./location";
import { matchSpikesToVisits } from "./match";
import { narrativeSource, sourInputHash, sourInputsFor } from "./sourInput";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "./sweetie";
import type { GlucoseReading, GlucoseStats, IntakeStatus, PatientBundle, SleepNight, Spike, Summary, Visit } from "./types";
import { providerName } from "./visit";

/**
 * One visit's worth of data, by visit id or by the presigned token in the invite, so /patient/<token> works
 * straight from the link (design §4.4, §5.3). A patient id is not accepted: a patient has many visits, and
 * the bundle is about one of them.
 */
export async function loadBundle(idOrToken: string): Promise<PatientBundle | null> {
  if (!idOrToken) return null;
  const visit = await db.visit.findFirst({
    where: { OR: [{ id: idOrToken }, { token: idOrToken }] },
    include: {
      patient: { include: { practice: true } },
      providerUser: true,
      uploads: { orderBy: { createdAt: "desc" }, include: { data: true } },
      messages: { orderBy: { createdAt: "asc" } },
      summaries: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!visit) return null;

  const latest = (kind: string) => visit.uploads.find((u) => u.kind === kind);
  const glucose = parseOr<GlucoseReading[]>(latest("dexcom")?.data?.parsed, []);
  const rawVisits = parseOr<Visit[]>(latest("timeline")?.data?.parsed, []);
  const labelled = parseOr<Visit[]>(latest("visits")?.data?.parsed, []);
  const visits = rawVisits.length ? labelVisits(rawVisits, labelled) : labelled;
  const sleep = parseOr<SleepNight[]>(latest("whoop")?.data?.parsed, []);

  const spikes: Spike[] = matchSpikesToVisits(detectSpikes(glucose), visits).slice(0, 5);

  const intakeFields = fieldsFor(visit.visitType, visit.isSandbox ? null : visit.reason);
  const intake = parseIntake(visit.intake, intakeFields);
  const answered = answeredCount(intake, intakeFields);
  const required = requiredCount(intakeFields);
  const status: IntakeStatus = {
    hasDexcom: glucose.length > 0,
    hasLocation: visits.length > 0,
    hasWhoop: sleep.length > 0,
    answered,
    done: intake.questionsSkipped === true || answered >= required || intake.wrapped,
  };

  const pick = (aud: string) => visit.summaries.find((x) => x.audience === aud);
  const prov = pick("provider");
  const pat = pick("patient");

  // What the provider page needs to say where the summary got to (§7.2) and whether it still describes the
  // visit (§7.1). The fingerprint is the same function Sour hashes with, so "stale" here and "regenerate"
  // there can never disagree; a summary from a degraded run has no fingerprint and so always reads stale.
  const sourJob = await latestJobForVisit("sour.run", visit.id);
  const inputHash = sourInputHash(sourInputsFor(visit, visit.uploads, narrativeSource(llmStatus().configured)));
  const summaryStale = Boolean(prov) && (prov?.inputHash !== inputHash || pat?.inputHash !== inputHash);

  return {
    visitId: visit.id,
    visitStatus: visit.status,
    intakeConsentAt: visit.intakeConsentAt?.toISOString() ?? null,
    patient: {
      id: visit.patientId,
      name: visit.patient.name,
      token: visit.token,
      isSandbox: visit.isSandbox,
      apptAt: visit.scheduledAt?.toISOString() ?? null,
      visitType: visit.visitType,
      reason: visit.reason,
      notes: visit.notes,
      provider: { id: visit.providerUserId ?? "", name: providerName(visit), practice: visit.patient.practice.name },
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
    sourJob: sourJob ? jobStateView(sourJob) : null,
    summaryStale,
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
