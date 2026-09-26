// Sour: provider summary. Owner: Justin (taken over from the scaffold; James did not land changes).
// POST /api/sour { patientId }                 -> generates and saves provider + patient summaries, returns both,
//                                                 then emails each to the provider and the patient (see lib/notify.ts)
// POST /api/sour { patientId, question }       -> free-text follow-up ("why was Tuesday bad?") -> { answer }
// All numbers are computed deterministically in lib/sour.ts and handed to the model as a local-time brief
// (per-day rows, time-of-day windows, spikes with places, nights labeled by the evening before).
// The model only writes patterns and questions. Safety flags (lows <54, TBR >4%, sustained >250) are
// computed in code and attached to the provider summary regardless of the narrative.
// Without an API key the summaries still return with placeholder patterns so the pages render.
// The same generation runs from the Sweetie route when intake wraps up (lib/sourRun.ts).

import { NextResponse } from "next/server";
import { ask, LLMUnavailable } from "@/lib/llm";
import { sourChatSystem } from "@/lib/prompts";
import { loadSourContext, runSour } from "@/lib/sourRun";

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
  const ctx = await loadSourContext(body.patientId);
  if (!ctx) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  const { brief } = ctx;

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

  // Generation, save, and link emails live in lib/sourRun.ts so Sweetie can fire the same thing on wrap-up.
  const result = await runSour(ctx.bundle.patient.id, ctx);
  return NextResponse.json(result);
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
