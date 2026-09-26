"use client";

// Patient view of their own week. Uses GET /api/patient/[id] (id or presigned token).
// Same data as the provider page, warmer voice, no clinical jargon.

import Image from "next/image";
import { use, useEffect, useState } from "react";
import Disclaimer from "@/components/Disclaimer";
import { DemoReturnLink } from "@/components/DexcomDemoLink";
import GlucoseChart from "@/components/GlucoseChart";
import PersonaBrand from "@/components/PersonaBrand";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import type { PatientBundle } from "@/lib/types";

export default function PatientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [bundle, setBundle] = useState<PatientBundle | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetch(`/api/patient/${id}`).then(async (response) => {
      if (!response.ok) return setMissing(true);
      setBundle(await response.json());
    });
  }, [id]);

  if (missing) {
    return (
      <PatientState message="We couldn't find that link. Check the text or email from your doctor's office." />
    );
  }

  if (!bundle) {
    return <PatientState message="Sweetie is getting your week ready…" />;
  }

  const first = bundle.patient.name.split(" ")[0];
  const summary = bundle.patientSummary;
  const stats = bundle.stats;
  const daysToVisit = bundle.patient.apptAt
    ? Math.ceil((Date.parse(bundle.patient.apptAt) - Date.now()) / 86400000)
    : null;
  const tirPct = Math.round(stats.tir * 100);
  const visitMessage =
    daysToVisit === null
      ? `Getting ready for your visit with ${bundle.patient.provider.name}.`
      : daysToVisit > 1
        ? `${daysToVisit} days until your visit with ${bundle.patient.provider.name}.`
        : daysToVisit === 1
          ? `Your visit with ${bundle.patient.provider.name} is tomorrow.`
          : `Your visit with ${bundle.patient.provider.name}.`;

  return (
    <main className="ss-page sweetie-theme patient-summary-page">
      <div className="ss-container patient-summary-container">
        <header className="ss-topbar patient-summary-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
          <a href={`/s/${bundle.patient.token}`} className="ss-button">
            Talk to Sweetie
          </a>
        </header>

        {bundle.patient.isSandbox && (
          <div role="note" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4 text-sm text-amber-950">
            <strong>Synthetic data — Dexcom sandbox demo only.</strong> This is a dedicated demo patient, not a real patient record. Do not use these data for care decisions.
            <div><DemoReturnLink token={bundle.patient.token} /></div>
          </div>
        )}

        <section className="patient-summary-hero ss-enter">
          <div className="patient-summary-hero-copy">
            <p className="ss-eyebrow">YOUR WEEK WITH SWEETIE</p>
            <h1>
              Here&apos;s your story,
              <br />
              <em>{first}.</em>
            </h1>
            <p>{visitMessage}</p>
            <div className="patient-summary-meta">
              {bundle.patient.visitType && (
                <span>{bundle.patient.visitType}</span>
              )}
              <span>
                {bundle.status.done ? "Check-in complete" : "Check-in in progress"}
              </span>
              <span>Private to your care team</span>
            </div>
          </div>
          <div className="patient-summary-character">
            <Image
              src="/assets/sweetie/sweetie.png"
              alt="Sweetie"
              width={320}
              height={320}
              priority
            />
          </div>
        </section>

        <div className="patient-summary-content">
          {!bundle.status.hasDexcom ? (
            <section className="patient-report-card patient-report-empty">
              <span aria-hidden="true">↗</span>
              <h2>Your glucose story is ready for its first chapter</h2>
              <p>
                {bundle.patient.isSandbox
                  ? "Connect Dexcom sandbox in Sweetie to import synthetic demo readings."
                  : "Connect your Dexcom export and Sweetie will turn the past week into a clear picture for you and your doctor."}
              </p>
              <a
                href={`/s/${bundle.patient.token}/intake`}
                className="ss-button ss-button-primary"
              >
                Connect Dexcom
              </a>
            </section>
          ) : (
            <>
              <section className="patient-overview">
                <article className="patient-report-card patient-range-card">
                  <div className="patient-range-number">
                    {tirPct}%
                    <small>Time in range</small>
                  </div>
                  <div className="patient-range-copy">
                    <p>
                      Your glucose was between 70 and 180 for {tirPct}% of the
                      week{tirPct >= 70 ? " — where most people aim." : "."}
                    </p>
                    <RangeBar
                      tbr={stats.tbr}
                      tir={stats.tir}
                      tar={stats.tar}
                    />
                  </div>
                </article>

                <div className="patient-mini-stats" aria-label="Week at a glance">
                  <MiniStat label="History" value={`${stats.days}`} detail="days" />
                  <MiniStat
                    label="Average"
                    value={`${stats.avg}`}
                    detail="mg/dL"
                  />
                  <MiniStat
                    label="Sleep"
                    value={
                      stats.sleepAvgHours === null
                        ? "—"
                        : `${stats.sleepAvgHours}`
                    }
                    detail={
                      stats.sleepAvgHours === null
                        ? "not connected"
                        : "hours / night"
                    }
                  />
                </div>
              </section>

              <section className="patient-report-card">
                <div className="patient-card-heading">
                  <div>
                    <h2>Your glucose</h2>
                    <p className="patient-report-subtitle">
                      Markers show your biggest rises and where you had just
                      been, when available.
                    </p>
                  </div>
                  <span>{stats.readings.toLocaleString()} readings</span>
                </div>
                <div className="patient-chart-wrap">
                  <GlucoseChart
                    readings={bundle.glucose}
                    spikes={bundle.spikes}
                    height={250}
                  />
                </div>
              </section>

              {bundle.spikes.length > 0 && (
                <section className="patient-report-card patient-spikes">
                  <h2>Your biggest rises</h2>
                  <p className="patient-report-subtitle">
                    A simple timeline to help you remember what was happening.
                  </p>
                  <SpikeTable spikes={bundle.spikes} compact />
                </section>
              )}

              <div className="patient-detail-grid">
                {bundle.sleep.length > 0 && (
                  <section className="patient-report-card">
                    <h2>Your sleep</h2>
                    <p className="patient-report-subtitle">
                      Nightly sleep and recovery from your connected data.
                    </p>
                    <div className="patient-chart-wrap">
                      <SleepChart nights={bundle.sleep} height={180} />
                    </div>
                  </section>
                )}

                {summary?.patterns.length ? (
                  <section className="patient-report-card">
                    <h2>What your week showed</h2>
                    <p className="patient-report-subtitle">
                      A few patterns worth noticing together.
                    </p>
                    <ul className="patient-pattern-list">
                      {summary.patterns.map((pattern, index) => (
                        <li key={pattern}>
                          <span>{index + 1}</span>
                          <span>{pattern}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>

              {summary?.questions.length ? (
                <section className="patient-report-card">
                  <h2>Things you might ask your doctor</h2>
                  <p className="patient-report-subtitle">
                    Bring these into your visit, or use them as a starting point.
                  </p>
                  <ol className="patient-question-list">
                    {summary.questions.map((question, index) => (
                      <li key={question}>
                        <span>{index + 1}</span>
                        <span>{question}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : !summary ? (
                <section className="patient-report-card">
                  <h2>Your summary is being prepared</h2>
                  <p className="patient-report-subtitle">
                    Your doctor&apos;s office is preparing a short summary of
                    your week. It will appear here.
                  </p>
                </section>
              ) : null}

              {bundle.patient.notes && (
                <section className="patient-report-card patient-notes">
                  <Image
                    src="/assets/sweetie/sweetie.png"
                    alt=""
                    width={48}
                    height={48}
                  />
                  <div>
                    <h2>What you told Sweetie</h2>
                    <blockquote>{bundle.patient.notes}</blockquote>
                  </div>
                </section>
              )}

              {!bundle.status.done && (
                <a
                  href={`/s/${bundle.patient.token}`}
                  className="patient-finish-card"
                >
                  <span aria-hidden="true">✦</span>
                  <div>
                    <strong>There&apos;s a little more to share</strong>
                    <small>
                      Finish your conversation so your care team has the full
                      picture.
                    </small>
                  </div>
                  <b aria-hidden="true">→</b>
                </a>
              )}
            </>
          )}
        </div>

        <footer className="patient-summary-footer">
          <Disclaimer
            audience="patient"
            generatedAt={bundle.patientSummaryAt}
          />
        </footer>
      </div>
    </main>
  );
}

function MiniStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="patient-mini-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function PatientState({ message }: { message: string }) {
  return (
    <main className="ss-page sweetie-theme patient-page-state">
      <div className="ss-card patient-state-card">
        <Image
          src="/assets/sweetie/sweetie.png"
          alt="Sweetie"
          width={76}
          height={76}
          priority
        />
        <p>{message}</p>
      </div>
    </main>
  );
}
