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
import { spanNoun } from "./plural";
import { patientSummarySystem, sourSystem } from "./prompts";
import { buildSourInput, renderSourInput, safetyFlags } from "./sour";
import { narrativeSource, sourInputHash, sourInputsFor, type SourUploadRef } from "./sourInput";
import { queueSourSuccessor } from "./sourQueue";
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
    buildSourInput({
      glucose,
      spikes: bundle.spikes,
      // The week's count, not the length of the card's five rows (T164): the brief states it and the model
      // is asked for patterns that cite the brief.
      spikeTotal: bundle.spikeTotal,
      sleep: bundle.sleep,
      patientNotes: notes,
      visit: { type: bundle.patient.visitType, reason: bundle.patient.reason },
    }),
  );
  const inputHash = sourInputHash(sourInputsFor(visit, await uploadRefs(visit.id), narrativeSource(llmStatus().configured)));
  return { visitId: visit.id, bundle, glucose, notes, base, brief, flags, inputHash };
}

/** Every upload of a visit as the fingerprint sees it: ids and row counts, not the parsed rows, so this stays
 *  a small query even for a week of five-minute readings. */
export async function uploadRefs(visitId: string, client: SummaryClient = db): Promise<SourUploadRef[]> {
  return client.upload.findMany({ where: { visitId }, select: { id: true, kind: true, parsedRows: true } });
}

/**
 * The fingerprint of a visit's inputs as they stand *now* (§7.1) — the same four columns and the same upload
 * refs `loadSourContext` hashed on the way in, read again.
 *
 * Its one caller is the check `runSour` makes on its way out (T149), and the only thing that makes that check
 * meaningful is that this reads nothing `runSour` writes: not the summaries, not `Visit.status`, not the
 * `notify.summary` row. A run therefore cannot change its own fingerprint, so a difference here is always
 * something that arrived from outside while the run was in the air. Null for a visit that is gone — a
 * deletion (§10.5) mid-run has nothing left to summarize.
 */
export async function currentInputHash(visitId: string): Promise<string | null> {
  const visit = await db.visit.findUnique({ where: { id: visitId }, select: { intake: true, notes: true, visitType: true, reason: true } });
  if (!visit) return null;
  return sourInputHash(sourInputsFor(visit, await uploadRefs(visitId), narrativeSource(llmStatus().configured)));
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
  /** The run queued because the visit's inputs moved while this one was in flight (§7.1, T149), or null —
   *  which is every run in the ordinary sequence. */
  successor: { jobId: string; inputHash: string } | null;
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
 *
 * The same fingerprint is read once more on the way out, which is the other half of that rule and the whole
 * of T149: see `queueSuccessorIfInputsMoved`.
 */
export async function runSour(idOrToken: string, opts: RunSourOptions = {}): Promise<SourRunResult> {
  const c = opts.ctx ?? (await loadSourContext(idOrToken));
  if (!c) throw new Error("visit not found");
  const { bundle, base, flags } = c;

  const saved = await existingSummaryFor(c.visitId, c.inputHash);
  if (saved) {
    log.info("sour_reused", { visitId: c.visitId, summaryId: saved.summaryIds[0] });
    await markSummaryReady(c.visitId);
    return {
      provider: saved.provider,
      patient: saved.patient,
      notified: { skipped: "Inputs unchanged: the saved summary was reused" },
      reused: true,
      successor: await queueSuccessorIfInputsMoved(c),
    };
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
  // deployment can say, it is deterministic, and its fingerprint says `none` rather than `model`
  // (lib/sourInput.ts `narrativeSource`), so configuring a key invalidates it. The one pair that gets a null
  // hash is the one a configured-but-unreachable gateway caused: the next run must really run rather than
  // leave the clinician on "retry in a minute" forever.
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
  return { provider, patient, notified, reused: false, successor: await queueSuccessorIfInputsMoved(c) };
}

/**
 * Did the visit's inputs move while this run was reading them? (§7.1, T149)
 *
 * `loadSourContext` reads the uploads when the job *runs*, and `enqueue` collapses a second `sour.run` while
 * the first is in flight — right for a double-pressed Generate, wrong for the one sequence that carries
 * genuinely new inputs. The patient answers the last question, the wrap queues a run (T143: every wrap), and
 * while that run is in the air — two model calls, each bounded at 20 seconds with a retry (§3.5) — they
 * upload the Dexcom export from the panel still on the screen. `queueSourAfterImport` fires and joins the
 * run that read its inputs before the file existed. Nothing is queued for the readings, and §2.6's email
 * links the clinician to a brief with no numbers in it for a patient who shared a week of them. `summaryStale`
 * marks the pair and §7.2 offers Regenerate, so it is not silent — but nothing but a person noticing ever
 * puts those readings in front of the clinician.
 *
 * So the run looks once more before it leaves: the visit's fingerprint now against the one this pair was
 * written from. Different means something arrived mid-run, and what is saved already describes inputs the
 * visit no longer has — so a successor is queued over the current ones. The two model calls the race cost
 * are not reclaimable; what matters is that the readings get summarized without anyone pressing anything.
 *
 * **It cannot loop.** The successor is keyed by the fingerprint it is queued *for* (`sourSuccessorKey`), and
 * §7.1's hash covers the intake, the visit's type and reason and every upload — none of which `runSour`
 * writes. So a run cannot invalidate its own inputs, an unchanged fingerprint queues nothing at all (every
 * run in the ordinary sequence), and the chain is as long as the number of times the data really changed.
 * The successor that finds the data settled is the last one: it re-reads the same fingerprint it ran with.
 */
async function queueSuccessorIfInputsMoved(c: SourContext): Promise<SourRunResult["successor"]> {
  const inputHash = await currentInputHash(c.visitId);
  if (!inputHash || inputHash === c.inputHash) return null;
  try {
    const { job, deduped } = await queueSourSuccessor(c.visitId, inputHash);
    // One event name for "a summary did not happen", the same one lib/sourQueue.ts writes (docs/JOBS.md);
    // `sour_inputs_moved` above it is the reason this row exists and not one of the three triggers'.
    log.info("sour_inputs_moved", { visitId: c.visitId, jobId: job.id });
    if (!deduped) log.info("sour_queued", { visitId: c.visitId, jobId: job.id });
    return { jobId: job.id, inputHash };
  } catch (e) {
    // The pair is saved and the visit has moved on. A queue that will not take this row must not undo either
    // or spend one of the job's three attempts (§3.4) on work that is already done — §7.2's Regenerate is
    // still on the page, which is the fallback this check exists to make unnecessary rather than to replace.
    log.error("sour_enqueue_failed", { visitId: c.visitId, error: e });
    return null;
  }
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
  // The span the figure was computed over, not a literal week (T114, §2.7): `bundle.stats.days` is the
  // number the patient's own page prints in its History tile, so the prompt and the page cannot disagree
  // about how much data this is. `lib/bundle.ts` floors it at 1.
  const days = c.bundle.stats.days;
  const patient = await ask<Narrative>(
    patientSummarySystem(days),
    [
      `Time in range over the ${spanNoun(days)}: ${Math.round(c.base.timeInRange * 100)}%`,
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
