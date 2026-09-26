"use client";

// Sweetie chat + data upload, reached from the presigned link. Owner: Nisarga.
// Uses GET/POST /api/sweetie and POST /api/upload. This is a working skeleton; make it pretty.

import { use, useEffect, useRef, useState } from "react";
import type { ChatMessage, IntakeStatus, UploadKind } from "@/lib/types";

export default function SweetiePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/sweetie?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setMessages(d.messages ?? []);
        setStatus(d.status ?? null);
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
    setBusy(false);
  }

  async function upload(kind: UploadKind, file: File) {
    const fd = new FormData();
    fd.set("token", token);
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    const note = res.ok ? `Uploaded ${kind}: ${d.count} rows.` : `Upload failed: ${d.error}`;
    setMessages((m) => [...m, { role: "sweetie", content: note }]);
    if (d.status) setStatus(d.status);
  }

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col p-4">
      <h1 className="text-xl font-bold">Sweetie 🍬</h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <UploadButton label="Dexcom CSV" kind="dexcom" done={status?.hasDexcom} onFile={upload} />
        <UploadButton label="Maps Timeline JSON" kind="timeline" done={status?.hasLocation} onFile={upload} />
        <UploadButton label="WHOOP CSV" kind="whoop" done={status?.hasWhoop} onFile={upload} />
      </div>

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

function UploadButton({ label, kind, done, onFile }: { label: string; kind: UploadKind; done?: boolean; onFile: (k: UploadKind, f: File) => void }) {
  return (
    <label className={`cursor-pointer rounded border px-2 py-1 ${done ? "bg-green-100" : "bg-white"}`}>
      {done ? "✓ " : ""}{label}
      <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(kind, e.target.files[0])} />
    </label>
  );
}
