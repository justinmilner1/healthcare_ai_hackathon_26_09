"use client";

// Patient view of their own week. Owner: Justin. Uses GET /api/patient/[id] (id or presigned token).
// Same data as the provider page, warmer voice, no clinical jargon, links back to Sweetie if intake is unfinished.

import { use, useEffect, useState } from "react";
import Disclaimer from "@/components/Disclaimer";
import GlucoseChart from "@/components/GlucoseChart";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import type { PatientBundle } from "@/lib/types";

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [bundle, setBundle] = useState<PatientBundle | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch(`/api/patient/${id}`).then(async (r) => {
      if (!r.ok) return setMissing(true);
      setBundle(await r.json());
    });
  }, [id]);

  if (missing) return <main className="mx-auto max-w-xl p-8 text-[var(--viz-ink-2)]">We couldn&apos;t find that link. Check the text or email from your doctor&apos;s office.</main>;
  if (!bundle) return <main className="mx-auto max-w-xl p-8 text-[var(--viz-muted)]">Loading your week…</main>;

  const first = bundle.patient.name.split(" ")[0];
  const s = bundle.patientSummary;
  const st = bundle.stats;
  const daysToVisit = bundle.patient.apptAt ? Math.ceil((Date.parse(bundle.patient.apptAt) - Date.now()) / 86400000) : null;
  const tirPct = Math.round(st.tir * 100);

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-6">
      <header>
        <div className="text-xs uppercase tracking-wide text-[var(--viz-muted)]">Sweet Spot 🍬</div>
        <h1 className="text-2xl font-bold">Your week, {first}</h1>
        <p className="text-sm text-[var(--viz-ink-2)]">
          {daysToVisit === null
            ? `Getting ready for your visit with ${bundle.patient.provider.name}.`
            : daysToVisit > 1
              ? `${daysToVisit} days until your visit with ${bundle.patient.provider.name}.`
              : daysToVisit === 1
                ? `Your visit with ${bundle.patient.provider.name} is tomorrow.`
                : `Your visit with ${bundle.patient.provider.name}.`}
        </p>
      </header>

      {!bundle.status.hasDexcom ? (
        <section className="rounded-lg border border-dashed border-black/20 p-5">
          <h2 className="font-semibold">We don&apos;t have your glucose data yet</h2>
          <p className="mt-1 text-sm text-[var(--viz-ink-2)]">Once you share your Dexcom export with Sweetie, your week will show up here.</p>
          <a href={`/s/${bundle.patient.token}/intake`} className="mt-3 inline-block rounded-md bg-black px-4 py-2 text-sm text-white">Open Sweetie</a>
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-5">
            <div className="text-5xl font-semibold leading-none">{tirPct}%</div>
            <p className="mt-2 text-lg leading-snug">
              of the time your glucose was in the 70 to 180 range{tirPct >= 70 ? ", which is where most people aim." : "."}
            </p>
            <p className="mt-1 text-sm text-[var(--viz-ink-2)]">
              {st.days} days · average {st.avg} mg/dL
              {st.sleepAvgHours !== null && ` · about ${st.sleepAvgHours} hours of sleep a night`}
            </p>
            <div className="mt-4">
              <RangeBar tbr={st.tbr} tir={st.tir} tar={st.tar} />
            </div>
          </section>

          <section>
            <h2 className="font-semibold">Your glucose</h2>
            <p className="text-sm text-[var(--viz-muted)]">Red markers are the biggest rises, labeled with where you had just been.</p>
            <div className="mt-2 rounded-lg border border-black/10 bg-[var(--viz-surface)] p-3">
              <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} height={240} />
            </div>
            {bundle.spikes.length > 0 && (
              <div className="mt-3 rounded-lg border border-black/10 bg-[var(--viz-surface)] p-3">
                <SpikeTable spikes={bundle.spikes} compact />
              </div>
            )}
          </section>

          {bundle.sleep.length > 0 && (
            <section>
              <h2 className="font-semibold">Your sleep</h2>
              <div className="mt-2 rounded-lg border border-black/10 bg-[var(--viz-surface)] p-3">
                <SleepChart nights={bundle.sleep} height={180} />
              </div>
            </section>
          )}

          {s ? (
            <>
              {s.patterns.length > 0 && <section>
                <h2 className="font-semibold">What your week showed</h2>
                <ul className="mt-2 space-y-2 text-[15px] leading-snug">
                  {s.patterns.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--viz-series)]" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </section>}
              {s.questions.length > 0 && <section>
                <h2 className="font-semibold">Things you might ask your doctor</h2>
                <ul className="mt-2 space-y-2 text-[15px] leading-snug">
                  {s.questions.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-[var(--viz-muted)]">{i + 1}.</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </section>}
            </>
          ) : (
            <section className="rounded-lg border border-black/10 p-4 text-sm text-[var(--viz-ink-2)]">
              Your doctor&apos;s office is preparing a short summary of your week. It will appear here.
            </section>
          )}

          {bundle.patient.notes && (
            <section>
              <h2 className="font-semibold">What you told Sweetie</h2>
              <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-black/15 pl-3 text-sm italic text-[var(--viz-ink-2)]">{bundle.patient.notes}</blockquote>
            </section>
          )}

          {!bundle.status.done && (
            <a href={`/s/${bundle.patient.token}`} className="block rounded-md border border-black/15 px-4 py-2 text-center text-sm hover:bg-black/5">
              Finish your chat with Sweetie →
            </a>
          )}
        </>
      )}

      <footer className="border-t border-black/10 pt-3">
        <Disclaimer audience="patient" generatedAt={bundle.patientSummaryAt} />
      </footer>
    </main>
  );
}
