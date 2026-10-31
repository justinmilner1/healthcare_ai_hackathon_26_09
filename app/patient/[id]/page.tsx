"use client";

// Patient view of their own week. Uses GET /api/patient/[id], where the id is the visit id or the presigned
// token from the invite (design §4.4, §5.3) — /patient/<token> is the link the patient is sent.
// Same data as the provider page, warmer voice, no clinical jargon.

import Image from "next/image";
import { use, useEffect, useState } from "react";
import Disclaimer from "@/components/Disclaimer";
import GlucoseChart from "@/components/GlucoseChart";
import PersonaBrand from "@/components/PersonaBrand";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import { summaryDataInvite } from "@/lib/dexcomHint";
import { patientPatternsSubtitle, patientQuestionsSubtitle } from "@/lib/patientNarrative";
import { countOf, daySpan, plural, spanAtAGlance, spanNoun } from "@/lib/plural";
import { patientSleepCardSubtitle } from "@/lib/sleepRecovery";
import { patientChartCaption, patientSpikeCardHeading } from "@/lib/spikePlaces";
import type { PatientBundle } from "@/lib/types";
import { visitCountdownSentence } from "@/lib/visitCountdown";
import { visitLabel } from "@/lib/visits";

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
    // §2.7 The one state of this page that knows nothing at all: `bundle` is null, so there is no
    // `stats.days` to read a span off and none should be added here — this is the no-data branch. It named
    // "your week" through T100, T114, T116 and T123, which took the same presumption off every rendered
    // line below, and so the page contradicted itself across one navigation: a patient who shared a single
    // day read "getting your week ready…" and then "YOUR DAY WITH SWEETIE" over a HISTORY tile saying
    // "1 day" (T132). It takes the word the hero's own nothing-shared branch settled on instead, which is
    // the one line on this page that is true before any data has arrived.
    return <PatientState message="Sweetie is getting your check-in ready…" />;
  }

  const first = bundle.patient.name.split(" ")[0];
  const summary = bundle.patientSummary;
  const stats = bundle.stats;
  const tirPct = Math.round(stats.tir * 100);
  // §2.7 What the empty state asks for, from the control the data panel on /s/<token> is offering
  // this visit (§2.5) rather than from `hasDexcom` alone (T118).
  const invite = summaryDataInvite({ control: bundle.dexcomConnect, sandboxPatient: bundle.patient.isSandbox });
  // §2.7 The hero's eyebrow is a claim about the data like every other span on this page, so it is read
  // off `stats.days` through the same spanNoun() the three strings below it use (T114, T123). It sat above
  // both branches as the literal "YOUR WEEK WITH SWEETIE" and was the one line that rendered identically
  // whatever arrived: a single-day upload got a hero promising a week directly above "the day you shared"
  // and a History tile reading "1 day". `hasDexcom` is `glucose.length > 0` and lib/bundle.ts floors
  // `days` at 1 whenever there is a reading, so the counted branch can never print "0 days".
  //
  // With nothing shared the eyebrow names no span at all (§2.5, the rule T116 settled for the step
  // before this one): the page cannot promise a week to a patient who has shared nothing, and the card
  // under this hero is the invitation to share something. "Check-in" is the word the meta row beside it
  // already uses for what they have done so far.
  const heroEyebrow = (
    bundle.status.hasDexcom ? `Your ${spanNoun(stats.days)} with Sweetie` : "Your check-in with Sweetie"
  ).toUpperCase();
  // §2.7 The one line on this page about the appointment rather than about the data. It counts calendar
  // days, not 24-hour spans, and the sentence is lib/visitCountdown.ts's rather than this page's: the
  // inline `Math.ceil` it replaced told a patient whose visit was at 17:00 today that it was tomorrow
  // (T162), and a sentence written in a page is one only a screenshot can check.
  const visitMessage = visitCountdownSentence(bundle.patient.apptAt, bundle.patient.provider.name);

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
          </div>
        )}

        <section className="patient-summary-hero ss-enter">
          <div className="patient-summary-hero-copy">
            <p className="ss-eyebrow">{heroEyebrow}</p>
            <h1>
              Here&apos;s your story,
              <br />
              <em>{first}.</em>
            </h1>
            <p className="patient-summary-countdown">{visitMessage}</p>
            <div className="patient-summary-meta">
              {/* The label, never the id: `follow_up` is a column value, and this is the one screen written
                  for the patient (design §2.7, §6). visitLabel comes from lib/visits.ts rather than
                  lib/sweetie.ts because this is a client component — lib/sweetie.ts reaches lib/llm.ts and
                  node:async_hooks, which webpack will not bundle for the browser (T20). It falls back to
                  "Visit", so the chip is always a phrase and the row never loses a column. */}
              <span>{visitLabel(bundle.patient.visitType)}</span>
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
              {/* The ask is for whatever /s/<token> can actually take (T118): this button leads there, and
                  on a deployment with no Dexcom credentials that page has no Dexcom connection on it at
                  all — only the file upload. lib/dexcomHint.ts decides both, from the one control the
                  data panel is rendering, so the invitation here cannot outrun the destination. All three
                  of those controls are now branched on rather than two (T125): the sandbox's demo link is
                  a separate synthetic session, not this patient's own readings, and says so. */}
              <p>{invite.body}</p>
              {invite.action && (
                <a
                  href={`/s/${bundle.patient.token}`}
                  className="ss-button ss-button-primary"
                >
                  {invite.action}
                </a>
              )}
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
                    {/* The span comes from the data, not from the brand (T100): `daySpan` says "the
                        week" only when stats.days really is seven, so a single-day upload no longer reads
                        "of the week" beside a History tile saying 1 day. */}
                    <p>
                      Your glucose was between 70 and 180 for {tirPct}% of{" "}
                      {daySpan(stats.days)}
                      {tirPct >= 70 ? " — where most people aim." : "."}
                    </p>
                    <RangeBar
                      tbr={stats.tbr}
                      tir={stats.tir}
                      tar={stats.tar}
                    />
                  </div>
                </article>

                {/* T207 (§2.7, §6.4): the row's name, on an element allowed to carry one and naming the
                    span the tiles actually count. Both halves are one bug: `aria-label` on a role-less
                    `<div>` is prohibited by ARIA — the implicit role is `generic` — so no screen reader
                    said the old literal "Week at a glance", which is why nobody heard it contradict a
                    History tile reading `1 day`. axe knows (`aria-prohibited-attr`) but files a named
                    element with text in it as *incomplete*, so §12.5's pass never failed on it either;
                    `e2e/a11y.ts` now fails the patient pages on that rule's incompletes too. `group` is
                    the role for a set of related controls and values, and it is allowed a name. The
                    wording is `spanAtAGlance` in lib/plural.ts, off the same `stats.days` as the four
                    sentences around it. */}
                <div
                  className="patient-mini-stats"
                  role="group"
                  aria-label={spanAtAGlance(stats.days)}
                >
                  {/* MiniStat prints the value and its noun on two lines, so the noun comes from
                      `plural` rather than `countOf` — the rule is lib/plural.ts's either way (T60, T80).
                      lib/bundle.ts floors `days` at 1, so a patient who uploaded the day before their
                      visit is the common case here and not an edge one. */}
                  <MiniStat
                    label="History"
                    value={`${stats.days}`}
                    detail={plural(stats.days, "day")}
                  />
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
                    {/* T82 (§2.5, §2.7): the half-sentence about places is only true when a place is
                        known. The patient's Where column and this caption read one predicate in
                        lib/spikePlaces.ts, so a patient who never shared a Timeline is not promised a
                        column that is not there. */}
                    <p className="patient-report-subtitle">
                      {patientChartCaption(bundle.spikes)}
                    </p>
                  </div>
                  <span>{countOf(stats.readings, "reading")}</span>
                </div>
                <div className="patient-chart-wrap">
                  {/* T128 (§2.7): `patient` is what keeps a marker over a rise that matched an unnamed
                      stop from reading as a lat/long, the same call the Where column below makes. */}
                  <GlucoseChart
                    readings={bundle.glucose}
                    spikes={bundle.spikes}
                    height={250}
                    patient
                  />
                </div>
              </section>

              {bundle.spikes.length > 0 && (
                <section className="patient-report-card patient-spikes">
                  {/* T203 (§2.7): the heading counts the rows under it, like the caption one card above
                      does its markers — both read `patientRiseNoun` in lib/spikePlaces.ts off this same
                      array, so the page cannot call one rise "your biggest rise" and "Your biggest
                      rises" in one frame again. */}
                  <h2>{patientSpikeCardHeading(bundle.spikes)}</h2>
                  <p className="patient-report-subtitle">
                    A simple timeline to help you remember what was happening.
                  </p>
                  <SpikeTable spikes={bundle.spikes} status={bundle.status} compact patient />
                </section>
              )}

              <div className="patient-detail-grid">
                {bundle.sleep.length > 0 && (
                  <section className="patient-report-card">
                    <h2>Your sleep</h2>
                    {/* T205 (§2.7): recovery is optional in the data — a WHOOP export whose header names no
                        recovery column leaves every night of the upload without one (lib/sleep.ts) — so the
                        sentence is decided over the nights themselves in lib/sleepRecovery.ts, off the same
                        reading `stats.recoveryAvg` is taken from. The Recovery column in the table under the
                        chart drops out on that predicate too, so the card cannot promise a word no element
                        on it carries. */}
                    <p className="patient-report-subtitle">{patientSleepCardSubtitle(bundle.sleep)}</p>
                    <div className="patient-chart-wrap">
                      <SleepChart nights={bundle.sleep} height={180} />
                    </div>
                  </section>
                )}

                {summary?.patterns.length ? (
                  <section className="patient-report-card">
                    {/* The span is the data's, like the sentence above it (T114, §2.7): these patterns
                        are written from this upload, so a heading that calls one day "your week" makes
                        a claim the page cannot repair — the prompt behind them is handed the same span
                        (lib/prompts.ts, lib/sourRun.ts). Seven days still read "What your week showed". */}
                    <h2>What your {spanNoun(stats.days)} showed</h2>
                    {/* T206 (§2.7, §7): the sentence counts the bullets under it. Both arrays are 1 to 3 by
                        the prompt's own bounds (lib/prompts.ts, lib/sourRun.ts) and the clinician prompt
                        asks for a single pattern where the week is unremarkable, so "A few patterns worth
                        noticing together" over one bullet was the best outcome §7 reports described least
                        accurately. Decided in lib/patientNarrative.ts, off the same array the list maps. */}
                    <p className="patient-report-subtitle">
                      {patientPatternsSubtitle(summary.patterns)}
                    </p>
                    {/* T208 (§2.7, §12.5): an ordered list, like its twin one card below, because §7's
                        order is the content — lib/prompts.ts asks for these "most important first" and
                        lib/sourRun.ts keeps them that way, which is what the numerals down the left edge
                        are drawing. The chip is `aria-hidden` because the list already carries the
                        position: `list-style: none` in app/globals.css suppresses the marker for the eye
                        only, so without it a screen reader read "item 1, 1, Your readings stayed…". */}
                    <ol className="patient-pattern-list">
                      {summary.patterns.map((pattern, index) => (
                        <li key={pattern}>
                          <span aria-hidden="true">{index + 1}</span>
                          <span>{pattern}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
              </div>

              {summary?.questions.length ? (
                <section className="patient-report-card">
                  <h2>Things you might ask your doctor</h2>
                  {/* T206 (§2.7): both pronouns agree with the count, out of the same module as the
                      patterns sentence above — one question is "this"/"it", not "these"/"them". */}
                  <p className="patient-report-subtitle">
                    {patientQuestionsSubtitle(summary.questions)}
                  </p>
                  {/* T208 (§2.7, §12.5): the same `aria-hidden` chip as the patterns card above, for the
                      same reason — this list was already ordered, and the numeral was being announced on
                      top of the position the <ol> gives it. */}
                  <ol className="patient-question-list">
                    {summary.questions.map((question, index) => (
                      <li key={question}>
                        <span aria-hidden="true">{index + 1}</span>
                        <span>{question}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : !summary ? (
                <section className="patient-report-card">
                  <h2>Your summary is being prepared</h2>
                  {/* T114: the span again, because this card sat in one frame with the time-in-range
                      sentence T100 fixed — "for 76% of the day you shared" above, "a short summary of
                      your week" below, about the same 84 readings. */}
                  <p className="patient-report-subtitle">
                    Your doctor&apos;s office is preparing a short summary of
                    your {spanNoun(stats.days)}. It will appear here.
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
