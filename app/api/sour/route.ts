// Sour: provider summary. Owner: Justin (taken over from the scaffold; James did not land changes).
// POST /api/sour { patientId }                 -> generates and saves provider + patient summaries, returns both,
//                                                 then emails each to the provider and the patient (see lib/notify.ts)
// POST /api/sour { patientId, question }       -> free-text follow-up ("why was Tuesday bad?") -> { answer }
// All numbers are computed deterministically in lib/sour.ts and handed to the model as a local-time brief
// (per-day rows, time-of-day windows, spikes with places, nights labeled by the evening before).
// The model only writes patterns and questions.
// Without an API key the summaries still return with placeholder patterns so the pages render.

import { NextResponse } from "next/server";
import { baseSummary, loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { ask, LLMUnavailable } from "@/lib/llm";
import { sendSummaryEmails, type SummaryNotifyResult } from "@/lib/notify";
import { patientSummarySystem, sourChatSystem, sourSystem } from "@/lib/prompts";
import { buildSourInput, renderSourInput } from "@/lib/sour";
import type { GlucoseReading, Summary } from "@/lib/types";

type Narrative = { patterns: string[]; questions: string[] };

const clean = (xs: unknown, n: number) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, n) : []);

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
  const glucose: GlucoseReading[] = dex ? (JSON.parse(dex.parsed) as GlucoseReading[]) : [];
  const notes = bundle.patient.notes ?? "";
  const base = baseSummary(glucose, bundle.spikes, notes);
  // Local-time, pre-aggregated brief (lib/sour.ts). The model reads this, never raw readings.
  const brief = renderSourInput(
    buildSourInput({ glucose, spikes: bundle.spikes, sleep: bundle.sleep, patientNotes: notes, visit: { type: bundle.patient.visitType, reason: bundle.patient.reason } }),
  );

  if (typeof body.question === "string") {
    try {
      const answer = await ask(
        sourChatSystem(),
        `PATIENT DATA\n${brief}\n\nRECENT CONVERSATION (doctor q, Sour a):\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n") || "(none)"}\n\nLATEST DOCTOR MESSAGE:\n${body.question.trim()}`,
        { effort: "low" },
      );
      if (!answer.trim()) throw new Error("Empty Sour reply");
      return NextResponse.json({ answer: plainAnswer(answer) });
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
    const n = await ask<Narrative>(sourSystem(), brief, { json: true });
    provider = { ...base, patterns: clean(n.patterns, 3), questions: clean(n.questions, 3) };
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
    patient = { ...base, patterns: clean(p.patterns, 3), questions: clean(p.questions, 3) };
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

function plainAnswer(raw: string): string {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (!text.startsWith("{") || !text.endsWith("}")) return text;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.answer === "string") return parsed.answer;

    const prose = Object.values(parsed)
      .flatMap((value) => {
        if (typeof value === "string") return [value];
        if (Array.isArray(value)) {
          return value.filter((item): item is string => typeof item === "string");
        }
        return [];
      })
      .join(" ");

    return prose || text;
  } catch {
    return text;
  }
}
