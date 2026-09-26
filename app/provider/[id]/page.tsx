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
    const b = (await (await fetch(`/api/patient/${pid}`)).json()) as PatientBundle;
    setBundle(b);
    setLoading(false);
    return b;
  }, []);

  const generate = useCallback(
    async (pid: string) => {
      setBusy(true);
      await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: pid }) });
      await load(pid);
      setBusy(false);
    },
    [load],
  );

  useEffect(() => {
    if (!selected) return;
    setQa([]);
    setChecked(new Set());
    setInvite("");
    load(selected).then((b) => {
      // First open with data but no summary: generate without asking.
      if (b && !b.providerSummary && b.status.hasDexcom && autoTried.current !== selected) {
        autoTried.current = selected;
        generate(selected);
      }
    });
  }, [selected, load, generate]);

  async function sendLink(pid: string) {
    setInvite("Sending…");
    const d = await (await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: pid }) })).json();
    const parts = [d.sms?.sent ? "texted" : `SMS: ${d.sms?.error}`, d.email?.sent ? "emailed" : `email: ${d.email?.error}`];
    setInvite(`${parts.join(" · ")} · ${d.link}`);
  }

  async function askSour(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !q.trim()) return;
    const question = q.trim();
    setQ("");
    setAsking(true);
    const d = await (await fetch("/api/sour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patientId: selected, question }) })).json();
    setQa((x) => [...x, { q: question, a: d.answer ?? d.error ?? "" }]);
    setAsking(false);
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
        {!bundle ? (
          <div className="sour-select-empty">
            <span>🍋</span>
            <p>{loading ? "Sour is reading the week…" : "Select a patient summary."}</p>
          </div>
        ) : (
          <article className="sour-brief ss-enter">
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
                <button onClick={() => generate(bundle.patient.id)} disabled={busy || !bundle.status.hasDexcom} className="ss-button ss-button-primary">
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

            {!bundle.status.hasDexcom ? (
              <EmptyIntake bundle={bundle} />
            ) : (
              <>
                <section className="sour-card sour-overview-card">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold">Summary</h3>
                    {st && (
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

                {st && (
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

                <section className="sour-card sour-chart-card">
                  <h3 className="text-sm font-semibold">Glucose, last {st?.days ?? 7} days</h3>
                  <p className="text-xs text-[var(--viz-muted)]">Shaded band is 70–180 mg/dL. Red markers are spikes, labeled with the place the patient had just left.</p>
                  <div className="mt-2">
                    <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} />
                  </div>
                </section>

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

                <section className="sour-ask-card print:hidden">
                  <div className="sour-ask-heading">
                    <span>✦</span>
                    <div>
                      <strong>Ask Sour</strong>
                      <small>Follow up on this patient&apos;s data</small>
                    </div>
                  </div>
                  <form onSubmit={askSour}>
                    <input className="ss-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Why was Tuesday different?" disabled={asking} />
                    <button className="ss-button ss-button-accent" disabled={asking || !q.trim()}>{asking ? "Thinking…" : "Ask →"}</button>
                  </form>
                  <ul className="sour-answers">
                    {qa.map((x, i) => (
                      <li key={i}>
                        <small>{x.q}</small>
                        <div>{x.a}</div>
                      </li>
                    ))}
                  </ul>
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
  const rows = [
    ["Dexcom glucose", bundle.status.hasDexcom],
    ["Location timeline", bundle.status.hasLocation],
    ["WHOOP sleep", bundle.status.hasWhoop],
    [`Sweetie questions (${bundle.status.answered} of 3)`, bundle.status.answered >= 3],
  ] as const;
  return (
    <section className="sour-card sour-waiting">
      <span className="sour-waiting-icon">⌛</span>
      <h3>Waiting on the patient</h3>
      <p>Nothing to summarize until glucose data arrives. Send the link again if they have not opened it.</p>
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
