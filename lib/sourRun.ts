// Run Sour for one visit: build the brief, write both summaries, save them, queue the "it's ready" links.
// Called from the `sour.run` job handler (design §7.1), which is what POST /api/sour enqueues for the
// provider page's Generate button and what the Sweetie route enqueues the moment intake wraps up, so the
// doctor's email is on its way while the patient is still in the chat. Owner: Justin.

import { baseSummary, loadBundle } from "./bundle";
import { db } from "./db";
import { enqueue } from "./jobs";
import { ask, llmStatus, LLMUnavailable } from "./llm";
import { patientSummarySystem, sourSystem } from "./prompts";
import { buildSourInput, renderSourInput, safetyFlags } from "./sour";
import type { GlucoseReading, PatientBundle, Summary } from "./types";
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
  return { visitId: visit.id, bundle, glucose, notes, base, brief, flags };
}

export type SourRunResult = {
  provider: Summary;
  patient: Summary;
  /** The notify.summary job that will send the two links, or why no message is going out (§8.2). */
  notified: { queued: string } | { skipped: string };
};

/** Generate, save, and notify. Never throws for a missing model; does throw for a missing visit. */
export async function runSour(idOrToken: string, ctx?: SourContext): Promise<SourRunResult> {
  const c = ctx ?? (await loadSourContext(idOrToken));
  if (!c) throw new Error("visit not found");
  const { bundle, base, brief, notes, flags } = c;

  let provider: Summary;
  let patient: Summary;
  let llmOk = true;
  try {
    const n = await ask<Narrative>(sourSystem(), brief, { json: true });
    provider = { ...base, patterns: clean(n.patterns, 3), questions: clean(n.questions, 3), flags };
    const p = await ask<Narrative>(
      patientSummarySystem(),
      [
        `Time in range this week: ${Math.round(base.timeInRange * 100)}%`,
        `Clinician's patterns:\n${provider.patterns.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
        `Clinician's questions for the visit:\n${provider.questions.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
        `Patient's own words:\n${notes.trim() || "(none)"}`,
      ].join("\n\n"),
      { json: true, effort: "low" },
    );
    // Safety flags are for the clinician; the patient version carries none.
    patient = { ...base, patterns: clean(p.patterns, 3), questions: clean(p.questions, 3), flags: [] };
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) throw e;
    llmOk = false;
    // LLMUnavailable covers both "no key" and "the gateway timed out or its circuit is open" (lib/llm.ts).
    // A clinician reading this needs to know which, because only one of them is something they can fix.
    const note = llmStatus().configured
      ? "Model gateway unavailable: the numbers above are complete; patterns and questions were not generated. Retry in a minute."
      : "LLM not configured: set OPENAI_API_KEY to generate patterns and questions.";
    provider = { ...base, patterns: [note], questions: [], flags };
    patient = { ...base, patterns: [note], questions: [], flags: [] };
  }

  await db.summary.createMany({
    data: [
      { visitId: c.visitId, audience: "provider", json: JSON.stringify(provider) },
      { visitId: c.visitId, audience: "patient", json: JSON.stringify(patient) },
    ],
  });
  // The visit has a summary now, so the dashboard and the retention sweep can see it without reading one (§4.4).
  // Only ever forwards, like the intake transitions in /api/sweetie: re-running Sour on a visit a clinician
  // has already signed off must not pull it back out of `reviewed` (§4.4).
  await db.visit.updateMany({
    where: { id: c.visitId, status: { in: ["invited", "verified", "in_intake", "intake_done"] } },
    data: { status: "summary_ready" },
  });

  // Both summaries saved -> queue the two "it's ready" links (§3.4, §8.2). A job rather than two SES calls
  // here, because this function runs inside a job itself: a bounce or a throttled send must not cost Sour its
  // summary, and the send gets its own three attempts. Skipped when the model was unavailable, so placeholder
  // text never triggers a notification, and for sandbox data, which is nobody's real appointment.
  let notified: SourRunResult["notified"] = { skipped: llmStatus().configured ? "Model gateway unavailable" : "LLM not configured" };
  if (bundle.patient.isSandbox) notified = { skipped: "Synthetic sandbox data: email disabled" };
  if (llmOk && !bundle.patient.isSandbox) {
    const { job } = await enqueue({ kind: "notify.summary", payload: { visitId: c.visitId }, idempotencyKey: `notify.summary:${c.visitId}` });
    notified = { queued: job.id };
  }
  return { provider, patient, notified };
}
