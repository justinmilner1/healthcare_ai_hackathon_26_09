"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import {
  currentProvider,
  forgetProvider,
  rememberProvider,
} from "@/lib/providerSession";
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
type Provider = {
  id: string;
  name: string;
  practice: string | null;
  patients: Row[];
};
type Choice = {
  id: string;
  name: string;
  practice: string | null;
  patients: number;
};
type PatientForm = {
  name: string;
  phone: string;
  email: string;
  apptAt: string;
  visitType: string;
  reason: string;
  optIn: boolean;
};

const EMPTY_FORM: PatientForm = {
  name: "",
  phone: "",
  email: "",
  apptAt: "",
  visitType: "follow_up",
  reason: "",
  optIn: true,
};

export default function ProviderDashboard() {
  const [pid, setPid] = useState<string | null | undefined>(undefined);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [form, setForm] = useState<PatientForm>(EMPTY_FORM);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [addStep, setAddStep] = useState(0);
  const [result, setResult] = useState<{
    message: string;
    link: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowNote, setRowNote] = useState<Record<string, string>>({});

  const load = useCallback(async (id: string) => {
    const response = await fetch(`/api/provider?id=${id}`);
    if (!response.ok) {
      forgetProvider();
      setPid(null);
      return;
    }
    setProvider(await response.json());
  }, []);

  useEffect(() => {
    const id = currentProvider();
    setPid(id);
    if (id) load(id);
    else
      fetch("/api/provider?list=1")
        .then((response) => response.json())
        .then(setChoices);
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
    if (!pid) return;
    setError("");

    if (addStep < 2) {
      setAddStep((step) => step + 1);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          providerId: pid,
          apptAt: form.apptAt || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Could not add patient.");
      }

      const sent = [
        data.sms?.sent && "text message",
        data.email?.sent && "email",
      ].filter(Boolean);
      const why = [
        !data.sms?.sent && data.sms?.error,
        !data.email?.sent && data.email?.error,
      ]
        .filter(Boolean)
        .join("; ");

      setResult({
        message: sent.length
          ? `Invite sent by ${sent.join(" and ")}.`
          : `Patient added. Invite not sent${why ? `: ${why}` : "."}`,
        link: data.link,
      });
      setAddStep(3);
      await load(pid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add patient.");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(patient: Row) {
    setRowNote((notes) => ({ ...notes, [patient.id]: "Sending…" }));
    const data = await (
      await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: patient.id }),
      })
    ).json();
    const sent = [
      data.sms?.sent && "Texted",
      data.email?.sent && "Emailed",
    ].filter(Boolean);
    setRowNote((notes) => ({
      ...notes,
      [patient.id]: sent.length
        ? sent.join(" and ")
        : `Not sent: ${[data.sms?.error, data.email?.error]
            .filter(Boolean)
            .join("; ")}`,
    }));
  }

  async function copyIntakeLink(patient: Row) {
    const link = `${window.location.origin}/s/${encodeURIComponent(
      patient.token,
    )}/intake`;
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
      [patient.id]: copied
        ? "Intake link copied"
        : "Could not copy — open the patient link instead",
    }));
  }

  function switchPractice() {
    forgetProvider();
    setPid(null);
    setProvider(null);
    fetch("/api/provider?list=1")
      .then((response) => response.json())
      .then(setChoices);
  }

  if (pid === undefined) {
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

  if (!pid) {
    return (
      <PracticePicker
        choices={choices}
        onChoose={(id) => {
          rememberProvider(id);
          setPid(id);
          load(id);
        }}
      />
    );
  }

  const patients = provider?.patients ?? [];
  const ready = patients.filter((patient) => patient.hasSummary).length;
  const active = patients.filter(
    (patient) => !patient.hasSummary && (patient.answered > 0 || patient.uploads.length > 0),
  ).length;
  const flagged = patients.filter((patient) => patient.flagged).length;

  return (
    <main className="ss-page sour-theme provider-dashboard">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Practice command center" />
          <div className="provider-top-actions">
            <button className="ss-button" onClick={switchPractice}>
              Switch practice
            </button>
            <button
              className="ss-button ss-button-accent"
              onClick={openWizard}
            >
              <span className="provider-button-plus">+</span>
              Add patient
            </button>
          </div>
        </header>

        <section className="provider-hero ss-card ss-enter">
          <div className="provider-hero-copy">
            <p className="ss-eyebrow">PRACTICE DASHBOARD</p>
            <h1 className="ss-display">
              Good to see you,
              <br />
              <em>{provider?.name ?? "Doctor"}.</em>
            </h1>
            <p>
              {provider?.practice || "Your practice"} · {patients.length}{" "}
              patient{patients.length === 1 ? "" : "s"} in the pre-visit flow
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
            {ready > 0 ? (
              <Link
                href={`/provider/${provider?.id}`}
                className="ss-button ss-button-primary"
              >
                Open Sour summaries <span aria-hidden="true">→</span>
              </Link>
            ) : (
              <span className="provider-hero-hint">
                Sour will light up when a summary is ready.
              </span>
            )}
          </div>
        </section>

        <section className="provider-stats" aria-label="Practice overview">
          <Metric label="All patients" value={patients.length} detail="in this workspace" />
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
            <span>{patients.length} total</span>
          </div>

          <div className="provider-table-card ss-card">
            <div className="provider-table-scroll">
              <table className="provider-table">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Visit</th>
                    <th>Stage</th>
                    <th>Connected data</th>
                    <th>Sweetie</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {patients.map((patient) => (
                    <tr key={patient.id}>
                      <td>
                        <div className="provider-patient">
                          <span className="provider-patient-avatar">
                            {patient.name.charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <strong>{patient.name}</strong>
                            <small>
                              {[patient.phone, patient.email]
                                .filter(Boolean)
                                .join(" · ") || "No contact on file"}
                            </small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <strong className="provider-cell-main">
                          {patient.apptAt
                            ? new Date(patient.apptAt).toLocaleDateString(
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
                          {visitLabel(patient.visitType)}
                          {patient.reason ? ` · ${patient.reason}` : ""}
                        </small>
                      </td>
                      <td>
                        <Stage patient={patient} />
                      </td>
                      <td>
                        <div className="provider-data-pills">
                          {(["dexcom", "timeline", "whoop"] as const).map(
                            (kind) => (
                              <span
                                key={kind}
                                className={`provider-data-pill ${
                                  patient.uploads.includes(kind)
                                    ? "provider-data-ready"
                                    : ""
                                }`}
                              >
                                {patient.uploads.includes(kind) ? "✓ " : ""}
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
                            {patient.answered}/{patient.required}
                          </strong>{" "}
                          answered
                          <div className="provider-mini-progress">
                            <span
                              style={{
                                width: `${Math.min(
                                  100,
                                  (patient.answered /
                                    Math.max(patient.required, 1)) *
                                    100,
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                        {patient.flagged && (
                          <span className="ss-pill ss-pill-danger">
                            Needs review
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="provider-row-actions">
                          <button
                            type="button"
                            onClick={() => copyIntakeLink(patient)}
                            className="ss-button"
                          >
                            {rowNote[patient.id] === "Intake link copied"
                              ? "Copied ✓"
                              : "Copy intake"}
                          </button>
                          <button
                            type="button"
                            onClick={() => sendLink(patient)}
                            className="ss-button"
                          >
                            Send link
                          </button>
                          {patient.hasSummary ? (
                            <Link
                              href={`/provider/${provider?.id}?patient=${patient.id}`}
                              className="ss-button ss-button-primary"
                            >
                              Open in Sour
                            </Link>
                          ) : patient.uploads.includes("dexcom") ||
                            patient.answered > 0 ? (
                            <Link
                              href={`/provider/${provider?.id}?patient=${patient.id}`}
                              className="ss-button"
                            >
                              Summarize
                            </Link>
                          ) : null}
                        </div>
                        {rowNote[patient.id] && (
                          <small className="provider-row-note">
                            {rowNote[patient.id]}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                  {provider && patients.length === 0 && (
                    <tr>
                      <td colSpan={6}>
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
                          <button
                            className="ss-button ss-button-accent"
                            onClick={openWizard}
                          >
                            + Add first patient
                          </button>
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

function PracticePicker({
  choices,
  onChoose,
}: {
  choices: Choice[] | null;
  onChoose: (id: string) => void;
}) {
  return (
    <main className="ss-page sour-theme">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Provider workspace" />
          <Link href="/" className="ss-text-button">
            Back home
          </Link>
        </header>
        <section className="practice-picker ss-card">
          <aside className="practice-picker-art">
            <p className="ss-eyebrow">WELCOME BACK</p>
            <h1 className="ss-display">
              Pick up where
              <br />
              your team <em>left off.</em>
            </h1>
            <Image
              src="/assets/sour/sour.png"
              alt="Sour"
              width={380}
              height={380}
              priority
            />
          </aside>
          <div className="practice-picker-content">
            <div>
              <p className="ss-eyebrow">CHOOSE A PRACTICE</p>
              <h2 className="ss-title">Which workspace are you opening?</h2>
              <p className="ss-lede">
                Demo mode remembers your choice on this device. No password
                needed.
              </p>
            </div>
            <div className="practice-list">
              {choices?.map((choice) => (
                <button
                  key={choice.id}
                  className="practice-choice"
                  onClick={() => onChoose(choice.id)}
                >
                  <span className="practice-choice-avatar">
                    {choice.name.charAt(0)}
                  </span>
                  <span>
                    <strong>{choice.name}</strong>
                    <small>
                      {choice.practice ?? "Independent practice"} ·{" "}
                      {choice.patients} patient
                      {choice.patients === 1 ? "" : "s"}
                    </small>
                  </span>
                  <b aria-hidden="true">→</b>
                </button>
              ))}
              {choices && choices.length === 0 && (
                <p className="practice-empty">No provider workspaces yet.</p>
              )}
            </div>
            <Link
              href="/provider/signup"
              className="ss-button ss-button-primary"
            >
              Create a provider workspace →
            </Link>
          </div>
        </section>
      </div>
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

function Stage({ patient }: { patient: Row }) {
  const stage = patient.hasSummary
    ? "ready"
    : patient.wrapped
      ? "finished"
      : patient.answered > 0
      ? "chatting"
      : patient.uploads.length
        ? "uploading"
        : "invited";
  const labels = {
    ready: "Summary ready",
    finished: "Intake finished",
    chatting: "Talking to Sweetie",
    uploading: "Shared data",
    invited: "Invited",
  };

  return (
    <span className={`provider-stage provider-stage-${stage}`}>
      <i />
      {labels[stage]}
    </span>
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
                  link when they have opted in.
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
              <label className="patient-opt-in">
                <input
                  type="checkbox"
                  checked={form.optIn}
                  onChange={(e) =>
                    setForm({ ...form, optIn: e.target.checked })
                  }
                />
                <span>
                  <strong>Patient opted in to pre-visit messages</strong>
                  <small>
                    Send the secure link to{" "}
                    {[form.phone, form.email].filter(Boolean).join(" and ") ||
                      "the contact method added later"}
                    .
                  </small>
                </span>
              </label>
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
