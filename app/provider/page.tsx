"use client";

// Provider dashboard: every patient with where they are in the flow, add a booked patient, send links,
// open ready summaries in Sour. Owner: Justin. No login in the demo: the provider is a cookie (lib/providerSession).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { currentProvider, forgetProvider, rememberProvider } from "@/lib/providerSession";
import { VISIT_TYPES, visitLabel } from "@/lib/sweetie";

type Row = {
  id: string;
  name: string;
  apptAt: string | null;
  visitType: string | null;
  reason: string | null;
  token: string;
  phone: string | null;
  email: string | null;
  uploads: string[];
  answered: number;
  required: number;
  flagged: string | null;
  wrapped: boolean;
  hasSummary: boolean;
  summaryAt: string | null;
};
type Provider = { id: string; name: string; practice: string | null; patients: Row[] };
type Choice = { id: string; name: string; practice: string | null; patients: number };

export default function ProviderDashboard() {
  const [pid, setPid] = useState<string | null | undefined>(undefined);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", apptAt: "", visitType: "follow_up", reason: "", optIn: true });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowNote, setRowNote] = useState<Record<string, string>>({});

  const load = useCallback(async (id: string) => {
    const r = await fetch(`/api/provider?id=${id}`);
    if (!r.ok) {
      forgetProvider();
      setPid(null);
      return;
    }
    setProvider(await r.json());
  }, []);

  useEffect(() => {
    const id = currentProvider();
    setPid(id);
    if (id) load(id);
    else fetch("/api/provider?list=1").then((r) => r.json()).then(setChoices);
  }, [load]);

  async function addPatient(e: React.FormEvent) {
    e.preventDefault();
    if (!pid) return;
    setBusy(true);
    setNote("");
    const res = await fetch("/api/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, providerId: pid, apptAt: form.apptAt || undefined }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) return setNote(d.error ?? "Could not add patient.");
    const sent = [d.sms?.sent && "texted", d.email?.sent && "emailed"].filter(Boolean);
    const why = [!d.sms?.sent && d.sms?.error, !d.email?.sent && d.email?.error].filter(Boolean).join("; ");
    setNote(sent.length ? `Added ${form.name}. Invite ${sent.join(" and ")}.` : `Added ${form.name}. No invite went out (${why}). Link: ${d.link}`);
    setForm({ name: "", phone: "", email: "", apptAt: "", visitType: "follow_up", reason: "", optIn: true });
    load(pid);
  }

  async function sendLink(p: Row) {
    setRowNote((n) => ({ ...n, [p.id]: "Sending…" }));
    const d = await (await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: p.id }) })).json();
    const sent = [d.sms?.sent && "texted", d.email?.sent && "emailed"].filter(Boolean);
    setRowNote((n) => ({ ...n, [p.id]: sent.length ? sent.join(" and ") : `not sent: ${[d.sms?.error, d.email?.error].filter(Boolean).join("; ")}` }));
  }

  if (pid === undefined) return <main className="p-8 text-[var(--viz-muted)]">Loading…</main>;

  if (!pid) {
    return (
      <main className="mx-auto max-w-md space-y-6 p-8">
        <h1 className="text-2xl font-bold">Which practice?</h1>
        <p className="text-sm text-[var(--viz-ink-2)]">Demo only, no passwords. Pick your provider or create one.</p>
        <ul className="space-y-2">
          {choices?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  rememberProvider(c.id);
                  setPid(c.id);
                  load(c.id);
                }}
                className="w-full rounded-md border border-black/15 px-3 py-2 text-left hover:bg-black/5"
              >
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-[var(--viz-muted)]">{c.practice ?? "—"} · {c.patients} patient{c.patients === 1 ? "" : "s"}</div>
              </button>
            </li>
          ))}
          {choices && choices.length === 0 && <li className="text-sm text-[var(--viz-muted)]">No providers yet.</li>}
        </ul>
        <Link href="/provider/signup" className="inline-block rounded-md bg-black px-4 py-2 text-sm text-white">Create a provider</Link>
      </main>
    );
  }

  const ready = provider?.patients.filter((p) => p.hasSummary).length ?? 0;

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--viz-muted)]">Sweet Spot · practice dashboard</div>
          <h1 className="text-2xl font-bold">{provider?.name ?? "…"}</h1>
          <p className="text-sm text-[var(--viz-ink-2)]">
            {provider?.practice}
            {provider && ` · ${provider.patients.length} patient${provider.patients.length === 1 ? "" : "s"} · ${ready} summar${ready === 1 ? "y" : "ies"} ready`}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          {provider && ready > 0 && (
            <Link href={`/provider/${provider.id}`} className="rounded-md bg-black px-3 py-1.5 text-white">Open Sour 🍋</Link>
          )}
          <button
            onClick={() => {
              forgetProvider();
              setPid(null);
              setProvider(null);
              fetch("/api/provider?list=1").then((r) => r.json()).then(setChoices);
            }}
            className="rounded-md border border-black/15 px-3 py-1.5 hover:bg-black/5"
          >
            Switch practice
          </button>
        </div>
      </header>

      <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
        <h2 className="font-semibold">Add a booked patient</h2>
        <p className="text-xs text-[var(--viz-muted)]">
          Stands in for the scheduling system. The visit type and what the patient called about become Sweetie&apos;s brief: they decide what she asks. Saving creates the patient and, if they opted in, sends the link by text or email.
        </p>
        <form onSubmit={addPatient} className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1.4fr_1.2fr]">
            <input required placeholder="Patient name" className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Mobile, +1415…" className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input type="email" placeholder="Email" className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input type="datetime-local" className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.apptAt} onChange={(e) => setForm({ ...form, apptAt: e.target.value })} title="Visit date and time" />
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_3fr_auto]">
            <select className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.visitType} onChange={(e) => setForm({ ...form, visitType: e.target.value })} title="Visit type">
              {VISIT_TYPES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <input placeholder="What the patient called about, e.g. mornings running high, wants to discuss a pump" className="rounded-md border border-black/15 px-2 py-1.5 text-sm" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            <button disabled={busy} className="rounded-md bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50">{busy ? "Saving…" : "Add + send link"}</button>
          </div>
        </form>
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--viz-ink-2)]">
          <input type="checkbox" checked={form.optIn} onChange={(e) => setForm({ ...form, optIn: e.target.checked })} /> Patient opted in to pre-visit messages
        </label>
        {note && <p className="mt-2 break-all text-sm text-[var(--viz-ink-2)]">{note}</p>}
      </section>

      <section>
        <h2 className="font-semibold">Patients</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-black/10 bg-[var(--viz-surface)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--viz-ink-2)]">
                <th className="px-3 py-2 font-medium">Patient</th>
                <th className="px-3 py-2 font-medium">Visit</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Sweetie</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {provider?.patients.map((p) => (
                <tr key={p.id} className="border-t border-black/5 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-[var(--viz-muted)]">{[p.phone, p.email].filter(Boolean).join(" · ") || "no contact on file"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="whitespace-nowrap">{p.apptAt ? new Date(p.apptAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : <span className="text-[var(--viz-muted)]">—</span>}</div>
                    <div className="text-xs text-[var(--viz-muted)]">{visitLabel(p.visitType)}{p.reason ? ` · ${p.reason}` : ""}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2"><Stage p={p} /></td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(["dexcom", "timeline", "whoop"] as const).map((k) => (
                        <span key={k} className={`rounded-full px-2 py-0.5 text-[11px] ${p.uploads.includes(k) ? "bg-green-100 text-green-800" : "bg-black/5 text-[var(--viz-muted)]"}`}>
                          {p.uploads.includes(k) ? "✓ " : ""}{k === "dexcom" ? "Dexcom" : k === "timeline" ? "Timeline" : "WHOOP"}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {p.answered}/{p.required} answered
                    {p.flagged && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-800">flagged</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => sendLink(p)} className="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5">Send link</button>
                      {p.hasSummary ? (
                        <Link href={`/provider/${provider.id}?patient=${p.id}`} className="rounded-md bg-black px-2 py-1 text-xs text-white">Open in Sour</Link>
                      ) : p.uploads.includes("dexcom") || p.answered > 0 ? (
                        <Link href={`/provider/${provider.id}?patient=${p.id}`} className="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5">Summarize</Link>
                      ) : null}
                    </div>
                    {rowNote[p.id] && <div className="mt-1 text-[11px] text-[var(--viz-muted)]">{rowNote[p.id]}</div>}
                  </td>
                </tr>
              ))}
              {provider && provider.patients.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-[var(--viz-muted)]">No patients yet. Add the first booked visit above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Stage({ p }: { p: Row }) {
  const s = p.hasSummary ? "ready" : p.wrapped ? "finished" : p.answered > 0 ? "chatting" : p.uploads.length ? "uploading" : "invited";
  const cls = { ready: "bg-green-100 text-green-800", finished: "bg-blue-100 text-blue-900", chatting: "bg-blue-50 text-blue-800", uploading: "bg-amber-50 text-amber-800", invited: "bg-black/5 text-[var(--viz-ink-2)]" }[s];
  const label = { ready: "Summary ready", finished: "Intake finished", chatting: "Talking to Sweetie", uploading: "Shared data", invited: "Invited" }[s];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] ${cls}`}>{label}</span>;
}
