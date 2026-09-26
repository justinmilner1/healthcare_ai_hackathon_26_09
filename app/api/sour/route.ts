// Sour: provider summary. Owner: James.
// POST /api/sour { patientId }                 -> generates and saves provider + patient summaries, returns both,
//                                                 then emails each to the provider and the patient (see lib/notify.ts)
// POST /api/sour { patientId, question }       -> free-text follow-up ("why was Tuesday bad?") -> { answer }
// Numbers (TIR, average, spikes) are computed deterministically; the model only writes patterns and questions.
// Without an API key the summaries still return with placeholder patterns so the pages render.

import { NextResponse } from "next/server";
import { baseSummary, loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { ask, LLMUnavailable } from "@/lib/llm";
import { sendSummaryEmails, type SummaryNotifyResult } from "@/lib/notify";
import { patientSummarySystem, sourChatSystem, sourSystem, sourUser } from "@/lib/prompts";
import type { Summary } from "@/lib/types";

type Narrative = { patterns: string[]; questions: string[] };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { patientId?: string; question?: unknown; history?: unknown } | null;
  if (!body || typeof body.patientId !== "string" || !body.patientId) return NextResponse.json({ error: "patientId is required" }, { status: 400 });
  if (body.question !== undefined && (typeof body.question !== "string" || !body.question.trim() || body.question.length > 4000)) {
    return NextResponse.json({ error: "question must be non-empty text of at most 4000 characters" }, { status: 400 });
  }
  const history: { q: string; a: string }[] = [];
  if (Array.isArray(body.history)) {
    for (const turn of body.history.slice(-6)) {
      if (turn && typeof turn.q === "string" && typeof turn.a === "string") {
        history.push({ q: turn.q.slice(0, 4000), a: turn.a.slice(0, 4000) });
      }
    }
  }
  const bundle = await loadBundle(body.patientId);
  if (!bundle) return NextResponse.json({ error: "patient not found" }, { status: 404 });

  // Full-resolution glucose for the numbers (bundle.glucose is downsampled for charts).
  const dex = await db.upload.findFirst({ where: { patientId: bundle.patient.id, kind: "dexcom" }, orderBy: { createdAt: "desc" } });
  const glucose = dex ? (JSON.parse(dex.parsed) as Summary["spikes"] extends never ? never : { t: string; mgdl: number }[]) : [];
  const base = baseSummary(glucose, bundle.spikes, bundle.patient.notes ?? "");

  if (typeof body.question === "string") {
    try {
      const answer = await ask(
        sourChatSystem(),
        `Patient data:\n${sourUser({ ...base, readingCount: glucose.length, sleep: bundle.sleep, visit: { type: bundle.patient.visitType, reason: bundle.patient.reason } })}\n\nRecent conversation (doctor q, Sour a):\n${JSON.stringify(history)}\n\nLatest doctor message:\n${body.question.trim()}`,
      );
      if (!answer.trim()) throw new Error("Empty Sour reply");
      return NextResponse.json({ answer: answer.trim() });
    } catch (e) {
      if (e instanceof LLMUnavailable) return NextResponse.json({ error: "Sour chat is unavailable until the model is configured." }, { status: 503 });
      console.error("Sour chat failed:", e);
      return NextResponse.json({ error: "Sour could not answer. Please try again." }, { status: 502 });
    }
  }

  let provider: Summary;
  let patient: Summary;
  let llmOk = true;
  try {
    const n = await ask<Narrative>(sourSystem(), sourUser({ ...base, readingCount: glucose.length, sleep: bundle.sleep, visit: { type: bundle.patient.visitType, reason: bundle.patient.reason } }), { json: true });
    provider = { ...base, patterns: (n.patterns ?? []).slice(0, 3), questions: (n.questions ?? []).slice(0, 3) };
    const p = await ask<Narrative>(patientSummarySystem(), JSON.stringify(provider), { json: true, effort: "low" });
    patient = { ...base, patterns: (p.patterns ?? []).slice(0, 3), questions: (p.questions ?? []).slice(0, 3) };
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) throw e;
    llmOk = false;
    const note = "LLM not configured: set OPENAI_API_KEY to generate patterns and questions.";
    provider = { ...base, patterns: [note], questions: [] };
    patient = { ...base, patterns: [note], questions: [] };
  }

  await db.summary.createMany({
    data: [
      { patientId: bundle.patient.id, audience: "provider", json: JSON.stringify(provider) },
      { patientId: bundle.patient.id, audience: "patient", json: JSON.stringify(patient) },
    ],
  });

  // Trigger: both summaries saved -> email the provider and the patient. Skipped when the model was
  // unavailable, so placeholder text never goes out. Fails soft; the result is reported, not thrown.
  let notified: SummaryNotifyResult | { skipped: string } = { skipped: "LLM not configured" };
  if (llmOk) {
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
  return NextResponse.json({ provider, patient, notified });
}
