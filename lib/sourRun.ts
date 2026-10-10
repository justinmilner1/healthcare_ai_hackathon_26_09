// Run Sour for a patient: build the brief, write both summaries, save them, email the links.
// Called from POST /api/sour (button, auto-generate on first open) and from the Sweetie route the moment
// intake wraps up, so the doctor's email arrives while the patient is still in the chat. Owner: Justin.

import { baseSummary, loadBundle } from "./bundle";
import { db } from "./db";
import { ask, LLMUnavailable } from "./llm";
import { sendSummaryEmails, type SummaryNotifyResult } from "./notify";
import { patientSummarySystem, sourSystem } from "./prompts";
import { buildSourInput, renderSourInput, safetyFlags } from "./sour";
import type { GlucoseReading, PatientBundle, Summary } from "./types";
import { findVisit, providerName } from "./visit";

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

/** Everything Sour needs about one visit, computed once. Null if nothing matches. Takes a visit id, a
 *  patient id, or the invite token (design §4.4). */
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
  notified: SummaryNotifyResult | { skipped: string };
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
    const note = "LLM not configured: set OPENAI_API_KEY to generate patterns and questions.";
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
  await db.visit.update({ where: { id: c.visitId }, data: { status: "summary_ready" } });

  // Both summaries saved -> email the provider and the patient a link. Skipped when the model was
  // unavailable, so placeholder text never triggers a notification. Fails soft.
  let notified: SummaryNotifyResult | { skipped: string } = { skipped: "LLM not configured" };
  if (bundle.patient.isSandbox) notified = { skipped: "Synthetic sandbox data: email disabled" };
  if (llmOk && !bundle.patient.isSandbox) {
    const row = await findVisit(c.visitId);
    if (row) {
      notified = await sendSummaryEmails({
        patient: { id: row.patientId, name: row.patient.name, email: row.patient.email, token: row.token, apptAt: row.scheduledAt },
        provider: { id: row.providerUserId ?? "", name: providerName(row), email: row.providerUser?.email ?? null, practice: row.patient.practice.name },
        providerSummary: provider,
        patientSummary: patient,
      });
    }
  }
  return { provider, patient, notified };
}
