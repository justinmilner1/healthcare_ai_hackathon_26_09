// Run Sour for one visit: build the brief, write both summaries, save them, queue the "it's ready" links.
// Called from the `sour.run` job handler (design §7.1), which is what POST /api/sour enqueues for the
// provider page's Generate button and what the Sweetie route enqueues the moment intake wraps up, so the
// doctor's email is on its way while the patient is still in the chat. Owner: Justin.

import type { PrismaClient } from "@prisma/client";
import { baseSummary, loadBundle } from "./bundle";
import { db } from "./db";
import { enqueue } from "./jobs";
import { ask, llmStatus, LLMUnavailable } from "./llm";
import { log } from "./log";
import { patientSummarySystem, sourSystem } from "./prompts";
import { buildSourInput, renderSourInput, safetyFlags } from "./sour";
import { narrativeSource, sourInputHash, sourInputsFor, type SourUploadRef } from "./sourInput";
import type { GlucoseReading, NarrativeMissing, PatientBundle, Summary } from "./types";
import { findVisit } from "./visit";

type Narrative = { patterns: string[]; questions: string[] };

export type SourContext = {
  visitId: string;
  bundle: PatientBundle;
  glucose: GlucoseReading[];
  notes: string;
  base: Summary;
  brief: string;
  flags: string[];
  /** The fingerprint of the intake and uploads this brief was built from (§7.1, lib/sourInput.ts). */
  inputHash: string;
};

const clean = (xs: unknown, n: number) =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, n) : [];

/** Everything Sour needs about one visit, computed once. Null if nothing matches. Takes a visit id or the
 *  invite token (design §4.4). */
export async function loadSourContext(idOrToken: string): Promise<SourContext | null> {
  const visit = await findVisit(idOrToken);
  if (!visit) return null;
  const bundle = await loadBundle(visit.id);
  if (!bundle) return null;
  // Full-resolution glucose for the numbers (bundle.glucose is downsampled for charts).
  const dex = await db.upload.findFirst({ where: { visitId: visit.id, kind: "dexcom" }, orderBy: { createdAt: "desc" }, include: { data: true } });
  const glucose: GlucoseReading[] = dex?.data ? (JSON.parse(dex.data.parsed) as GlucoseReading[]) : [];
  const notes = bundle.patient.notes ?? "";
  const flags = safetyFlags(glucose);
  const base: Summary = { ...baseSummary(glucose, bundle.spikes, notes), flags };
  const brief = (bundle.patient.isSandbox ? "SYNTHETIC DEXCOM SANDBOX DATA — demonstration only, not real patient findings.\n" : "") + renderSourInput(
    buildSourInput({ glucose, spikes: bundle.spikes, sleep: bundle.sleep, patientNotes: notes, visit: { type: bundle.patient.visitType, reason: bundle.patient.reason } }),
  );
  const inputHash = sourInputHash(sourInputsFor(visit, await uploadRefs(visit.id), narrativeSource(llmStatus().configured)));
  return { visitId: visit.id, bundle, glucose, notes, base, brief, flags, inputHash };
}

/** Every upload of a visit as the fingerprint sees it: ids and row counts, not the parsed rows, so this stays
 *  a small query even for a week of five-minute readings. */
export async function uploadRefs(visitId: string, client: SummaryClient = db): Promise<SourUploadRef[]> {
  return client.upload.findMany({ where: { visitId }, select: { id: true, kind: true, parsedRows: true } });
}

/** The parts of the client the saved-summary lookup uses, so a test can hand it one pointed at a fixture
 *  schema (lib/sourRun.test.ts) the way the queue tests do. */
export type SummaryClient = Pick<PrismaClient, "summary" | "upload">;

export type SavedSummaries = { provider: Summary; patient: Summary; createdAt: Date; summaryIds: string[] };

/**
 * The saved summary pair for this visit, if it was generated from exactly these inputs (§7.1).
 *
 * Deliberately the *newest* pair and nothing older: the provider page renders the newest row per audience, so
 * returning an older matching pair would hand the clinician one thing and show them another. Both audiences
 * must match, because `notify.summary` sends a link to each and half a pair is not a summary. A null
 * `inputHash` on either row never matches, which is how a placeholder from a degraded run is kept out.
 */
