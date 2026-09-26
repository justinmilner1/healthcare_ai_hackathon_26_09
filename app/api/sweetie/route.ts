// Sweetie chat. Owner: (unassigned; Nisarga owns the page that calls this).
// GET  /api/sweetie?token=...            -> { patientId, name, messages, status }
// POST /api/sweetie { token, message }   -> { reply, status }
// Without an API key, Sweetie falls back to a scripted flow so the front end still works.

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { ask, LLMUnavailable, MODEL } from "@/lib/llm";
import { SWEETIE_QUESTIONS, sweetieSystem } from "@/lib/prompts";
import type { ChatMessage, IntakeStatus } from "@/lib/types";

async function patientByToken(token: string | null) {
  if (!token) return null;
  return db.patient.findUnique({ where: { token } });
}

function agentInfo() {
  return {
    connected: Boolean(process.env.OPENAI_API_KEY),
    model: MODEL(),
  };
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const patient = await patientByToken(token);
  if (!patient) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  const bundle = await loadBundle(patient.id);
  const rows = await db.message.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: "asc" } });
  const messages: ChatMessage[] = rows.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content, createdAt: m.createdAt.toISOString() }));
  if (messages.length === 0) {
    const hello = `Hi ${patient.name.split(" ")[0]}, I'm Sweetie 🍬. I'll help you get ready for your visit. First, could you upload your Dexcom export using the button below?`;
    await db.message.create({ data: { patientId: patient.id, role: "sweetie", content: hello } });
    messages.push({ role: "sweetie", content: hello });
  }
  return NextResponse.json({ patientId: patient.id, name: patient.name, messages, status: bundle?.status, agent: agentInfo() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; message?: string };
  const patient = await patientByToken(body.token ?? null);
  if (!patient) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  if (!body.message?.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });

  await db.message.create({ data: { patientId: patient.id, role: "patient", content: body.message.trim() } });

  const bundle = await loadBundle(patient.id);
  const status = bundle!.status;
  const history = await db.message.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: "asc" } });
  const transcript = history.map((m) => `${m.role === "sweetie" ? "Sweetie" : "Patient"}: ${m.content}`).join("\n");

  let reply: string;
  try {
    reply = await ask(sweetieSystem(status), `Conversation so far:\n${transcript}\n\nWrite Sweetie's next message.`, { effort: "low" });
  } catch (e) {
    if (!(e instanceof LLMUnavailable)) throw e;
    reply = scriptedReply(status);
  }

  await db.message.create({ data: { patientId: patient.id, role: "sweetie", content: reply } });
  // Keep the patient's answers on the record for Sour.
  const answers = history.filter((m) => m.role === "patient").map((m) => m.content).join("\n");
  await db.patient.update({ where: { id: patient.id }, data: { notes: answers } });

  return NextResponse.json({ reply, status, agent: agentInfo() });
}

function scriptedReply(s: IntakeStatus): string {
  if (!s.hasDexcom) return "Thanks! Could you upload your Dexcom Clarity CSV with the Dexcom button? That's the most important one.";
  if (!s.hasLocation) return "Got your glucose data. Next, could you upload your Google Maps Timeline export? It helps us connect meals to places.";
  if (s.answered < SWEETIE_QUESTIONS.length) return SWEETIE_QUESTIONS[s.answered];
  return "That's everything I need. Your doctor will see a one-page summary before your visit. See you soon!";
}
