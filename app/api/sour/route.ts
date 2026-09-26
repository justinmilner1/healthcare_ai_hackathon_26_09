// Sour: provider summary. Owner: James.
// POST /api/sour { patientId }                 -> generates and saves provider + patient summaries, returns both
// POST /api/sour { patientId, question }       -> free-text follow-up ("why was Tuesday bad?") -> { answer }
// Numbers (TIR, average, spikes) are computed deterministically; the model only writes patterns and questions.
// Without an API key the summaries still return with placeholder patterns so the pages render.

import { NextResponse } from "next/server";
import { baseSummary, loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { ask, LLMUnavailable } from "@/lib/llm";
import { patientSummarySystem, sourSystem, sourUser } from "@/lib/prompts";
import type { Summary } from "@/lib/types";

type Narrative = { patterns: string[]; questions: string[] };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { patientId?: string; question?: string };
  if (!body.patientId) return NextResponse.json({ error: "patientId is required" }, { status: 400 });
  const bundle = await loadBundle(body.patientId);
  if (!bundle) return NextResponse.json({ error: "patient not found" }, { status: 404 });

  // Full-resolution glucose for the numbers (bundle.glucose is downsampled for charts).
  const dex = await db.upload.findFirst({ where: { patientId: bundle.patient.id, kind: "dexcom" }, orderBy: { createdAt: "desc" } });
  const glucose = dex ? (JSON.parse(dex.parsed) as Summary["spikes"] extends never ? never : { t: string; mgdl: number }[]) : [];
  const base = baseSummary(glucose, bundle.spikes, bundle.patient.notes ?? "");

  if (body.question) {
    try {
      const answer = await ask(
        sourSystem() + "\nAnswer the doctor's question in 3 sentences or fewer, citing the data.",
        `Data:\n${sourUser({ ...base, readingCount: glucose.length, sleep: bundle.sleep })}\n\nQuestion: ${body.question}`,
      );
      return NextResponse.json({ answer });
    } catch (e) {
      if (e instanceof LLMUnavailable) return NextResponse.json({ answer: "(LLM not configured) " + e.message });
      throw e;
    }
  }

  let provider: Summary;
  let patient: Summary;
  try {
    const n = await ask<Narrative>(sourSystem(), sourUser({ ...base, readingCount: glucose.length, sleep: bundle.sleep }), { json: true });
    provider = { ...base, patterns: (n.patterns ?? []).slice(0, 3), questions: (n.questions ?? []).slice(0, 3) };
    const p = await ask<Narrative>(patientSummarySystem(), JSON.stringify(provider), { json: true, effort: "low" });
    patient = { ...base, patterns: (p.patterns ?? []).slice(0, 3), questions: (p.questions ?? []).slice(0, 3) };
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) throw e;
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
  return NextResponse.json({ provider, patient });
}