export async function existingSummaryFor(visitId: string, inputHash: string, client: SummaryClient = db): Promise<SavedSummaries | null> {
  if (!inputHash) return null;
  const rows = await client.summary.findMany({ where: { visitId }, orderBy: { createdAt: "desc" } });
  const newest = (audience: string) => rows.find((r) => r.audience === audience);
  const provider = newest("provider");
  const patient = newest("patient");
  if (!provider || !patient) return null;
  if (provider.inputHash !== inputHash || patient.inputHash !== inputHash) return null;
  try {
    return {
      provider: JSON.parse(provider.json) as Summary,
      patient: JSON.parse(patient.json) as Summary,
      createdAt: provider.createdAt,
      summaryIds: [provider.id, patient.id],
    };
  } catch {
    // A row we cannot read is not a summary we can return; fall through and generate a fresh one.
    return null;
  }
}

export type SourRunResult = {
  provider: Summary;
  patient: Summary;
  /** The notify.summary job that will send the two links, or why no message is going out (§8.2). */
  notified: { queued: string } | { skipped: string };
  /** True when the inputs had not changed, so the saved pair came back instead of two model calls (§7.1). */
  reused: boolean;
};

export type RunSourOptions = {
  /** A context already loaded by the caller, so a route does not pay for the brief twice. */
  ctx?: SourContext;
  /** Writes the two narratives. Injected only by the unit tests, which have no model gateway. */
  narrate?: Narrator;
};

/** What the model is asked for, in the order it is asked: the clinician's narrative, then the patient's. */
export type Narrator = (c: SourContext) => Promise<{ provider: Narrative; patient: Narrative }>;

/**
 * Generate, save, and notify. Never throws for a missing model; does throw for a missing visit.
 *
 * Idempotent per visit and input hash (§7.1): if the intake and the uploads are exactly what the saved
 * summary was made from, that pair comes straight back. No second pair of rows, no second pair of model
 * calls, and no second "your summary is ready" email for a summary the clinician was already told about.
 */
export async function runSour(idOrToken: string, opts: RunSourOptions = {}): Promise<SourRunResult> {
  const c = opts.ctx ?? (await loadSourContext(idOrToken));
  if (!c) throw new Error("visit not found");
  const { bundle, base, flags } = c;

  const saved = await existingSummaryFor(c.visitId, c.inputHash);
  if (saved) {
    log.info("sour_reused", { visitId: c.visitId, summaryId: saved.summaryIds[0] });
    await markSummaryReady(c.visitId);
    return { provider: saved.provider, patient: saved.patient, notified: { skipped: "Inputs unchanged: the saved summary was reused" }, reused: true };
  }

  let provider: Summary;
  let patient: Summary;
  let llmOk = true;
  try {
    const n = await (opts.narrate ?? modelNarrator)(c);
    provider = { ...base, patterns: clean(n.provider.patterns, 3), questions: clean(n.provider.questions, 3), flags };
    // Safety flags are for the clinician; the patient version carries none.
    patient = { ...base, patterns: clean(n.patient.patterns, 3), questions: clean(n.patient.questions, 3), flags: [] };
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) throw e;
    llmOk = false;
    ({ provider, patient } = degradedPair(base, flags, llmStatus().configured));
  }

  // The fingerprint is stored only on a pair worth reusing (§7.1). A narrative the model wrote qualifies, and
  // so does the numbers-only pair an unconfigured deployment produces: it is the whole of what that
  // deployment can say, it is deterministic, and its fingerprint says `unconfigured`, so configuring a key
  // invalidates it. The one pair that gets a null hash is the one a configured-but-unreachable gateway
  // caused: the next run must really run rather than leave the clinician on "retry in a minute" forever.
  const inputHash = llmOk || provider.narrativeMissing === "unconfigured" ? c.inputHash : null;
  await db.summary.createMany({
    data: [
      { visitId: c.visitId, audience: "provider", json: JSON.stringify(provider), inputHash },
      { visitId: c.visitId, audience: "patient", json: JSON.stringify(patient), inputHash },
    ],
  });
  await markSummaryReady(c.visitId);

  // Both summaries saved -> queue the two "it's ready" links (§3.4, §8.2). A job rather than two SES calls
  // here, because this function runs inside a job itself: a bounce or a throttled send must not cost Sour its
  // summary, and the send gets its own three attempts. Skipped when the model was unavailable, so a
  // numbers-only pair never sends a "your summary is ready", and for sandbox data, which is nobody's real
  // appointment.
  let notified: SourRunResult["notified"] = { skipped: llmStatus().configured ? "Model gateway unavailable" : "LLM not configured" };
  if (bundle.patient.isSandbox) notified = { skipped: "Synthetic sandbox data: email disabled" };
  if (llmOk && !bundle.patient.isSandbox) {
    const { job } = await enqueue({ kind: "notify.summary", payload: { visitId: c.visitId }, idempotencyKey: `notify.summary:${c.visitId}` });
    notified = { queued: job.id };
  }
  return { provider, patient, notified, reused: false };
}

