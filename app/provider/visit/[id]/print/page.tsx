// GET /provider/visit/[id]/print — the one-pager the clinician carries into the room (design §7.4).
//
// The same visit, the same numbers and the same words as the working summary at /provider/[id], with
// everything that is not paper taken out: no sidebar, no patient list, no Generate, no Mark reviewed, no Ask
// Sour, no tickable boxes. What is left is a sheet. The Print button on the summary opens this URL, and the
// URL on its own is a page anyone may open, print, or export to PDF.
//
// Server-rendered, unlike the screen it is the twin of, because there is nothing here to drive: the browser
// prints what the server already drew, so no summary ever prints half-loaded. The two client pieces beside
// this file are the toolbar that does not print and the times, which are formatted in the reader's zone.
//
// The guards are the page's own rather than lib/guard.ts: those throw an HttpError that `withRoute` turns
// into a JSON response, which in a page would be a 500. The answers are the same ones GET /api/patient/[id]
// gives — no session is the sign-in page, a staff account goes back to the dashboard it may read (§5.2
// keeps summaries clinical), and another practice's visit is a 404 and not a 403, because a 403 would
// confirm the visit exists. A provider reading a visit is §10.2's audited read either way, so this writes
// the rows that read writes.

import { notFound, redirect } from "next/navigation";
import Disclaimer from "@/components/Disclaimer";
import GlucoseChart from "@/components/GlucoseChart";
import PatientWordsBody from "@/components/PatientWordsBody";
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import StatTile from "@/components/StatTile";
import { can } from "@/lib/access";
import { visitPartsRead } from "@/lib/auditLog";
import { recordVisitRead } from "@/lib/auditStore";
import { currentProvider } from "@/lib/auth";
import { loadBundle } from "@/lib/bundle";
import { patientWords } from "@/lib/patientWords";
import { countOf } from "@/lib/plural";
import { emptyNarrativeText, narrativeNote, visitNotStarted } from "@/lib/sourState";
import { clinicianChartCaption, clinicianSpikeCardHeading, clinicianSpikePlacesHint } from "@/lib/spikePlaces";
import { clinicianLine, findVisit } from "@/lib/visit";
import { visitLabel } from "@/lib/visits";
import PrintControls from "./controls";
import LocalTime from "./localTime";

/** No patient name here: the title is what the browser prints in the page header and names a saved PDF. */
export const metadata = { title: "Pre-visit summary · Sour" };

