"use client";

// The practice dashboard: who is in the pre-visit flow, and the wizard that adds one. Rendered by page.tsx,
// which is the server component that reads the session (design §5.1). Owner: Justin.

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import { can } from "@/lib/access";
import { VISIT_TYPES, visitLabel, visitStatusLabel, visitStatusTone } from "@/lib/visits";
import {
  channelLabel,
  channelsOf,
  CONSENT_METHODS,
  consentLabel,
  CONTACT_CHANNELS,
  CSV_TEMPLATE,
  type ConsentMethod,
  type ContactChannel,
  type VisitDraft,
} from "@/lib/visitIntake";
import { apiFetch } from "@/lib/csrf";

// One booked visit (design §4.4): `id` is the visit, `patientId` the person it is for. Every request the
// dashboard makes — invite, summary, Sour — is keyed by the visit id.
type Row = {
  id: string;
  patientId: string;
  name: string;
  apptAt: string | null;
  visitType: string | null;
  reason: string | null;
  /** §4.4's own value: invited | verified | in_intake | intake_done | summary_ready | reviewed | cancelled. */
  status: string;
  /** §2.2's contact channel. Null on a visit created before T07, which means "both" (lib/visitIntake.ts). */
  channel: string | null;
  /** The recorded consent (§2.2): how it was taken, and when. Who took it is a user id, shown as "recorded". */
  consentChannel: string | null;
  consentRecordedAt: string | null;
  consentRecordedBy: string | null;
  /** §8.3 What each channel did with the invite. Empty until a `notify.invite` job has run. */
  deliveries: { channel: string; kind: string; status: string; error: string | null; at: string }[];
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
type Provider = {
  id: string;
  name: string;
  practice: string | null;
  /** From the session, server-side (design §5.2). It decides what this screen offers, never what it may do:
   *  every route checks the role again (lib/guard.ts), so a hidden button is a courtesy, not a lock. */
  role: string;
  visits: Row[];
};
type PatientForm = {
  name: string;
  phone: string;
  email: string;
  apptAt: string;
  visitType: string;
  reason: string;
  /** §2.2's contact channel. "none" is "we will hand them the link ourselves". */
  channel: ContactChannel;
  /** How the patient's consent to be contacted was taken. Empty until staff say, which the server insists on
   *  for every channel but "none" (lib/visitIntake.ts) — a visit is not messaged on an unrecorded consent. */
  consentMethod: ConsentMethod | "";
};

const EMPTY_FORM: PatientForm = {
  name: "",
  phone: "",
  email: "",
  apptAt: "",
  visitType: "follow_up",
  reason: "",
  channel: "both",
  consentMethod: "",
};

// The signed-in provider's id comes from the session, server-side in page.tsx (design §5.1), so this
// component never has to ask who is here and there is no practice picker to pick the wrong workspace from.
export default function ProviderDashboard({ providerId }: { providerId: string }) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [form, setForm] = useState<PatientForm>(EMPTY_FORM);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [addStep, setAddStep] = useState(0);
  const [result, setResult] = useState<{
    message: string;
    link: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowNote, setRowNote] = useState<Record<string, string>>({});

  // GET /api/provider answers for whoever the session cookie says is signed in; a 401 means the session
  // ended under us, and the sign-in page is where that gets sorted out.
  const load = useCallback(async () => {
    const response = await fetch("/api/provider");
    if (response.status === 401) {
      window.location.href = "/provider/signin";
      return;
    }
    if (response.ok) setProvider(await response.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openWizard() {
    setForm(EMPTY_FORM);
    setResult(null);
    setError("");
    setAddStep(0);
    setWizardOpen(true);
  }

  function closeWizard() {
    setWizardOpen(false);
    setResult(null);
    setError("");
  }

  async function addPatient(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (addStep < 2) {
      setAddStep((step) => step + 1);
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          providerId,
          apptAt: form.apptAt || undefined,
          consentMethod: form.consentMethod || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Could not add patient.");
      }

      // The invite is a `notify.invite` job (design §3.4): the response says it is queued, not that it
      // arrived, so the wizard says so and shows the link, which works regardless. Per-channel delivery
      // status lands on the visit and in this list in T19 (§8.3).
      setResult({
        message: [
          data.patientReused ? "Visit added for a patient you already had." : "Patient added.",
          data.queued ? `The invite is on its way by ${channelLabel(form.channel).toLowerCase()}.` : `No invite sent${data.reason ? `: ${data.reason}.` : "."} Share the link below.`,
        ].join(" "),
        link: data.link,
      });
      setAddStep(3);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add patient.");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(visit: Row) {
    setRowNote((notes) => ({ ...notes, [visit.id]: "Sending…" }));
    const data = await (
      await apiFetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId: visit.id }),
      })
    ).json();
    setRowNote((notes) => ({
      ...notes,
      [visit.id]: data.queued ? "Sending now" : `Not sent: ${data.error ?? "unknown error"}`,
    }));
  }

  async function copyIntakeLink(visit: Row) {
    const link = `${window.location.origin}/s/${encodeURIComponent(
      visit.token,
    )}`;
    let copied = false;

    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      const field = document.createElement("textarea");
      field.value = link;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      copied = document.execCommand("copy");
      field.remove();
    }

    setRowNote((notes) => ({
      ...notes,
      [visit.id]: copied
        ? "Intake link copied"
        : "Could not copy — open the patient link instead",
    }));
  }

  if (!provider) {
    return (
      <main className="ss-page sour-theme">
        <div className="provider-loading">
          <Image
            src="/assets/sour/sour.png"
            alt=""
            width={76}
            height={76}
          />
          <span className="provider-loading-dots">Opening your workspace</span>
        </div>
      </main>
    );
  }

  const visits = provider?.visits ?? [];
  const ready = visits.filter((visit) => visit.hasSummary).length;
  const active = visits.filter(
    (visit) => !visit.hasSummary && (visit.answered > 0 || visit.uploads.length > 0),
  ).length;
  const flagged = visits.filter((visit) => visit.flagged).length;
  // What this role may actually do. The routes check the same capabilities again (lib/guard.ts); offering a
  // button that answers 403 is just a worse way of saying no.
  const mayBook = can(provider.role, "visits:create");
  const mayInvite = can(provider.role, "visits:invite");
  const maySeeSummaries = can(provider.role, "summaries:read");

  return (
    <main className="ss-page sour-theme provider-dashboard">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Practice command center" />
          <div className="provider-top-actions">
            {mayBook && (
              <>
                <button className="ss-button provider-import-button" onClick={() => setImportOpen(true)}>
                  Import a day
                </button>
                <button
                  className="ss-button ss-button-accent"
                  onClick={openWizard}
                >
                  <span className="provider-button-plus">+</span>
                  Add patient
                </button>
              </>
            )}
            {can(provider.role, "practice:manage") && (
              <Link href="/provider/settings" className="ss-button">
                Settings
              </Link>
            )}
            <Link href="/provider/signout" className="ss-text-button">
              Sign out
            </Link>
          </div>
        </header>

        <section className="provider-hero ss-card ss-enter">
          <div className="provider-hero-copy">
            <p className="ss-eyebrow">PRACTICE DASHBOARD</p>
            <h1 className="ss-display">
              {/* An invited colleague has no name until Auth.js takes one, and calling the receptionist
                  "Doctor" is worse than not naming them at all (§2.1). */}
              Good to see you{provider.name ? "," : "."}
              {provider.name && (
                <>
                  <br />
                  <em>{provider.name}.</em>
                </>
              )}
            </h1>
            <p>
              {provider?.practice || "Your practice"} · {visits.length}{" "}
              visit{visits.length === 1 ? "" : "s"} in the pre-visit flow
            </p>
          </div>
          <div className="provider-hero-character">
            <Image
              src="/assets/sour/sour.png"
              alt="Sour"
              width={250}
              height={250}
              priority
            />
          </div>
          <div className="provider-hero-actions">
            {ready > 0 && maySeeSummaries ? (
              <Link
                href={`/provider/${provider?.id}`}
                className="ss-button ss-button-primary"
              >
                Open Sour summaries <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <span className="provider-hero-hint">
                {maySeeSummaries
                  ? "Sour will light up when a summary is ready."
                  : "Summaries are a clinician's to read. Yours is getting patients to Sweetie."}
              </span>
            )}
          </div>
        </section>

        <section className="provider-stats" aria-label="Practice overview">
          <Metric label="All visits" value={visits.length} detail="in this workspace" />
          <Metric label="Intake active" value={active} detail="sharing data or chatting" />
          <Metric label="Summaries ready" value={ready} detail="ready to review" accent />
          <Metric
            label="Needs attention"
            value={flagged}
            detail={flagged ? "safety flag to review" : "nothing flagged"}
            danger={flagged > 0}
          />
        </section>

        <section className="provider-patients">
          <div className="provider-section-head">
            <div>
              <p className="ss-eyebrow">PATIENT FLOW</p>
              <h2>Every visit, at a glance.</h2>
            </div>
            <span>{visits.length} total</span>
          </div>

          <div className="provider-table-card ss-card">
            <div className="provider-table-scroll">
              <table className="provider-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Visit</th>
                    <th>Stage</th>
                    <th>Invite</th>
                    <th>Connected data</th>
                    <th>Sweetie</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visits.map((visit) => (
                    <tr key={visit.id}>
                      <td>
                        <div className="provider-patient">
                          <span className="provider-patient-avatar">
                            {visit.name.charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <strong>{visit.name}</strong>
                            <small>
                              {[visit.phone, visit.email]
                                .filter(Boolean)
                                .join(" · ") || "No contact on file"}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong className="provider-cell-main">
                          {visit.apptAt
                            ? new Date(visit.apptAt).toLocaleDateString(
                                undefined,
                                {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                },
                              )
                            : "Date pending"}
                        </strong>
                        <small className="provider-cell-sub">
                          {visitLabel(visit.visitType)}
                          {visit.reason ? ` · ${visit.reason}` : ""}
                        </small>
                      </td>
                      <td>
                        <Stage visit={visit} />
                      </td>
                      <td>
                        <Invite visit={visit} />
                      </td>
                      <td>
                        <div className="provider-data-pills">
                          {(["dexcom", "timeline", "whoop"] as const).map(
                            (kind) => (
                              <span
                                key={kind}
                                className={`provider-data-pill ${
                                  visit.uploads.includes(kind)
                                    ? "provider-data-ready"
                                    : ""
                                }`}
                              >
                                {visit.uploads.includes(kind) ? "✓ " : ""}
                                {kind === "dexcom"
                                  ? "Dex"
                                  : kind === "timeline"
                                    ? "Map"
                                    : "Whoop"}
                              </span>
                            ),
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="provider-progress-copy">
                          <strong>
                            {visit.answered}/{visit.required}
                          </strong>{" "}
                          answered
                          <div className="provider-mini-progress">
                            <span
                              style={{
                                width: `${Math.min(
                                  100,
                                  (visit.answered /
                                    Math.max(visit.required, 1)) *
                                    100,
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                        {visit.flagged && (
                          <span className="ss-pill ss-pill-danger">
                            Needs review
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="provider-row-actions">
                          {mayInvite && (
                            <>
                              <button
                                type="button"
                                onClick={() => copyIntakeLink(visit)}
                                className="ss-button"
                              >
                                {rowNote[visit.id] === "Intake link copied"
                                  ? "Copied ✓"
                                  : "Copy intake"}
                              </button>
                              <button
                                type="button"
                                onClick={() => sendLink(visit)}
                                className="ss-button"
                              >
                                Send link
                              </button>
                            </>
                          )}
                          {!maySeeSummaries ? null : visit.hasSummary ? (
                            <Link
                              href={`/provider/${provider?.id}?visit=${visit.id}`}
                              className="ss-button ss-button-primary"
                            >
                              Open in Sour
                            </Link>
                          ) : visit.uploads.includes("dexcom") ||
                            visit.answered > 0 ? (
                            <Link
                              href={`/provider/${provider?.id}?visit=${visit.id}`}
                              className="ss-button"
                            >
                              Summarize
                            </Link>
                          ) : null}
                        </div>
                        {rowNote[visit.id] && (
                          <small className="provider-row-note">
                            {rowNote[visit.id]}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                  {provider && visits.length === 0 && (
                    <tr>
                      <td colSpan={7}>
                        <div className="provider-empty">
                          <Image
                            src="/assets/sour/sour.png"
                            alt=""
                            width={90}
                            height={90}
                          />
                          <strong>Your patient flow starts here.</strong>
                          <span>
                            Add the first booked visit and Sweetie will take it
                            from there.
                          </span>
                          {mayBook && (
                            <button
                              className="ss-button ss-button-accent"
                              onClick={openWizard}
                            >
                              + Add first patient
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer className="provider-footer">
          <span>Sweet Spot · Provider workspace</span>
          <span>Demo only · Verify all AI-generated summaries</span>
        </footer>
      </div>

      {importOpen && (
        <ImportDialog
          providerId={providerId}
          onClose={() => setImportOpen(false)}
          onImported={load}
        />
      )}

      {wizardOpen && (
        <PatientWizard
          step={addStep}
          form={form}
          setForm={setForm}
          busy={busy}
          error={error}
          result={result}
          onClose={closeWizard}
          onBack={() => setAddStep((step) => Math.max(0, step - 1))}
          onSubmit={addPatient}
        />
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  detail,
  accent = false,
  danger = false,
}: {
  label: string;
  value: number;
  detail: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <article
      className={`provider-metric ss-card ${
        accent ? "provider-metric-accent" : ""
      } ${danger ? "provider-metric-danger" : ""}`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

/** Where the visit is, from `Visit.status` (design §4.4). The screen used to infer this from upload and
 *  answer counts, which could say "Invited" about a visit the rest of the app had already moved on. */
function Stage({ visit }: { visit: Row }) {
  return (
    <span className={`provider-stage provider-stage-${visitStatusTone(visit.status)}`}>
      <i />
      {visitStatusLabel(visit.status)}
    </span>
  );
}

/** §8.3 What happened to the invite, per channel, with the consent behind it underneath (§2.2). A channel
 *  staff chose and no job has reported on yet reads "queued": the send is a job, so that is the honest word
 *  for the gap between adding the patient and SES answering. */
function Invite({ visit }: { visit: Row }) {
  const wanted = visit.channel === "none" ? [] : channelsOf(visit.channel);
  const reported = new Map(visit.deliveries.filter((d) => d.kind === "notify.invite").map((d) => [d.channel, d]));
  const consent = visit.consentChannel ? `${consentLabel(visit.consentChannel)}${visit.consentRecordedAt ? `, ${new Date(visit.consentRecordedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}` : null;

  return (
    <div className="provider-invite">
      {wanted.length === 0 ? (
        <span className="provider-data-pill">Not messaged</span>
      ) : (
        <div className="provider-data-pills">
          {wanted.map((channel) => {
            const delivery = reported.get(channel);
            const status = delivery?.status ?? "queued";
            return (
              <span
                key={channel}
                className={`provider-data-pill provider-delivery-${status}`}
                title={delivery?.error ?? undefined}
              >
                {channel === "sms" ? "Text" : "Email"} {status === "sent" ? "✓" : status === "failed" ? "✕" : "…"}
              </span>
            );
          })}
        </div>
      )}
      <small className="provider-cell-sub">{consent ? `Consent: ${consent}` : "No consent recorded"}</small>
    </div>
  );
}

function PatientWizard({
  step,
  form,
  setForm,
  busy,
  error,
  result,
  onClose,
  onBack,
  onSubmit,
}: {
  step: number;
  form: PatientForm;
  setForm: React.Dispatch<React.SetStateAction<PatientForm>>;
  busy: boolean;
  error: string;
  result: { message: string; link: string } | null;
  onClose: () => void;
  onBack: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const sideCopy = [
    ["START WITH A PERSON", "A warm handoff starts with the basics."],
    ["GIVE SWEETIE THE BRIEF", "The visit context shapes every question."],
    ["SEND THE INVITE", "One secure link. No patient account needed."],
    ["PATIENT ADDED", "Sweetie can take it from here."],
  ][step];

  return (
    <div className="patient-wizard-backdrop" role="presentation">
      <section
        className="patient-wizard ss-card"
        role="dialog"
        aria-modal="true"
        aria-label="Add a booked patient"
      >
        <aside className="patient-wizard-side">
          <button
            className="patient-wizard-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
          <p>{sideCopy[0]}</p>
          <h2>{sideCopy[1]}</h2>
          <div className="patient-wizard-character">
            <Image
              src="/assets/sour/sour.png"
              alt="Sour"
              width={340}
              height={340}
              priority
            />
          </div>
          <div className="patient-wizard-bubble">
            ✦ Sweetie will personalize the intake from this brief.
          </div>
        </aside>

        <form className="patient-wizard-content" onSubmit={onSubmit}>
          <div className="patient-wizard-top">
            <div className="ss-stepper" aria-label="Add patient progress">
              {["Contact", "Visit", "Invite"].map((label, index) => (
                <div
                  key={label}
                  className={`ss-step ${
                    index === step ? "ss-step-active" : ""
                  } ${index < step ? "ss-step-done" : ""}`}
                >
                  <span>{index < step ? "✓" : index + 1}</span>
                  <em>{label}</em>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="ss-error" role="alert">
              {error}
            </div>
          )}

          {step === 0 && (
            <div className="patient-wizard-step ss-enter" key="contact">
              <div>
                <p className="ss-eyebrow">PATIENT DETAILS</p>
                <h3 className="ss-title">Who is the visit for?</h3>
                <p className="ss-lede">
                  Add at least one contact method if you want the invite sent
                  automatically.
                </p>
              </div>
              <div className="patient-wizard-fields">
                <label className="ss-label patient-field-wide">
                  <span>Patient name</span>
                  <input
                    className="ss-input"
                    required
                    autoFocus
                    placeholder="Sam Taylor"
                    value={form.name}
                    onChange={(e) =>
                      setForm({ ...form, name: e.target.value })
                    }
                  />
                </label>
                <label className="ss-label">
                  <span>Mobile number</span>
                  <input
                    className="ss-input"
                    type="tel"
                    placeholder="+1 415 555 0123"
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                  />
                </label>
                <label className="ss-label">
                  <span>Email</span>
                  <input
                    className="ss-input"
                    type="email"
                    placeholder="sam@example.com"
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="patient-wizard-step ss-enter" key="visit">
              <div>
                <p className="ss-eyebrow">VISIT CONTEXT</p>
                <h3 className="ss-title">What brings them in?</h3>
                <p className="ss-lede">
                  Sweetie uses this brief to choose the most useful follow-up
                  questions.
                </p>
              </div>
              <div className="visit-type-grid">
                {VISIT_TYPES.map((type) => (
                  <label
                    key={type.id}
                    className={`visit-type-card ${
                      form.visitType === type.id
                        ? "visit-type-card-selected"
                        : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="visitType"
                      value={type.id}
                      checked={form.visitType === type.id}
                      onChange={(e) =>
                        setForm({ ...form, visitType: e.target.value })
                      }
                    />
                    <span>{type.label}</span>
                    <b>✓</b>
                  </label>
                ))}
              </div>
              <div className="patient-wizard-fields">
                <label className="ss-label">
                  <span>Visit date and time</span>
                  <input
                    className="ss-input"
                    type="datetime-local"
                    value={form.apptAt}
                    onChange={(e) =>
                      setForm({ ...form, apptAt: e.target.value })
                    }
                  />
                </label>
                <label className="ss-label">
                  <span>What did the patient call about?</span>
                  <input
                    className="ss-input"
                    placeholder="Mornings running high"
                    value={form.reason}
                    onChange={(e) =>
                      setForm({ ...form, reason: e.target.value })
                    }
                  />
                </label>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="patient-wizard-step ss-enter" key="invite">
              <div>
                <p className="ss-eyebrow">REVIEW & INVITE</p>
                <h3 className="ss-title">Ready for the handoff.</h3>
                <p className="ss-lede">
                  Saving creates the patient and sends their private Sweetie
                  link on the channel you choose here.
                </p>
              </div>
              <div className="patient-review-card">
                <div className="provider-patient-avatar">
                  {form.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <strong>{form.name}</strong>
                  <span>
                    {visitLabel(form.visitType)}
                    {form.apptAt
                      ? ` · ${new Date(form.apptAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}`
                      : " · Date pending"}
                  </span>
                  {form.reason && <small>Called about: {form.reason}</small>}
                </div>
              </div>
              {/* §2.2: the contact channel, and a consent with a who, a when and a how behind it. The
                  server applies the same rules again (lib/visitIntake.ts) — a channel with no consent
                  recorded, or no address to reach the patient on, comes back as a 400 with the sentence. */}
              <fieldset className="patient-consent">
                <legend className="ss-label">
                  <span>Contact channel</span>
                </legend>
                <div className="patient-channel-row">
                  {CONTACT_CHANNELS.map((channel) => (
                    <label
                      key={channel.id}
                      className={`visit-type-card ${form.channel === channel.id ? "visit-type-card-selected" : ""}`}
                    >
                      <input
                        type="radio"
                        name="channel"
                        value={channel.id}
                        checked={form.channel === channel.id}
                        onChange={() => setForm({ ...form, channel: channel.id })}
                      />
                      <span>{channel.label}</span>
                      <b>✓</b>
                    </label>
                  ))}
                </div>
                <p className="patient-consent-note">
                  {form.channel === "none"
                    ? "Nothing is sent. Copy the link from the dashboard and hand it over yourself."
                    : `The secure link goes to ${[form.channel !== "email" && form.phone, form.channel !== "sms" && form.email].filter(Boolean).join(" and ") || "— add a number or address on the first step"}.`}
                </p>
                {form.channel !== "none" && (
                  <label className="ss-label">
                    <span>How did the patient agree to be contacted?</span>
                    <select
                      className="ss-input"
                      value={form.consentMethod}
                      onChange={(e) => setForm({ ...form, consentMethod: e.target.value as ConsentMethod | "" })}
                    >
                      <option value="">Choose how consent was taken…</option>
                      {CONSENT_METHODS.map((method) => (
                        <option key={method.id} value={method.id}>
                          {method.label}
                        </option>
                      ))}
                    </select>
                    <small className="patient-consent-note">
                      Recorded against you, with the time you save this.
                    </small>
                  </label>
                )}
              </fieldset>
            </div>
          )}

          {step === 3 && result && (
            <div className="patient-wizard-success ss-enter" key="success">
              <div className="patient-success-check">✓</div>
              <p className="ss-eyebrow">PATIENT ADDED</p>
              <h3 className="ss-title">{form.name} is on the way.</h3>
              <p className="ss-lede">{result.message}</p>
              <div className="patient-link-card">
                <span>Private Sweetie link</span>
                <a href={result.link}>{result.link}</a>
              </div>
              <button
                type="button"
                className="ss-button ss-button-primary"
                onClick={onClose}
              >
                Back to dashboard
              </button>
            </div>
          )}

          {step < 3 && (
            <div className="patient-wizard-actions">
              {step > 0 ? (
                <button
                  type="button"
                  className="ss-text-button"
                  onClick={onBack}
                >
                  ← Back
                </button>
              ) : (
                <span>Step {step + 1} of 3</span>
              )}
              <button
                className="ss-button ss-button-primary"
                disabled={busy}
              >
                {busy
                  ? "Adding patient…"
                  : step === 2
                    ? "Add patient & send →"
                    : "Continue →"}
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// §2.2's CSV import: "A CSV import creates a day's visits in one go." Preview first, per-row errors, and
// nothing written until the person has read the preview and pressed the button. POST /api/visits/import does
// both halves — the same call with `commit: true` — so what gets created is exactly what was previewed.

type PreviewRow = { line: number; name: string; visit: VisitDraft | null; errors: string[]; created?: { link: string } | null };
type Preview = {
  columns: string[];
  ignored: string[];
  error: string | null;
  valid: number;
  invalid: number;
  committed: boolean;
  created?: number;
  rows: PreviewRow[];
};

function ImportDialog({ providerId, onClose, onImported }: { providerId: string; onClose: () => void; onImported: () => Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(commit: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/visits/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, providerId, commit }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "That file could not be read.");
      setPreview(data as Preview);
      if (commit) await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file could not be read.");
    } finally {
      setBusy(false);
    }
  }

  // Read in the browser rather than posting multipart: the route takes the text, which is also what the
  // textarea holds, so pasting a day out of a spreadsheet and picking a file end up in the same place.
  async function readFile(file: File | undefined) {
    if (!file) return;
    setPreview(null);
    setError("");
    setCsv(await file.text());
  }

  return (
    <div className="patient-wizard-backdrop" role="presentation">
      <section className="import-dialog ss-card" role="dialog" aria-modal="true" aria-label="Import a day of visits">
        {/* One scrolling body with the actions fixed under it: at a laptop's height the preview is taller
            than the dialog, and a Create button below the fold is a button nobody presses. */}
        <div className="import-scroll">
          <header className="import-head">
            <div>
              <p className="ss-eyebrow">IMPORT A DAY</p>
              <h3 className="ss-title">One CSV, a day of visits.</h3>
            </div>
            <button className="patient-wizard-close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>

          <p className="ss-lede">
            Columns: <code>name, phone, email, scheduled_at, visit_type, reason, channel, consent, consent_at</code>. Every row is checked before anything is created, and a row
            with a blank <code>channel</code> is created without being messaged.
          </p>

          <div className="import-controls">
            <label className="ss-label">
              <span>CSV file</span>
              <input className="ss-input" type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => readFile(e.target.files?.[0])} />
            </label>
            <button type="button" className="ss-text-button" onClick={() => { setPreview(null); setCsv(CSV_TEMPLATE); }}>
              Fill in the example
            </button>
          </div>

          <label className="ss-label">
            <span>Or paste the rows</span>
            <textarea
              className="ss-input import-textarea"
              // Smaller once there is a preview: the rows and their errors are what wants the room then.
              rows={preview ? 3 : 5}
              spellCheck={false}
              value={csv}
              placeholder="name,phone,email,scheduled_at,visit_type,reason,channel,consent,consent_at"
              onChange={(e) => {
                setPreview(null);
                setCsv(e.target.value);
              }}
            />
          </label>

          {error && (
            <div className="ss-error" role="alert">
              {error}
            </div>
          )}

          {preview && (
            <div className="import-preview">
              {preview.error ? (
                <div className="ss-error" role="alert">
                  {preview.error}
                </div>
              ) : (
                <p className="import-tally">
                  {preview.committed ? (
                    <strong>{preview.created} created.</strong>
                  ) : (
                    <strong>
                      {preview.valid} ready to create
                      {preview.invalid ? `, ${preview.invalid} to fix` : ""}.
                    </strong>
                  )}
                  {preview.ignored.length > 0 && <span> Columns ignored: {preview.ignored.join(", ")}.</span>}
                </p>
              )}
              {preview.rows.length > 0 && (
                <div className="import-table-scroll">
                  <table className="provider-table import-table">
                    <thead>
                      <tr>
                        <th>Line</th>
                        <th>Patient</th>
                        <th>Visit</th>
                        <th>Invite</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.line} className={row.errors.length ? "import-row-bad" : ""}>
                          <td>{row.line}</td>
                          <td>
                            <strong className="provider-cell-main">{row.name || "—"}</strong>
                          </td>
                          <td>
                            <small className="provider-cell-sub">
                              {row.visit
                                ? `${visitLabel(row.visit.visitType)} · ${row.visit.scheduledAt ? new Date(row.visit.scheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date pending"}`
                                : "—"}
                            </small>
                          </td>
                          <td>
                            <small className="provider-cell-sub">{row.visit ? `${channelLabel(row.visit.channel)} · ${consentLabel(row.visit.consentMethod)}` : "—"}</small>
                          </td>
                          <td>
                            {row.errors.length ? (
                              <ul className="import-errors">
                                {row.errors.map((message) => (
                                  <li key={message}>{message}</li>
                                ))}
                              </ul>
                            ) : row.created ? (
                              <span className="ss-pill ss-pill-success">Created</span>
                            ) : (
                              <span className="ss-pill ss-pill-info">Ready</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>

        <div className="patient-wizard-actions">
          <button type="button" className="ss-text-button" onClick={onClose}>
            {preview?.committed ? "Back to dashboard" : "Cancel"}
          </button>
          {preview?.committed ? null : preview && !preview.error && preview.valid > 0 ? (
            <button type="button" className="ss-button ss-button-primary" disabled={busy} onClick={() => send(true)}>
              {busy ? "Creating…" : `Create ${preview.valid} visit${preview.valid === 1 ? "" : "s"} →`}
            </button>
          ) : (
            <button type="button" className="ss-button ss-button-primary" disabled={busy || !csv.trim()} onClick={() => send(false)}>
              {busy ? "Checking…" : "Check the rows →"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
