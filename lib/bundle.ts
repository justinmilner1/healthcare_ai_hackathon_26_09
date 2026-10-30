// Assemble everything a summary needs from the DB. Used by /api/patient/[id], /api/sour, and Sweetie's status.

import { db } from "./db";
import { configured as dexcomConfigured, currentDexcomEnv, visitMatchesEnv } from "./dexcom";
import { dexcomConnectControl } from "./dexcomHint";
import { averageGlucose, detectSpikes, downsample, timeInRange } from "./glucose";
import { jobStateView, latestJobForVisit } from "./jobs";
import { llmStatus } from "./llm";
import { labelVisits } from "./location";
import { matchSpikesToVisits } from "./match";
import { canHandOver } from "./notify";
import { reviewRecord } from "./review";
import { narrativeSource, sourInputHash, sourInputsFor } from "./sourInput";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "./sweetie";
import type { GlucoseReading, GlucoseStats, IntakeStatus, PatientBundle, SleepNight, Spike, Summary, Visit } from "./types";
import { providerName } from "./visit";

/**
 * How many rises the spike table lists: the upper end of `Summary.spikes`' "top 3 to 5" (lib/types.ts).
 *
 * A cut for the table, and nothing else. It is exported so the clinician's surfaces can say "top 5 shown"
 * without a second literal 5 going stale beside this one (lib/spikePlaces.ts reads the length of the list
 * it is handed, which is this); the count a clinician reads off the tile is `PatientBundle.spikeTotal`,
 * which this does not touch (T164).
 */
export const SPIKES_SHOWN = 5;

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

  // Two numbers out of one detection, because the cut is a presentation choice and the count is not (T164).
  // `detectSpikes` sorts by rise descending, so the slice is the top five; `spikeTotal` is what the week
  // actually holds, which is the figure §7 makes code-generated so a clinician can trust it. Detected on the
  // full readings — `glucose` above is handed to the page downsampled, and a cheaper recount there would
  // quietly answer a different question.
  const allSpikes = matchSpikesToVisits(detectSpikes(glucose), visits);
  const spikes: Spike[] = allSpikes.slice(0, SPIKES_SHOWN);

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
  // §2.5, §9.2 Which connect control this visit's data panel has, so the patient's own summary can invite
  // them to something that will be there when they arrive (T118). The same inputs GET /api/dexcom/status
  // answers with, read here because a page renders from the bundle and never from Prisma (AGENTS.md).
  const dexcomEnv = currentDexcomEnv();
  const dexcomConnect = dexcomConnectControl({
    env: dexcomEnv,
    configured: dexcomConfigured(),
    canConnect: visitMatchesEnv(visit, dexcomEnv),
    sandboxPatient: visit.isSandbox,
  });

  // §2.3, §5.3, §8.1, T183 Whether a six-digit code can reach this patient at all, which is what the
  // clinician's "waiting on the patient" block needs before it tells the office to send the link again
  // (lib/sourState.ts `waitingOnPatientNote`). `canHandOver` is the whole question — §13.4's demo rule,
  // §8.1's suppressions, and then whether this deployment has a sender behind what is left — and these are
  // the same four facts, off the same row, that `POST /api/invite` answers `handover` with for the invite
  // note on the same screen (app/api/invite/route.ts). One reading rather than two that can disagree, and
  // no extra query: `patient: { include: { practice: true } }` above has already loaded the phone, the
  // email, §8.1's three suppression columns and `practice.isDemo`. `visit.patient` is passed whole as
  // `suppression`, as the route passes it, because those three columns live on it (lib/suppression.ts).
  const codeCanReach = canHandOver({
    phone: visit.patient.phone,
    email: visit.patient.email,
    suppression: visit.patient,
    demo: visit.patient.practice.isDemo,
  });

  const sourJob = await latestJobForVisit("sour.run", visit.id);
  // §6.3, §7.5, T196 One reading of the deployment's model state, for the two things on this bundle that
  // depend on it: §7.1's fingerprint below, which records which kind of run wrote a summary, and
  // `assistantConfigured`, which is whether the clinician's follow-up composer can be offered at all
  // (lib/sourState.ts `askSourClosedNote`). The saved summary cannot answer the second question —
  // `narrativeMissing` is `undefined` both on a narrative a model wrote and on every visit with no summary
  // yet — so it is a fact about the deployment, read here because a page renders from the bundle and never
  // from Prisma or from `process.env` (AGENTS.md). A boolean and nothing else: §3.7 and §10.6 keep the key,
  // its variable name and the gateway's URL server-side.
  const llm = llmStatus();
  const inputHash = sourInputHash(sourInputsFor(visit, visit.uploads, narrativeSource(llm.configured)));
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
    spikeTotal: allSpikes.length,
    stats: computeStats(glucose, sleep),
    status,
    intake,
    intakeFields,
    // §2.6, T154: the patient's own half of the transcript, for the brief's "In the patient's words" block.
    // Sweetie's half is not in it — the clinician is reading what the patient said, not what was asked —
    // and the rows are already in the query above, so this costs nothing.
    patientMessages: visit.messages.filter((m) => m.role === "patient").map((m) => m.content),
    providerSummary: prov ? parseOr<Summary | null>(prov.json, null) : null,
    providerSummaryAt: prov?.createdAt.toISOString() ?? null,
    patientSummary: pat ? parseOr<Summary | null>(pat.json, null) : null,
    patientSummaryAt: pat?.createdAt.toISOString() ?? null,
    sourJob: sourJob ? jobStateView(sourJob) : null,
    summaryStale,
    // §7.3: the sign-off on the row, with the reviewer's name joined on (lib/review.ts). One extra query,
    // and only for a visit that has actually been reviewed.
    review: await reviewRecord(visit),
    codeCanReach,
    assistantConfigured: llm.configured,
    dexcomConnect,
  };
}

