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
import RangeBar from "@/components/RangeBar";
import SleepChart from "@/components/SleepChart";
import SpikeTable from "@/components/SpikeTable";
import StatTile from "@/components/StatTile";
import { can } from "@/lib/access";
import { visitPartsRead } from "@/lib/auditLog";
import { recordVisitRead } from "@/lib/auditStore";
import { currentProvider } from "@/lib/auth";
import { loadBundle } from "@/lib/bundle";
import { findVisit } from "@/lib/visit";
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
  const empty = !bundle.status.hasDexcom && bundle.status.answered === 0;
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
              {st && st.readings > 0 && ` · ${st.days} days · ${st.readings.toLocaleString()} readings`}
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
            <span>{bundle.patient.provider.name}</span>
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
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
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
                  <StatTile
                    label="Spikes > 180"
                    value={String(bundle.spikes.length)}
                    hint={`${bundle.spikes.filter((x) => x.visit).length} linked to a place`}
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
              <div className="sour-print-columns">
                <div>
                  <h2>Patterns</h2>
                  {s ? (
                    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-snug">
                      {s.patterns.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                      {s.patterns.length === 0 && <li className="list-none text-[var(--viz-muted)]">None found.</li>}
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
                      {s.questions.length === 0 && <li className="text-[var(--viz-muted)]">None.</li>}
                    </ul>
                  ) : (
                    <p className="mt-1 text-sm text-[var(--viz-muted)]">—</p>
                  )}
                </div>
              </div>

              <div className="mt-4">
                <h2>In the patient&apos;s words</h2>
                {bundle.patient.notes ? (
                  <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-black/15 pl-3 text-sm italic text-[var(--viz-ink-2)]">
                    {bundle.patient.notes}
                  </blockquote>
                ) : (
                  <p className="mt-1 text-sm text-[var(--viz-muted)]">Sweetie has not collected answers yet.</p>
                )}
              </div>
            </section>

            {bundle.status.hasDexcom && (
              <section className="sour-card">
                <h2>Glucose, last {st?.days ?? 7} days</h2>
                <p className="text-xs text-[var(--viz-muted)]">
                  Shaded band is 70–180 mg/dL. Red markers are spikes, labeled with the place the patient had just left.
                </p>
                <div className="mt-2">
                  <GlucoseChart readings={bundle.glucose} spikes={bundle.spikes} height={220} />
                </div>
              </section>
            )}

            {bundle.status.hasDexcom && (
              <div className="sour-print-grid">
                <section className="sour-card">
                  <h2>Spikes linked to places</h2>
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

        <footer className="sour-print-footer">
          <Disclaimer audience="provider" generatedAt={bundle.providerSummaryAt} reviewedBy={review?.byName} />
        </footer>
      </article>
    </main>
  );
}
