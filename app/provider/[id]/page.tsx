"use client";

// Provider view: patient list + Sour summary for the selected patient. Owner: Justin.
// Uses GET /api/provider?id=, GET /api/patient/[id], POST /api/sour.

import { use, useEffect, useState } from "react";
import GlucoseChart from "@/components/GlucoseChart";
import type { PatientBundle } from "@/lib/types";

type Row = { id: string; name: string; apptAt: string | null; uploads: string[]; hasSummary: boolean };

export default function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [provider, setProvider] = useState<{ name: string; practice: string | null; patients: Row[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bundle, setBundle] = useState<PatientBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [invite, setInvite] = useState<string>("");

  async function sendLink(patientId: string) {
    setInvite("Sending…");
    const res = await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId }) });
    const d = await res.json();
    const parts = [d.sms?.sent ? "texted" : `SMS: ${d.sms?.error}`, d.email?.sent ? "emailed" : `email: ${d.email?.error}`];
    setInvite(`${parts.join(" · ")} · ${d.link}`);
  }

  useEffect(() => {
    fetch(`/api/provider?id=${id}`).then((r) => r.json()).then(setProvider);
  }, [id]);

  useEffect(() => {
    if (!selected) return;
    fetch(`/api/patient/${selected}`).then((r) => r.json()).then(setBundle);
  }, [selected]);

  async function generate() {
    if (!selected) return;
    setBusy(true);
    await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: selected }) });
    setBundle(await (await fetch(`/api/patient/${selected}`)).json());
    setBusy(false);
  }

  async function askSour(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: selected, question: q }) });
    setAnswer((await res.json()).answer);
  }

  const s = bundle?.providerSummary;

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-6 md:grid-cols-[260px_1fr]">
      <aside>
        <h1 className="text-lg font-bold">{provider?.name ?? "…"}</h1>
        <p className="text-sm text-gray-500">{provider?.practice}</p>
        <ul className="mt-4 space-y-1">
          {provider?.patients.map((p) => (
            <li key={p.id}>
              <button onClick={() => setSelected(p.id)} className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-gray-100 ${selected === p.id ? "bg-gray-100 font-medium" : ""}`}>
                {p.name} <span className="text-gray-400">{p.uploads.join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section>
        {!bundle ? (
          <p className="text-gray-500">Select a patient.</p>
        ) : (
          <div className="space-y-6">
            <header className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">Sour 🍋 · {bundle.patient.name}</h2>
              <div className="flex gap-2">
                <button onClick={() => sendLink(bundle.patient.id)} className="rounded border px-3 py-1.5 text-sm">Send link</button>
                <button onClick={generate} disabled={busy} className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">
                  {busy ? "Summarizing…" : s ? "Regenerate" : "Generate summary"}
                </button>
              </div>
            </header>
            {invite && <p className="break-all rounded bg-blue-50 p-2 text-xs text-gray-700">{invite}</p>}

            {s && (
              <div className="grid grid-cols-3 gap-3 text-center">
                <Stat label="Time in range" value={`${Math.round(s.timeInRange * 100)}%`} />
                <Stat label="Average" value={`${s.avgGlucose} mg/dL`} />
                <Stat label="Spikes" value={String(s.spikes.length)} />
              </div>
            )}

            <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} />

            {s && (
              <div className="grid gap-4 md:grid-cols-2">
                <List title="Spikes" items={s.spikes.map((x) => `${new Date(x.peak).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })} → ${x.to} mg/dL${x.visit ? ` after ${x.visit.place}` : ""}`)} />
                <List title="Patterns" items={s.patterns} />
                <List title="Ask the patient" items={s.questions} />
                <div>
                  <h3 className="font-semibold">Patient notes</h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{s.patientNotes || "—"}</p>
                </div>
              </div>
            )}

            <form onSubmit={askSour} className="flex gap-2">
              <input className="flex-1 rounded border p-2 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask Sour: why was Tuesday bad?" />
              <button className="rounded border px-3 text-sm">Ask</button>
            </form>
            {answer && <p className="rounded bg-yellow-50 p-3 text-sm">{answer}</p>}
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700">{items.length ? items.map((x, i) => <li key={i}>{x}</li>) : <li className="list-none text-gray-400">—</li>}</ul>
    </div>
  );
}
