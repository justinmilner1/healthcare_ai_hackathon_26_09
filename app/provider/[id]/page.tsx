"use client";

// Sour view: the one-page summary the endocrinologist reads during the visit, with a sidebar of ready summaries.
// Patient management (add, send link, progress) lives at /provider. Owner: Justin.
// Uses GET /api/provider?id=, GET /api/patient/[id], POST /api/sour, POST /api/invite. Print gives the one-pager.

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { rememberProvider } from "@/lib/providerSession";
import Disclaimer from "@/components/Disclaimer";
import GlucoseChart from "@/components/GlucoseChart";
import PersonaBrand from "@/components/PersonaBrand";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import StatTile from "@/components/StatTile";
import { visitLabel } from "@/lib/visits";
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
    // Plain feedback for the clinician; the raw channel errors stay in the response for debugging.
    if (d.email?.sent || d.sms?.sent) setInvite(`Link sent by ${[d.email?.sent && "email", d.sms?.sent && "text"].filter(Boolean).join(" and ")}.`);
    else setInvite(`Couldn't send the link automatically. Share it directly: ${d.link}`);
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
    <main className="ss-page sour-theme sour-summary-page print:block print:p-0">
      <div className="sour-summary-layout">
      <aside className="sour-summary-sidebar print:hidden">
        <PersonaBrand persona="sour" context="Clinical summary" href="/provider" />
        <Link href="/provider" className="sour-back-link">← All patients</Link>
        <div className="sour-practice">
          <span>Practice</span>
          <h1>{provider?.name ?? "…"}</h1>
          <p>{provider?.practice}</p>
        </div>
        <p className="sour-sidebar-label">Summaries ready</p>
        <ul className="sour-patient-list">
          {visible.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p.id)}
                className={selected === p.id ? "sour-patient-active" : ""}
              >
                <span className="sour-patient-initial">{p.name.charAt(0)}</span>
                <span>
                <strong>{p.name}</strong>
                <small>
                  {p.apptAt ? new Date(p.apptAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "no visit date"}
                  {p.uploads.length ? ` · ${p.uploads.length} source${p.uploads.length > 1 ? "s" : ""}` : " · nothing uploaded"}
                </small>
                </span>
                {p.hasSummary && <i>✓</i>}
              </button>
            </li>
          ))}
          {provider && visible.length === 0 && (
            <li className="sour-sidebar-empty">
              No summaries yet. <Link href="/provider" className="underline">Manage patients</Link>.
            </li>
          )}
        </ul>
        <div className="sour-sidebar-note">
          <span>✦</span>
          <p>Numbers first. Patterns second. Always verify with the patient.</p>
        </div>
      </aside>

      <section className={`sour-summary-content ${loading && bundle ? "sour-content-loading" : ""}`}>
        {summaryError && <p role="alert" className="ss-error">{summaryError}</p>}
        {!bundle ? (
          <div className="sour-select-empty">
            <span>🍋</span>
            <p>{loading ? "Sour is reading the week…" : "Select a patient summary."}</p>
          </div>
        ) : (
          <article className="sour-brief ss-enter">
            {bundle.patient.isSandbox && (
              <div role="note" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
                <strong>Synthetic data — Dexcom sandbox demo only.</strong> This is a dedicated demo patient, not a real patient record. Do not use these data for care decisions.
              </div>
            )}
            <header className="sour-brief-header">
              <div>
                <div className="ss-eyebrow">SOUR · PRE-VISIT SUMMARY</div>
                <h2>{bundle.patient.name}</h2>
                <p>
                  {visitLabel(bundle.patient.visitType)}
                  {bundle.patient.apptAt ? ` · ${new Date(bundle.patient.apptAt).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}` : " · no visit date"}
                  {st && st.readings > 0 && ` · ${st.days} days · ${st.readings.toLocaleString()} readings`}
                  {sources && ` · ${sources}`}
                </p>
                {bundle.patient.reason && <p className="sour-called-about">Called about: <strong>{bundle.patient.reason}</strong></p>}
              </div>
              <div className="sour-brief-actions print:hidden">
                <button onClick={() => sendLink(bundle.patient.id)} className="ss-button">Send link</button>
                <button onClick={() => window.print()} className="ss-button">Print</button>
                <button onClick={() => generate(bundle.patient.id)} disabled={busy || (!bundle.status.hasDexcom && bundle.status.answered === 0)} className="ss-button ss-button-primary">
                  {busy ? "Summarizing…" : s ? "Regenerate" : "Generate"}
                </button>
              </div>
            </header>
            {invite && <p className="ss-notice sour-invite-note print:hidden">{invite}</p>}
            {bundle.intake?.flagged && (
              <p className="ss-error sour-safety-flag">
                <span className="font-semibold">Safety flag during intake:</span> {bundle.intake.flagged.replace(/_/g, " ")}. Sweetie stopped the interview and told the patient to call the office. Review before the visit.
              </p>
            )}
            {s?.flags && s.flags.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <div className="font-semibold">Glucose safety flags <span className="font-normal text-red-800/70">(computed from the readings, not by the model)</span></div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {s.flags.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </div>
            )}

            {!bundle.status.hasDexcom && bundle.status.answered === 0 ? (
              <EmptyIntake bundle={bundle} />
            ) : (
              <>
                <section className="sour-card sour-overview-card">
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
                  <p className="ss-notice">No glucose data was shared. This summary is from the conversation only.</p>
                )}
                {st && bundle.status.hasDexcom && (
                  <section className="sour-card sour-metrics-card">
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
                <section className="sour-card sour-chart-card">
                  <h3 className="text-sm font-semibold">Glucose, last {st?.days ?? 7} days</h3>
                  <p className="text-xs text-[var(--viz-muted)]">Shaded band is 70–180 mg/dL. Red markers are spikes, labeled with the place the patient had just left.</p>
                  <div className="mt-2">
                    <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} />
                  </div>
                </section>
                )}

                {bundle.status.hasDexcom && (
                <div className="sour-card-grid">
                  <section className="sour-card">
                    <h3 className="text-sm font-semibold">Spikes linked to places</h3>
                    <div className="mt-2">
                      <SpikeTable spikes={bundle.spikes} />
                    </div>
                  </section>
                  <section className="sour-card">
                    <h3 className="text-sm font-semibold">Sleep</h3>
                    <div className="mt-2">
                      <SleepChart nights={bundle.sleep} />
                    </div>
                  </section>
                </div>
                )}

                <section className="sour-ask-card print:hidden">
                  <div className="sour-ask-heading">
                    <span>✦</span>
                    <div>
                      <strong>Discuss with Sour</strong>
                      <small>Ask about this patient&apos;s data · recent turns provide context</small>
                    </div>
                  </div>
                  <ol aria-live="polite" className="sour-answers">
                    {qa.map((x, i) => (
                      <li key={i}>
                        <div className="sour-answer-question">
                          <small>You</small>
                          <p className="mt-1 whitespace-pre-wrap break-words">{x.q}</p>
                        </div>
                        <div className="sour-answer-reply">
                          <small>Sour</small>
                          <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{x.a}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {asking && <p role="status" className="sour-chat-status">Sour is reviewing your question…</p>}
                  {chatError && <p role="alert" className="ss-error">{chatError}</p>}
                  <form onSubmit={askSour}>
                    <input aria-label="Message Sour" maxLength={4000} className="ss-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about the glucose spikes or sleep data…" disabled={asking} />
                    <button className="ss-button ss-button-accent" disabled={asking || !q.trim()}>{asking ? "Thinking…" : "Send →"}</button>
                  </form>
                </section>
              </>
            )}

            <footer className="sour-disclaimer">
              <Disclaimer audience="provider" generatedAt={bundle.providerSummaryAt} />
            </footer>
          </article>
        )}
      </section>
      </div>
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
    <section className="sour-card sour-waiting">
      <span className="sour-waiting-icon">⌛</span>
      <h3>Waiting on the patient</h3>
      <p>Nothing to summarize until the patient has talked to Sweetie. Send the link again if they have not opened it.</p>
      <ul>
        {rows.map(([label, ok]) => (
          <li key={label} className={ok ? "sour-waiting-done" : ""}>
            <span>{ok ? "✓" : ""}</span>
            <em>{label}</em>
          </li>
        ))}
      </ul>
    </section>
  );
}