/**
 * The same bundle with the clinician's half taken out, for a request that authenticated with a patient's
 * token rather than a provider session (§2.7, §5.2, §10.6).
 *
 * `loadBundle` builds one object for two audiences, and /api/patient/[id] answers both from it, so without
 * this the patient's browser is handed the provider summary — the clinician's patterns and questions, the
 * safety flags §7 keeps for the clinician, the summary job's state and error, and the sign-off — none of
 * which belongs in a patient-facing response. The patient's own summary (`patientSummary`), their numbers,
 * their uploads and their intake all stay: the page at /patient/[id] reads nothing else.
 *
 * Blanked rather than deleted, so this is still a `PatientBundle` and the page keeps one shape to render.
 *
 * **`codeCanReach` stays** (T183), stated here because the ticket asked for the decision either way. Three
 * reasons, and the first is the strongest: §2.3 already tells the patient this fact in their own words, on
 * the code screen their link lands on — `components/VerifyGate.tsx` reads the same `codeReach` and says
 * "there is nowhere to send your 6-digit code. Please call <practice>" — so there is nothing here a patient
 * cannot already be told about their own contact details. It is also not the clinician's half of anything:
 * `providerSummary`, `sourJob` and `review` go because they are material §5.2 and §7 write *for* a
 * clinician, and this is a fact about the patient. And blanking a boolean is not an absence but a claim:
 * `false` on the one view a patient reaches *by having opened their link* would be the wrong one. No
 * patient-facing surface renders it — `waitingOnPatientNote` is the clinician's two — so it travels unread,
 * the way `visitStatus` and `intakeFields` do.
 *
 * **`assistantConfigured` stays too**, on the same three reasons (T196). `GET /api/sweetie` already hands
 * the patient's own browser the identical boolean as `agent.connected`, and their intake page renders
 * "Demo mode" off it (app/s/[token]/page.tsx), so it tells a patient nothing they are not already told. It
 * is a fact about the deployment rather than the clinician's half of anything — unlike `providerSummary`,
 * `sourJob` and `review`, which are material §5.2 and §7 write *for* a clinician. And `false` would be a
 * claim and not an absence: the one surface that reads it is the brief's composer, which no patient view
 * renders.
 */
export function patientView(bundle: PatientBundle): PatientBundle {
  return { ...bundle, providerSummary: null, providerSummaryAt: null, sourJob: null, summaryStale: false, review: null };
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
