"use client";

// Sweetie chat + data upload, reached from the presigned link. Owner: Nisarga.
// Uses GET/POST /api/sweetie and POST /api/upload. This is a working skeleton; make it pretty.

import { use, useEffect, useRef, useState } from "react";
import type { ChatMessage, IntakeState, IntakeStatus, UploadKind } from "@/lib/types";

type AgentInfo = { connected: boolean; model: string };

export default function SweetiePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/sweetie?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setMessages(d.messages ?? []);
        setStatus(d.status ?? null);
        setIntake(d.intake ?? null);
        setAgent(d.agent ?? null);
      });
  }, [token]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const mine = text.trim();
    setText("");
    setMessages((m) => [...m, { role: "patient", content: mine }]);
    setBusy(true);
    const res = await fetch("/api/sweetie", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, message: mine }) });
    const d = await res.json();
    setMessages((m) => [...m, { role: "sweetie", content: d.reply }]);
    setStatus(d.status);
    if (d.intake) setIntake(d.intake);
    if (d.agent) setAgent(d.agent);
    setBusy(false);
  }

  async function upload(kind: UploadKind, file: File) {
    const fd = new FormData();
    fd.set("token", token);
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) {
      setMessages((m) => [...m, { role: "sweetie", content: `That file didn't work: ${d.error}. Want to try again, or ask me how to export it?` }]);
      return;
    }
    if (d.status) setStatus(d.status);
    // Tell Sweetie, so she can acknowledge what arrived and ask for the next thing.
    setBusy(true);
    const r2 = await fetch("/api/sweetie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, event: { type: "upload", kind, count: d.count, days: d.days } }),
    });
    const d2 = await r2.json();
    if (d2.reply) setMessages((m) => [...m, { role: "sweetie", content: d2.reply }]);
    if (d2.status) setStatus(d2.status);
    if (d2.intake) setIntake(d2.intake);
    if (d2.agent) setAgent(d2.agent);
    setBusy(false);
  }

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col p-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Sweetie 🍬</h1>
        <AgentBadge agent={agent} />
      </header>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <UploadButton label="Dexcom CSV" kind="dexcom" done={status?.hasDexcom} onFile={upload} />
        <UploadButton label="Maps Timeline JSON" kind="timeline" done={status?.hasLocation} onFile={upload} />
        <UploadButton label="WHOOP CSV" kind="whoop" done={status?.hasWhoop} onFile={upload} />
      </div>
      {intake && <Progress intake={intake} />}

      <div className="mt-4 flex-1 space-y-2 overflow-y-auto rounded border p-3">
        {messages.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === "sweetie" ? "bg-pink-50" : "ml-auto bg-gray-100"}`}>
            {m.content}
          </div>
        ))}
        {status?.done && (
          <a href={`/patient/${token}`} className="block rounded bg-green-50 px-3 py-2 text-center text-sm underline">
            All done. See your summary →
          </a>
        )}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="mt-3 flex gap-2">
        <input className="flex-1 rounded border p-2" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a reply…" disabled={busy} />
        <button className="rounded bg-black px-4 text-white disabled:opacity-50" disabled={busy}>Send</button>
      </form>
    </main>
  );
}

function AgentBadge({ agent }: { agent: AgentInfo | null }) {
  if (!agent) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        Making connection…
      </div>
    );
  }

  const explanation = agent.connected
    ? `Sweetie sends each reply to ${agent.model} through Amazon Bedrock.`
    : "Sweetie is using fixed fallback questions instead of an AI model because no model API key is configured. To connect the model, set OPENAI_API_KEY in .env and restart the development server.";

  return (
    <button
      type="button"
      className={`group relative flex cursor-help items-center gap-1.5 rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${
        agent.connected ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"
      }`}
      aria-label={explanation}
    >
      <span className={`h-2 w-2 rounded-full ${agent.connected ? "bg-green-500" : "bg-gray-400"}`} />
      {agent.connected ? `Connected to ${agent.model}` : "Scripted demo mode"}
      <span className="pointer-events-none absolute right-0 top-full z-10 mt-2 hidden w-72 rounded-lg bg-gray-900 p-3 text-left text-xs leading-relaxed text-white shadow-lg group-hover:block group-focus:block">
        {explanation}
      </span>
    </button>
  );
}

function UploadButton({ label, kind, done, onFile }: { label: string; kind: UploadKind; done?: boolean; onFile: (k: UploadKind, f: File) => void }) {
  return (
    <label className={`cursor-pointer rounded border px-2 py-1 ${done ? "bg-green-100" : "bg-white"}`}>
      {done ? "✓ " : ""}{label}
      <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(kind, e.target.files[0])} />
    </label>
  );
}

const FIELD_LABELS: Record<keyof IntakeState["fields"], string> = { meals: "Meals", unusual: "This week", symptoms: "How you feel", visit_goal: "For the doctor" };

function Progress({ intake }: { intake: IntakeState }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
      {(Object.keys(FIELD_LABELS) as (keyof IntakeState["fields"])[]).map((k) => {
        const c = intake.fields[k]?.confidence ?? "unfilled";
        const done = c === "medium" || c === "high";
        return (
          <span key={k} title={intake.fields[k]?.value ?? ""} className={`rounded-full px-2 py-0.5 ${done ? "bg-green-100 text-green-800" : c === "low" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-500"}`}>
            {done ? "✓ " : ""}{FIELD_LABELS[k]}
          </span>
        );
      })}
      {intake.flagged && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">Flagged for the office</span>}
    </div>
  );
}
