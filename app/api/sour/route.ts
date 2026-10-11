// Sour: provider summary. Owner: Justin (taken over from the scaffold; James did not land changes).
// POST /api/sour { patientId }                 -> queues a `sour.run` job and returns 202 { jobId, status }; the
//                                                 job writes both summaries and queues the two link emails (§3.4,
//                                                 §7.1). The page polls GET /api/patient/[id] for the result;
//                                                 showing the job's own state is T15.
// POST /api/sour { patientId, question }       -> free-text follow-up ("why was Tuesday bad?") -> { answer }
// All numbers are computed deterministically in lib/sour.ts and handed to the model as a local-time brief
// (per-day rows, time-of-day windows, spikes with places, nights labeled by the evening before).
// The model only writes patterns and questions. Safety flags (lows <54, TBR >4%, sustained >250) are
// computed in code and attached to the provider summary regardless of the narrative.
// Without an API key the summaries still return with placeholder patterns so the pages render.
// The same job is queued by the Sweetie route when intake wraps up (lib/jobHandlers.ts, lib/sourRun.ts).

import { after, NextResponse } from "next/server";
import { enqueue, nudge } from "@/lib/jobs";
import { ask, llmStatus, LLMUnavailable } from "@/lib/llm";
import { log, withRoute } from "@/lib/log";
import { sourChatSystem } from "@/lib/prompts";
import { loadSourContext } from "@/lib/sourRun";
import { findVisit } from "@/lib/visit";

async function postHandler(req: Request) {
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
  // Queueing a summary needs the visit and nothing else; only the follow-up question needs the brief, which
  // costs a parse of the whole Dexcom upload.
  if (typeof body.question !== "string") {
    const visit = await findVisit(body.patientId);
    if (!visit) return NextResponse.json({ error: "patient not found" }, { status: 404 });
    // Generation is a job (§3.4): two model calls and two emails are not something a clinician should hold a
    // request open for, and the row survives a redeploy mid-run. Asking twice while the first run is still in
    // flight joins it; asking again after it has finished is a real regenerate (lib/jobs.ts, enqueue).
    const { job, deduped } = await enqueue({ kind: "sour.run", payload: { visitId: visit.id }, idempotencyKey: `sour.run:${visit.id}` });
    nudge(after);
    return NextResponse.json({ jobId: job.id, status: job.status, queued: true, deduped }, { status: 202 });
  }

  const ctx = await loadSourContext(body.patientId);
  if (!ctx) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  const { brief } = ctx;

  try {
    const answer = await ask(
      sourChatSystem(),
      `PATIENT DATA\n${brief}\n\nRECENT CONVERSATION (doctor q, Sour a):\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n") || "(none)"}\n\nLATEST DOCTOR MESSAGE:\n${body.question.trim()}`,
      { effort: "low" },
    );
    if (!answer.trim()) throw new Error("Empty Sour reply");
    return NextResponse.json({ answer: plainAnswer(answer) });
  } catch (e) {
    if (e instanceof LLMUnavailable) {
      const error = llmStatus().configured
        ? "Sour chat is unavailable: the model gateway is not responding. Try again in a minute."
        : "Sour chat is unavailable until the model is configured.";
      return NextResponse.json({ error }, { status: 503 });
    }
    // The caller's string may be a link token (loadSourContext takes either); log the resolved id.
    log.error("sour_chat_failed", { patientId: ctx.bundle.patient.id, error: e });
    return NextResponse.json({ error: "Sour could not answer. Please try again." }, { status: 502 });
  }
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

export const POST = withRoute("POST /api/sour", postHandler);