const DAY = { weekday: "long", month: "short", day: "numeric" } as const;
const STAMP = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" } as const;

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { id } = await params;
  const { auto } = await searchParams;

  const me = await currentProvider();
  if (!me) redirect("/provider/signin");
  if (!can(me.role, "summaries:read")) redirect("/provider");

  const visit = await findVisit(id);
  if (!visit || visit.patient.practiceId !== me.practiceId) notFound();

  const bundle = await loadBundle(visit.id);
  if (!bundle) notFound();
  await recordVisitRead({ practiceId: me.practiceId, visitId: bundle.visitId, actor: me, parts: visitPartsRead(bundle) });

  const s = bundle.providerSummary;
  const st = bundle.stats;
  const review = bundle.review;
  const sources = [bundle.status.hasDexcom && "Dexcom", bundle.status.hasLocation && "Timeline", bundle.status.hasWhoop && "WHOOP"]
    .filter(Boolean)
    .join(" · ");
  // Nothing has arrived from the patient at all. The sheet still prints — a clinician who asked for it
  // should get a page that says so, with the name and the date on it, rather than a blank one.
  // The same predicate the screen branches on (lib/sourState.ts), so the sheet and the brief cannot
  // disagree about whether this visit has anything to show: before T148 both read a check-in the §2.5 scan
  // stopped on its first message as empty, and printed "Nothing to summarize yet" over a saved brief.
  const empty = visitNotStarted(bundle);
  const printedAt = new Date().toISOString();

  return (
    <main className="sour-theme sour-print-page">
      <PrintControls backHref={`/provider/${me.id}?visit=${bundle.visitId}`} auto={auto === "1"} />

      <article className="sour-print-sheet">
        <header className="sour-print-header">
          <div>
            <div className="ss-eyebrow">SOUR · PRE-VISIT SUMMARY</div>
            <h1>{bundle.patient.name}</h1>
            <p>
              {visitLabel(bundle.patient.visitType)}
              {bundle.patient.apptAt ? <> · <LocalTime iso={bundle.patient.apptAt} options={DAY} /></> : " · no visit date"}
              {st && st.readings > 0 && ` · ${countOf(st.days, "day")} · ${countOf(st.readings, "reading")}`}
              {sources && ` · ${sources}`}
            </p>
            {bundle.patient.reason && (
              <p className="sour-called-about">
                Called about: <strong>{bundle.patient.reason}</strong>
              </p>
            )}
          </div>
          <div className="sour-print-meta">
            <strong>{bundle.patient.provider.practice ?? "Sweet Spot"}</strong>
            {/* Not `bundle.patient.provider.name`, which is `providerName` and falls back to the words the
                patient reads — "your care team" on a sheet the practice files is the patient addressing
                themselves (T86). `clinicianLine` takes §7.3's sign-off as well, so this line and the
                reviewed banner a few lines down cannot disagree about whether anyone here holds this visit. */}
            <span className="sour-print-clinician">{clinicianLine(visit, review?.byName)}</span>
            <span>
              Printed <LocalTime iso={printedAt} options={STAMP} />
            </span>
          </div>
        </header>

        {bundle.patient.isSandbox && (
          <p role="note" className="sour-print-sandbox">
            <strong>Synthetic data — Dexcom sandbox demo only.</strong> This is a dedicated demo patient, not a real patient
            record. Do not use these data for care decisions.
          </p>
        )}

        {review && (
          <p className="sour-reviewed">
            <span className="sour-reviewed-check" aria-hidden="true">✓</span>
            <span>
              Reviewed by <strong>{review.byName}</strong> <LocalTime iso={review.at} options={STAMP} />
            </span>
          </p>
        )}

        {bundle.intake?.flagged && (
          <p className="ss-error sour-safety-flag">
            <span className="font-semibold">Safety flag during intake:</span> {bundle.intake.flagged.replace(/_/g, " ")}. Sweetie
            stopped the interview and told the patient to call the office. Review before the visit.
          </p>
        )}

        {s?.flags && s.flags.length > 0 && (
          <div className="sour-glucose-flags rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            <div className="font-semibold">
              Glucose safety flags <span className="font-normal text-red-800/70">(computed from the readings, not by the model)</span>
            </div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {s.flags.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        {empty ? (
          <section className="sour-card sour-print-empty">
            <h2>Nothing to summarize yet</h2>
            <p>
              The patient has not talked to Sweetie or shared any data for this visit. Send the link again if they have not
              opened it.
            </p>
          </section>
        ) : (
          <>
            {st && bundle.status.hasDexcom && (
              <section className="sour-card sour-print-numbers">
                <div className="sour-print-tir">
                  <div className="text-xs text-[var(--viz-ink-2)]">Time in range</div>
                  <div className="sour-print-tir-value">{Math.round(st.tir * 100)}%</div>
                  <div className="mt-1 text-xs text-[var(--viz-muted)]">goal ≥ 70% · below range goal &lt; 4%</div>
                </div>
                <div className="sour-print-tiles">
                  <StatTile label="Average" value={String(st.avg)} unit="mg/dL" />
                  <StatTile label="GMI" value={st.gmi.toFixed(1)} unit="%" hint="est. A1c from CGM" />
                  {/* The screen's hint, out of lib/spikePlaces.ts, so the paper cannot report a count of
                      places over a Timeline nobody shared either (T160, §7.4) — nor, now, a count of
                      excursions cut down to the five rows the card prints (T164). Value and hint are the
                      screen's, which is the whole point of both living in lib/. */}
                  <StatTile
                    label="Spikes > 180"
                    value={String(bundle.spikeTotal)}
                    hint={clinicianSpikePlacesHint(bundle.spikes, bundle.status, bundle.spikeTotal)}
                  />
                  {st.sleepAvgHours !== null ? (
                    <StatTile
                      label="Sleep"
                      value={st.sleepAvgHours.toFixed(1)}
                      unit="h/night"
                      hint={st.recoveryAvg !== null ? `recovery ${st.recoveryAvg}%` : undefined}
                    />
                  ) : (
                    <StatTile label="Sleep" value="—" hint="no WHOOP data" />
                  )}
                </div>
                <div className="sour-print-range">
                  <RangeBar tbr={st.tbr} tir={st.tir} tar={st.tar} />
                </div>
              </section>
            )}

            {!bundle.status.hasDexcom && (
              <p className="ss-notice">No glucose data was shared. This summary is from the conversation only.</p>
            )}

            <section className="sour-card">
              {/* §6.3, §11.3: the sheet says why the two columns are blank, in the same words the screen
                  uses (lib/sourState.ts), so a clinician holding the paper is not left guessing whether
                  Sour found nothing or never ran. The numbers above it are complete either way. */}
              {narrativeNote(s?.narrativeMissing) && (
                <p className="ss-notice sour-print-narrative-note">{narrativeNote(s?.narrativeMissing)}</p>
              )}
              <div className="sour-print-columns">
                <div>
                  <h2>Patterns</h2>
                  {s ? (
                    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-snug">
                      {s.patterns.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                      {s.patterns.length === 0 && <li className="list-none text-[var(--viz-muted)]">{emptyNarrativeText(s.narrativeMissing, "None found.")}</li>}
                    </ol>
                  ) : (
                    <p className="mt-1 text-sm text-[var(--viz-muted)]">No summary has been written for this visit yet.</p>
                  )}
                </div>
                <div>
                  <h2>Ask the patient</h2>
                  {s ? (
                    <ul className="sour-print-questions">
                      {s.questions.map((q, i) => (
                        <li key={i}>
                          {/* A box to tick with a pen, where the screen has a checkbox. */}
                          <span aria-hidden="true">☐</span>
                          <span>{q}</span>
                        </li>
                      ))}
                      {s.questions.length === 0 && <li className="text-[var(--viz-muted)]">{emptyNarrativeText(s.narrativeMissing, "None.")}</li>}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-[var(--viz-muted)]">—</p>
                  )}
                </div>
              </div>

              {/* Named, like .sour-print-numbers and .sour-print-grid above, because it is the part of the
                  sheet §12.2's handover is about: what the patient told Sweetie, on the clinician's paper.
                  e2e/journey.spec.ts scrolls its phone shot of the sheet to it (T109, §12.3). What goes in
                  it is the same decision the screen makes (lib/patientWords.ts, T154): §7.4's sheet is the
                  brief on paper, so it cannot quote a different thing. */}
              <div className="sour-print-words sour-words mt-4">
                <h2>In the patient&apos;s words</h2>
                <PatientWordsBody words={patientWords(bundle)} />
              </div>
            </section>

            {bundle.status.hasDexcom && (
              <section className="sour-card">
                <h2>Glucose, last {countOf(st?.days ?? 7, "day")}</h2>
                {/* Both arguments are the screen's (T165, §7.4): the sheet draws the same five markers
                    under the same tile, so it cannot describe them more loosely than the brief does. */}
                <p className="sour-chart-caption text-xs text-[var(--viz-muted)]">{clinicianChartCaption(bundle.spikes, bundle.spikeTotal)}</p>
                <div className="mt-2">
                  <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} height={220} />
                </div>
              </section>
            )}

            {bundle.status.hasDexcom && (
              <div className="sour-print-grid">
                <section className="sour-card">
                  {/* The screen's heading, out of lib/spikePlaces.ts, so the paper cannot claim a link
                      the brief does not -- the same bargain as the caption above it (T157, §7.4). */}
                  <h2>{clinicianSpikeCardHeading(bundle.spikes)}</h2>
                  <div className="mt-2">
                    <SpikeTable spikes={bundle.spikes} compact />
                  </div>
                </section>
                <section className="sour-card">
                  <h2>Sleep</h2>
                  <div className="mt-2">
                    <SleepChart nights={bundle.sleep} height={160} />
                  </div>
                </section>
              </div>
            )}
          </>
        )}

        {/* §7.4, §2.6: the line that goes into the chart with the sheet. Same facts as the brief's, out of
            the same function, and including the summary's own `narrativeMissing` (T174) — this sheet is
            where the claim was worst, printed four inches under "Patterns · Not generated." */}
        <footer className="sour-print-footer">
          <Disclaimer audience="provider" generatedAt={bundle.providerSummaryAt} reviewedBy={review?.byName} status={bundle.status} narrativeMissing={s?.narrativeMissing} />
        </footer>
      </article>
    </main>
  );
}
