// Run Sour for a patient: build the brief, write both summaries, save them, email the links.
// Called from POST /api/sour (button, auto-generate on first open) and from the Sweetie route the moment
// intake wraps up, so the doctor's email arrives while the patient is still in the chat. Owner: Justin.

import { baseSummary, loadBundle } from "./bundle";
import { db } from "./db";
import { ask, llmStatus, LLMUnavailable } from "./llm";
import { sendSummaryEmails, type SummaryNotifyResult } from "./notify";
import { patientSummarySystem, sourSystem } from "./prompts";
import { buildSourInput, renderSourInput, safetyFlags } from "./sour";
import type { GlucoseReading, PatientBundle, Summary } from "./types";

type Narrative = { patterns: string[]; questions: string[] };

export type SourContext = {
  bundle: PatientBundle;
  glucose: GlucoseReading[];
  notes: string;
  base: Summary;
  brief: string;
  flags: string[];
};

const clean = (xs: unknown, n: number) =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, n) : [];

/** Everything Sour needs about one patient, computed once. Null if the patient does not exist. */
export async function loadSourContext(patientIdOrToken: string): Promise<SourContext | null> {
  const bundle = await loadBundle(patientIdOrToken);
  if (!bundle) return null;
  // Full-resolution glucose for the numbers (bundle.glucose is downsampled for charts).
  const dex = await db.upload.findFirst({ where: { patientId: bundle.patient.id, kind: "dexcom" }, orderBy: { createdAt: "desc" } });
  const glucose: GlucoseReading[] = dex ? (JSON.parse(dex.parsed) as GlucoseReading[]) : [];
  const notes = bundle.patient.notes ?? "";
  const flags = safetyFlags(glucose);
  const base: Summary = { ...baseSummary(glucose, bundle.spikes, notes), flags };
  const brief = (bundle.patient.isSandbox ? "SYNTHETIC DEXCOM SANDBOX DATA — demonstration only, not real patient findings.\n" : "") + renderSourInput(
    buildSourInput({ glucose, spikes: bundle.spikes, sleep: bundle.sleep, patientNotes: notes, visit: { type: bundle.patient.visitType, reason: bundle.patient.reason } }),
  );
  return { bundle, glucose, notes, base, brief, flags };
}

export type SourRunResult = {
  provider: Summary;
  patient: Summary;
  notified: SummaryNotifyResult | { skipped: string };
};

/** Generate, save, and notify. Never throws for a missing model; does throw for a missing patient. */
export async function runSour(patientId: string, ctx?: SourContext): Promise<SourRunResult> {
  const c = ctx ?? (await loadSourContext(patientId));
  if (!c) throw new Error("patient not found");
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
      { patientId: bundle.patient.id, audience: "provider", json: JSON.stringify(provider) },
      { patientId: bundle.patient.id, audience: "patient", json: JSON.stringify(patient) },
    ],
  });

  // Both summaries saved -> email the provider and the patient a link. Skipped when the model was
  // unavailable, so placeholder text never triggers a notification. Fails soft.
  let notified: SummaryNotifyResult | { skipped: string } = { skipped: llmStatus().configured ? "Model gateway unavailable" : "LLM not configured" };
  if (bundle.patient.isSandbox) notified = { skipped: "Synthetic sandbox data: email disabled" };
  if (llmOk && !bundle.patient.isSandbox) {
    const row = await db.patient.findUnique({ where: { id: bundle.patient.id }, include: { provider: true } });
    if (row) {
      notified = await sendSummaryEmails({
        patient: { id: row.id, name: row.name, email: row.email, token: row.token, apptAt: row.apptAt },
        provider: { id: row.provider.id, name: row.provider.name, email: row.provider.email, practice: row.provider.practice },
        providerSummary: provider,
        patientSummary: patient,
      });
    }
  }
  return { provider, patient, notified };
}
