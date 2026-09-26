"use client";

// Sour view: the one-page summary the endocrinologist reads during the visit, with a sidebar of ready summaries.
// Patient management (add, send link, progress) lives at /provider. Owner: Justin.
// Uses GET /api/provider?id=, GET /api/patient/[id], POST /api/sour, POST /api/invite. Print gives the one-pager.

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { rememberProvider } from "@/lib/providerSession";
import Disclaimer from "@/components/Disclaimer";
import GlucoseChart from "@/components/GlucoseChart";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import StatTile from "@/components/StatTile";
import { visitLabel } from "@/lib/sweetie";
import type { PatientBundle } from "@/lib/types";

type Row = { id: string; name: string; apptAt: string | null; uploads: string[]; hasSummary: boolean };
type Provider = { name: string; practice: string | null; patients: Row[] };

export default function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [bundle, setBundle] = useState<PatientBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [qa, setQa] = useState<{ q: string; a: string }[]>([]);
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [chatError, setChatError] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const activePatient = useRef<string | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const autoTried = useRef<string | null>(null);

  useEffect(() => {
    fetch(`/api/provider?id=${id}`)
      .then((r) => r.json())
      .then((p: Provider) => {
        setProvider(p);
        // ?patient=<id> deep-links from the summary email; otherwise open the first patient.
        rememberProvider(id);
        const wanted = new URLSearchParams(window.location.search).get("patient");
        const first = p.patients?.find((x) => x.id === wanted)?.id ?? p.patients?.find((x) => x.hasSummary)?.id;
        if (first && !selected) setSelected(first);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const load = useCallback(async (pid: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/patient/${pid}`);
      if (!res.ok) throw new Error("Could not load this patient's summary.");
      const b = (await res.json()) as PatientBundle;
      if (activePatient.current === pid) setBundle(b);
      return b;
    } finally {
      if (activePatient.current === pid) setLoading(false);
    }
  }, []);

  const generate = useCallback(
    async (pid: string) => {
      setBusy(true);
      setSummaryError("");
      try {
        const res = await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: pid }) });
        if (!res.ok) throw new Error("Could not generate the summary. Please retry.");
        if (activePatient.current === pid) await load(pid);
      } catch (e) {
        if (activePatient.current === pid) setSummaryError(e instanceof Error ? e.message : "Summary generation failed.");
      } finally {
        if (activePatient.current === pid) setBusy(false);
      }
    },
    [load],
  );

  useEffect(() => {
    if (!selected) return;
    activePatient.current = selected;
    setBundle(null);
    setQa([]);
    setQ("");
    setAsking(false);
    setBusy(false);
    setChatError("");
    setSummaryError("");
    setChecked(new Set());
    setInvite("");
    load(selected).then((b) => {
      // First open with data but no summary: generate without asking.
      if (activePatient.current === selected && b && !b.providerSummary && b.status.hasDexcom && autoTried.current !== selected) {
        autoTried.current = selected;
        generate(selected);
      }
    }).catch(() => {
      if (activePatient.current === selected) setSummaryError("Could not load this patient. Please select them again.");
    });
    return () => { activePatient.current = null; };
  }, [selected, load, generate]);

  async function sendLink(pid: string) {
    setInvite("Sending…");
    const d = await (await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: pid }) })).json();
    const parts = [d.sms?.sent ? "texted" : `SMS: ${d.sms?.error}`, d.email?.sent ? "emailed" : `email: ${d.email?.error}`];
    setInvite(`${parts.join(" · ")} · ${d.link}`);
  }

  async function askSour(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !q.trim() || asking) return;
    const pid = selected;
    const question = q.trim();
    setAsking(true);
    setChatError("");
    try {
      const res = await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: pid, question, history: qa.slice(-6) }) });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof d?.error === "string" ? d.error : "Sour could not answer. Please try again.");
      if (typeof d?.answer !== "string" || !d.answer.trim()) throw new Error("Sour returned an empty reply. Please try again.");
      if (activePatient.current !== pid) return;
      setQa((x) => [...x, { q: question, a: d.answer }]);
      setQ("");
    } catch (e) {
      if (activePatient.current === pid) setChatError(e instanceof Error ? e.message : "Could not reach Sour. Please try again.");
    } finally {
      if (activePatient.current === pid) setAsking(false);
    }
  }

  const visible = (provider?.patients ?? []).filter((p) => p.hasSummary || p.id === selected);
  const s = bundle?.providerSummary;
  const st = bundle?.stats;
  const sources = bundle ? [bundle.status.hasDexcom && "Dexcom", bundle.status.hasLocation && "Timeline", bundle.status.hasWhoop && "WHOOP"].filter(Boolean).join(" · ") : "";

  return (
    <main className="mx-auto grid max-w-6xl gap-8 p-6 md:grid-cols-[240px_1fr] print:block print:p-0">
      <aside className="print:hidden">
        <Link href="/provider" className="text-xs text-[var(--viz-muted)] hover:underline">← All patients</Link>
        <h1 className="mt-1 text-lg font-bold">{provider?.name ?? "…"}</h1>
        <p className="text-sm text-[var(--viz-ink-2)]">{provider?.practice}</p>
        <p className="mt-3 text-[11px] uppercase tracking-wide text-[var(--viz-muted)]">Summaries ready</p>
        <ul className="mt-1 space-y-1">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p.id)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-black/5 ${selected === p.id ? "bg-black/5 font-medium" : ""}`}
              >
                <div>{p.name}</div>
                <div className="text-xs text-[var(--viz-muted)]">
                  {p.apptAt ? new Date(p.apptAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "no visit date"}
                  {p.uploads.length ? ` · ${p.uploads.length} source${p.uploads.length > 1 ? "s" : ""}` : " · nothing uploaded"}
                  {p.hasSummary ? " · summary" : ""}
                </div>
              </button>
            </li>
          ))}
          {provider && visible.length === 0 && (
            <li className="text-sm text-[var(--viz-muted)]">
              No summaries yet. <Link href="/provider" className="underline">Manage patients</Link>.
            </li>
          )}
        </ul>

      </aside>

      <section className={loading && bundle ? "opacity-60 transition-opacity" : ""}>
        {summaryError && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-800">{summaryError}</p>}
        {!bundle ? (
          <p className="text-[var(--viz-muted)]">{loading ? "Loading…" : "Select a patient."}</p>
        ) : (
          <article className="space-y-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-[var(--viz-muted)]">Sour 🍋 pre-visit summary</div>
                <h2 className="text-2xl font-bold">{bundle.patient.name}</h2>
                <p className="text-sm text-[var(--viz-ink-2)]">
                  {visitLabel(bundle.patient.visitType)}
                  {bundle.patient.apptAt ? ` · ${new Date(bundle.patient.apptAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` : " · no visit date"}
                  {st && st.readings > 0 && ` · ${st.days} days · ${st.readings.toLocaleString()} readings`}
                  {sources && ` · ${sources}`}
                </p>
                {bundle.patient.reason && <p className="mt-0.5 text-sm">Called about: <span className="font-medium">{bundle.patient.reason}</span></p>}
              </div>
              <div className="flex gap-2 print:hidden">
                <button onClick={() => sendLink(bundle.patient.id)} className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5">Send link</button>
                <button onClick={() => window.print()} className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5">Print</button>
                <button onClick={() => generate(bundle.patient.id)} disabled={busy || (!bundle.status.hasDexcom && bundle.status.answered === 0)} className="rounded-md bg-black px-3 py-1.5 text-sm text-white disabled:opacity-40">
                  {busy ? "Summarizing…" : s ? "Regenerate" : "Generate"}
                </button>
              </div>
            </header>
            {invite && <p className="break-all rounded-md bg-blue-50 px-3 py-2 text-xs text-[var(--viz-ink-2)] print:hidden">{invite}</p>}
            {bundle.intake?.flagged && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <span className="font-semibold">Safety flag during intake:</span> {bundle.intake.flagged.replace(/_/g, " ")}. Sweetie stopped the interview and told the patient to call the office. Review before the visit.
              </p>
            )}

            {!bundle.status.hasDexcom && bundle.status.answered === 0 ? (
              <EmptyIntake bundle={bundle} />
            ) : (
              <>
                <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold">Summary</h3>
                    {st && bundle.status.hasDexcom && (
                      <p className="text-sm text-[var(--viz-ink-2)]">
                        In range <span className="font-semibold text-[var(--viz-ink)]">{Math.round(st.tir * 100)}%</span> · avg {st.avg} · GMI {st.gmi.toFixed(1)}% · {bundle.spikes.length} spikes
                        {st.sleepAvgHours !== null && ` · sleep ${st.sleepAvgHours}h`}
                      </p>
                    )}
                  </div>
                  <div className="mt-3">
                <div className="grid gap-6 md:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold">Patterns</h3>
                    {!s ? (
                      <p className="mt-1 text-sm text-[var(--viz-muted)]">{busy ? "Sour is reading the data…" : "No summary yet."}</p>
                    ) : (
                      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-snug">
                        {s.patterns.map((p, i) => <li key={i}>{p}</li>)}
                        {s.patterns.length === 0 && <li className="list-none text-[var(--viz-muted)]">None found.</li>}
                      </ol>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">Ask the patient</h3>
                    {!s ? (
                      <p className="mt-1 text-sm text-[var(--viz-muted)]">—</p>
                    ) : (
                      <ul className="mt-2 space-y-2 text-sm leading-snug">
                        {s.questions.map((qq, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1 print:hidden"
                              checked={checked.has(i)}
                              onChange={(e) => {
                                const n = new Set(checked);
                                if (e.target.checked) n.add(i);
                                else n.delete(i);
                                setChecked(n);
                              }}
                            />
                            <span className={checked.has(i) ? "text-[var(--viz-muted)] line-through" : ""}>{qq}</span>
                          </li>
                        ))}
                        {s.questions.length === 0 && <li className="text-[var(--viz-muted)]">None.</li>}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="mt-4">
                  <h3 className="text-sm font-semibold">In the patient&apos;s words</h3>
                  {bundle.patient.notes ? (
                    <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-black/15 pl-3 text-sm italic text-[var(--viz-ink-2)]">{bundle.patient.notes}</blockquote>
                  ) : (
                    <p className="mt-1 text-sm text-[var(--viz-muted)]">Sweetie has not collected answers yet.</p>
                  )}
                </div>
                  </div>
                </section>

                {!bundle.status.hasDexcom && (
                  <p className="rounded-md border border-black/10 bg-[var(--viz-surface)] px-3 py-2 text-sm text-[var(--viz-ink-2)]">No glucose data was shared. This summary is from the conversation only.</p>
                )}
                {st && bundle.status.hasDexcom && (
                  <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
                    <div className="flex flex-wrap items-end justify-between gap-4">
                      <div>
                        <div className="text-xs text-[var(--viz-ink-2)]">Time in range</div>
                        <div className="text-5xl font-semibold leading-none text-[var(--viz-ink)]">{Math.round(st.tir * 100)}%</div>
                        <div className="mt-1 text-xs text-[var(--viz-muted)]">goal ≥ 70% · below range goal &lt; 4%</div>
                      </div>
                      <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
                        <StatTile label="Average" value={String(st.avg)} unit="mg/dL" />
                        <StatTile label="GMI" value={st.gmi.toFixed(1)} unit="%" hint="est. A1c from CGM" />
                        <StatTile label="Spikes > 180" value={String(bundle.spikes.length)} hint={`${bundle.spikes.filter((x) => x.visit).length} linked to a place`} />
                        {st.sleepAvgHours !== null ? (
                          <StatTile label="Sleep" value={st.sleepAvgHours.toFixed(1)} unit="h/night" hint={st.recoveryAvg !== null ? `recovery ${st.recoveryAvg}%` : undefined} />
                        ) : (
                          <StatTile label="Sleep" value="—" hint="no WHOOP data" />
                        )}
                      </div>
                    </div>
                    <div className="mt-4">
                      <RangeBar tbr={st.tbr} tir={st.tir} tar={st.tar} />
                    </div>
                  </section>
                )}

                {bundle.status.hasDexcom && (
                <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
                  <h3 className="text-sm font-semibold">Glucose, last {st?.days ?? 7} days</h3>
                  <p className="text-xs text-[var(--viz-muted)]">Shaded band is 70–180 mg/dL. Red markers are spikes, labeled with the place the patient had just left.</p>
                  <div className="mt-2">
                    <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} />
                  </div>
                </section>
                )}

                {bundle.status.hasDexcom && (
                <div className="grid gap-6 md:grid-cols-2">
                  <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
                    <h3 className="text-sm font-semibold">Spikes linked to places</h3>
                    <div className="mt-2">
                      <SpikeTable spikes={bundle.spikes} />
                    </div>
                  </section>
                  <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-4">
                    <h3 className="text-sm font-semibold">Sleep</h3>
                    <div className="mt-2">
                      <SleepChart nights={bundle.sleep} />
                    </div>
                  </section>
                </div>
                )}

                <section className="rounded-lg border border-black/10 p-4 print:hidden">
                  <h3 className="text-sm font-semibold">Discuss with Sour</h3>
                  <p className="mt-1 text-xs text-[var(--viz-muted)]">Ask about this patient&apos;s data. Recent turns provide context; this conversation resets when you switch patients or reload.</p>
                  <ol aria-live="polite" className="mt-4 space-y-4">
                    {qa.map((x, i) => (
                      <li key={i} className="space-y-2 text-sm">
                        <div className="rounded-md bg-black/5 px-3 py-2">
                          <div className="text-xs font-semibold text-[var(--viz-ink-2)]">You</div>
                          <p className="mt-1 whitespace-pre-wrap break-words">{x.q}</p>
                        </div>
                        <div className="border-l-2 border-black/15 pl-3">
                          <div className="text-xs font-semibold text-[var(--viz-ink-2)]">Sour</div>
                          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{x.a}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {asking && <p role="status" className="mt-3 text-sm text-[var(--viz-muted)]">Sour is reviewing your question…</p>}
                  {chatError && <p role="alert" className="mt-3 text-sm text-red-700">{chatError}</p>}
                  <form onSubmit={askSour} className="mt-4 flex gap-2">
                    <input aria-label="Message Sour" maxLength={4000} className="min-w-0 flex-1 rounded-md border border-black/15 px-3 py-2 text-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about the glucose spikes or sleep data…" disabled={asking} />
                    <button className="rounded-md border border-black/15 px-3 text-sm hover:bg-black/5 disabled:opacity-40" disabled={asking || !q.trim()}>{asking ? "Thinking…" : "Send"}</button>
                  </form>
                </section>
              </>
            )}

            <footer className="border-t border-black/10 pt-3">
              <Disclaimer audience="provider" generatedAt={bundle.providerSummaryAt} />
            </footer>
          </article>
        )}
      </section>
    </main>
  );
}

function EmptyIntake({ bundle }: { bundle: PatientBundle }) {
  const total = bundle.intakeFields.length;
  const rows = [
    [`Sweetie conversation (${bundle.status.answered} of ${total} answered)`, bundle.status.answered >= total],
    ["Dexcom glucose (optional)", bundle.status.hasDexcom],
    ["Location timeline (optional)", bundle.status.hasLocation],
    ["WHOOP sleep (optional)", bundle.status.hasWhoop],
  ] as const;
  return (
    <section className="rounded-lg border border-dashed border-black/20 p-5">
      <h3 className="font-semibold">Waiting on the patient</h3>
      <p className="mt-1 text-sm text-[var(--viz-ink-2)]">Nothing to summarize until the patient has talked to Sweetie. Send the link again if they have not opened it.</p>
      <ul className="mt-3 space-y-1 text-sm">
        {rows.map(([label, ok]) => (
          <li key={label} className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-[var(--viz-good)]" : "bg-black/15"}`} />
            <span className={ok ? "" : "text-[var(--viz-muted)]"}>{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