/**
 * The pair a run saves when no model wrote the narrative (design §6.3, §11.3).
 *
 * `LLMUnavailable` covers both "no key is configured" and "a configured gateway timed out or its circuit is
 * open" (lib/llm.ts), and a clinician needs to know which, because only one of them is something anyone at
 * the practice can act on. What they do not need is that reason sitting in `patterns`: §7 asks a pattern to
 * cite this patient's data, the patient's own summary renders the same array (§2.7, app/patient/[id]), and
 * §6.3 wants an unavailable assistant shown as a quiet piece of page state — which is what Sweetie already
 * does. So both audiences get the numbers with the two narrative sections empty, and the reason travels as
 * `narrativeMissing` for the provider page and the printed sheet to render beside the §7.2 chip
 * (lib/sourState.ts holds the wording).
 *
 * The patient's copy carries no reason and no flags: there is nothing for them to do about a model being
 * down, and configuration detail stays out of a patient-facing bundle (§10.6). Exported because this pair is
 * exactly what reaches `Summary.json` for each audience, which is what lib/sourRun.test.ts asserts.
 */
export function degradedPair(base: Summary, flags: string[], configured: boolean): { provider: Summary; patient: Summary } {
  const narrativeMissing: NarrativeMissing = configured ? "unavailable" : "unconfigured";
  return {
    provider: { ...base, patterns: [], questions: [], flags, narrativeMissing },
    patient: { ...base, patterns: [], questions: [], flags: [] },
  };
}

/** The real narrator: the clinician's brief first, then the patient's version of it, which is written from the
 *  clinician's patterns rather than from the raw data so the two never disagree. */
const modelNarrator: Narrator = async (c) => {
  const provider = await ask<Narrative>(sourSystem(), c.brief, { json: true });
  const patient = await ask<Narrative>(
    patientSummarySystem(),
    [
      `Time in range this week: ${Math.round(c.base.timeInRange * 100)}%`,
      `Clinician's patterns:\n${clean(provider.patterns, 3).map((x) => `- ${x}`).join("\n") || "- (none)"}`,
      `Clinician's questions for the visit:\n${clean(provider.questions, 3).map((x) => `- ${x}`).join("\n") || "- (none)"}`,
      `Patient's own words:\n${c.notes.trim() || "(none)"}`,
    ].join("\n\n"),
    { json: true, effort: "low" },
  );
  return { provider, patient };
};

/** The visit has a summary now, so the dashboard and the retention sweep can see it without reading one
 *  (§4.4). Only ever forwards, like the intake transitions in /api/sweetie: re-running Sour on a visit a
 *  clinician has already signed off must not pull it back out of `reviewed`. */
async function markSummaryReady(visitId: string): Promise<void> {
  await db.visit.updateMany({
    where: { id: visitId, status: { in: ["invited", "verified", "in_intake", "intake_done"] } },
    data: { status: "summary_ready" },
  });
}
