"use client";

import Image from "next/image";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeStatus, UploadKind } from "@/lib/types";
import styles from "./intake.module.css";

type DataKind = Extract<UploadKind, "dexcom" | "whoop" | "timeline">;
type Connection = {
  state: "idle" | "uploading" | "connected" | "error";
  detail?: string;
};

const SOURCES: {
  kind: DataKind;
  name: string;
  description: string;
  format: string;
  accept: string;
  tone: "rose" | "charcoal" | "blue";
}[] = [
  {
    kind: "dexcom",
    name: "Dexcom",
    description: "Glucose trends, time in range, and recent highs",
    format: "Clarity CSV · Recommended",
    accept: ".csv,text/csv",
    tone: "rose",
  },
  {
    kind: "whoop",
    name: "WHOOP",
    description: "Sleep, recovery, and strain from the past week",
    format: "WHOOP CSV · Optional",
    accept: ".csv,text/csv",
    tone: "charcoal",
  },
  {
    kind: "timeline",
    name: "Google Timeline",
    description: "Places and timing to add context to glucose changes",
    format: "Timeline JSON · Optional",
    accept: ".json,application/json",
    tone: "blue",
  },
];

const EMPTY_CONNECTIONS: Record<DataKind, Connection> = {
  dexcom: { state: "idle" },
  whoop: { state: "idle" },
  timeline: { state: "idle" },
};

export default function SweetieIntakePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [firstName, setFirstName] = useState("");
  const [connections, setConnections] =
    useState<Record<DataKind, Connection>>(EMPTY_CONNECTIONS);
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/sweetie?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("This intake link is no longer available.");
        return response.json() as Promise<{
          name?: string;
          status?: IntakeStatus;
        }>;
      })
      .then((data) => {
        setFirstName(data.name?.trim().split(/\s+/)[0] ?? "");
        setConnections((current) => ({
          dexcom: data.status?.hasDexcom
            ? { state: "connected", detail: "Glucose history ready" }
            : current.dexcom,
          whoop: data.status?.hasWhoop
            ? { state: "connected", detail: "Sleep history ready" }
            : current.whoop,
          timeline: data.status?.hasLocation
            ? { state: "connected", detail: "Location context ready" }
            : current.timeline,
        }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPageError(
          error instanceof Error
            ? error.message
            : "We could not open this intake link.",
        );
      });

    return () => controller.abort();
  }, [token]);

  async function upload(kind: DataKind, file: File) {
    setConnections((current) => ({
      ...current,
      [kind]: { state: "uploading", detail: `Reading ${file.name}` },
    }));

    const form = new FormData();
    form.set("token", token);
    form.set("kind", kind);
    form.set("file", file);

    try {
      const response = await fetch("/api/upload", { method: "POST", body: form });
      const result = (await response.json()) as {
        count?: number;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(result.error ?? "That file could not be connected.");
      }

      const label = result.count === 1 ? "record" : "records";
      setConnections((current) => ({
        ...current,
        [kind]: {
          state: "connected",
          detail: `${result.count ?? 0} ${label} securely added`,
        },
      }));
    } catch (error) {
      setConnections((current) => ({
        ...current,
        [kind]: {
          state: "error",
          detail:
            error instanceof Error
              ? error.message
              : "That file could not be connected.",
        },
      }));
    }
  }

  const connectedCount = Object.values(connections).filter(
    (connection) => connection.state === "connected",
  ).length;
  const isUploading = Object.values(connections).some(
    (connection) => connection.state === "uploading",
  );

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <Image
              src="/assets/sweetie/sweetie.png"
              alt=""
              width={42}
              height={42}
              className={styles.brandMark}
              priority
            />
            <div>
              <span className={styles.brandName}>Sweet Spot</span>
              <span className={styles.brandByline}>Pre-visit check-in</span>
            </div>
          </div>

          <nav className={styles.progress} aria-label="Onboarding progress">
            {["Hello", "Connect", "Sweetie"].map((label, index) => (
              <div
                className={`${styles.progressItem} ${
                  index === step ? styles.progressActive : ""
                } ${index < step ? styles.progressDone : ""}`}
                key={label}
                aria-current={index === step ? "step" : undefined}
              >
                <span>{index < step ? <CheckIcon /> : index + 1}</span>
                <em>{label}</em>
              </div>
            ))}
          </nav>

          <div className={styles.secureNote}>
            <ShieldIcon />
            Private & secure
          </div>
        </header>

        <section className={styles.wizardCard}>
          <aside className={styles.artPanel}>
            <div className={styles.artOrbOne} />
            <div className={styles.artOrbTwo} />
            <div className={styles.artContent}>
              <p className={styles.artEyebrow}>
                {step === 2 ? "READY WHEN YOU ARE" : "MEET SWEETIE"}
              </p>
              <h2
                className={`${styles.artTitle} ${
                  step > 0 ? styles.artTitleTight : ""
                }`}
              >
                {step === 0 && (
                  <>
                    Less paperwork.
                    <br />
                    More <i>you.</i>
                  </>
                )}
                {step === 1 && (
                  <>
                    Your week,
                    <br />
                    in one <i>picture.</i>
                  </>
                )}
                {step === 2 && (
                  <>
                    Sweetie&apos;s
                    <br />
                    got <i>this.</i>
                  </>
                )}
              </h2>

              <div
                className={`${styles.characterFrame} ${
                  step === 2 ? styles.characterWorking : ""
                }`}
              >
                <Image
                  key={step === 2 ? "working" : "portrait"}
                  src={
                    step === 2
                      ? "/assets/sweetie/sweetie-working.gif"
                      : "/assets/sweetie/sweetie.png"
                  }
                  alt={
                    step === 2
                      ? "Sweetie happily working at a laptop"
                      : "Sweetie, a friendly pink candy character"
                  }
                  width={480}
                  height={480}
                  unoptimized={step === 2}
                  className={styles.character}
                  priority
                />
              </div>

              <div className={styles.speechBubble}>
                <SparkleIcon />
                <span>
                  {step === 0 && "I’ll make this quick and easy."}
                  {step === 1 && "You choose exactly what to share."}
                  {step === 2 && "Next, tell me what’s on your mind."}
                </span>
              </div>
            </div>
          </aside>

          <div className={styles.contentPanel}>
            {pageError && (
              <div className={styles.pageError} role="alert">
                {pageError}
              </div>
            )}

            {step === 0 && (
              <div className={styles.stepContent}>
                <div>
                  <p className={styles.eyebrow}>YOUR PRE-VISIT CHECK-IN</p>
                  <h1 className={styles.title}>
                    {firstName ? `Hi ${firstName}, ` : "Hi, "}
                    let&apos;s make your next visit count.
                  </h1>
                  <p className={styles.lede}>
                    Connect a few pieces of your health story. Sweetie will help
                    turn them into a clear, useful conversation with your doctor.
                  </p>
                </div>

                <div className={styles.benefits}>
                  <Benefit
                    icon={<ClockIcon />}
                    title="About 5 minutes"
                    body="A short setup now saves time in the exam room."
                  />
                  <Benefit
                    icon={<PulseIcon />}
                    title="Your patterns, together"
                    body="See glucose, sleep, and daily context in one place."
                  />
                  <Benefit
                    icon={<LockIcon />}
                    title="You’re in control"
                    body="Choose what to connect and what to leave out."
                  />
                </div>

                <div className={styles.actions}>
                  <button
                    className={styles.primaryButton}
                    type="button"
                    onClick={() => setStep(1)}
                  >
                    Let&apos;s get started
                    <ArrowIcon />
                  </button>
                  <span className={styles.actionHint}>
                    No passwords needed for this demo
                  </span>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className={`${styles.stepContent} ${styles.connectStep}`}>
                <div>
                  <button
                    type="button"
                    className={styles.backButton}
                    onClick={() => setStep(0)}
                  >
                    <BackIcon />
                    Back
                  </button>
                  <p className={styles.eyebrow}>CONNECT YOUR HEALTH DATA</p>
                  <h1 className={`${styles.title} ${styles.connectTitle}`}>
                    Bring the last 7 days into focus.
                  </h1>
                  <p className={styles.lede}>
                    Add any exports you have. You can replace them at any time.
                  </p>
                </div>

                <div className={styles.sourceList}>
                  {SOURCES.map((source) => {
                    const connection = connections[source.kind];
                    return (
                      <label
                        key={source.kind}
                        className={`${styles.sourceCard} ${
                          styles[source.tone]
                        } ${
                          connection.state === "connected"
                            ? styles.sourceConnected
                            : ""
                        }`}
                      >
                        <span className={styles.sourceIcon}>
                          <SourceIcon kind={source.kind} />
                        </span>
                        <span className={styles.sourceCopy}>
                          <span className={styles.sourceHeading}>
                            <strong>{source.name}</strong>
                            <SourceStatus connection={connection} />
                          </span>
                          <span className={styles.sourceDescription}>
                            {source.description}
                          </span>
                          <span
                            className={`${styles.sourceMeta} ${
                              connection.state === "error"
                                ? styles.sourceError
                                : ""
                            }`}
                          >
                            {connection.detail ?? source.format}
                          </span>
                        </span>
                        <span className={styles.sourceAction}>
                          {connection.state === "uploading"
                            ? "Adding…"
                            : connection.state === "connected"
                              ? "Replace"
                              : "Choose file"}
                        </span>
                        <input
                          className={styles.fileInput}
                          type="file"
                          accept={source.accept}
                          disabled={connection.state === "uploading"}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (file) void upload(source.kind, file);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    );
                  })}
                </div>

                <div className={styles.connectFooter}>
                  <div className={styles.connectionCount}>
                    <span>{connectedCount}</span> of 3 connected
                  </div>
                  <div className={styles.connectActions}>
                    <button
                      className={styles.textButton}
                      type="button"
                      disabled={isUploading}
                      onClick={() => setStep(2)}
                    >
                      I&apos;ll do this in chat
                    </button>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      disabled={isUploading}
                      onClick={() => setStep(2)}
                    >
                      Continue
                      <ArrowIcon />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className={`${styles.stepContent} ${styles.completeStep}`}>
                <div className={styles.completeIcon}>
                  <CheckIcon />
                </div>
                <div>
                  <p className={styles.eyebrow}>SETUP COMPLETE</p>
                  <h1 className={styles.title}>You&apos;re all set.</h1>
                  <p className={styles.lede}>
                    Sweetie is ready to ask a few short questions before your
                    visit. There&apos;s no medical jargon—just a conversation.
                  </p>
                </div>

                <div className={styles.readyCard}>
                  <div className={styles.readyRow}>
                    <span className={styles.readyCheck}>
                      <CheckIcon />
                    </span>
                    <span>
                      <strong>
                        {connectedCount > 0
                          ? `${connectedCount} data ${
                              connectedCount === 1 ? "source" : "sources"
                            } connected`
                          : "Data can be added in chat"}
                      </strong>
                      <small>Sweetie will guide you from here.</small>
                    </span>
                  </div>
                  <div className={styles.readyDivider} />
                  <div className={styles.readyRow}>
                    <span className={styles.readyCheck}>
                      <LockIcon />
                    </span>
                    <span>
                      <strong>Your choices are saved</strong>
                      <small>You can update them whenever you need.</small>
                    </span>
                  </div>
                </div>

                <div className={styles.actions}>
                  <button
                    className={`${styles.primaryButton} ${styles.chatButton}`}
                    type="button"
                    onClick={() => router.push(`/s/${token}`)}
                  >
                    Chat with Sweetie
                    <MessageIcon />
                  </button>
                  <button
                    className={styles.textButton}
                    type="button"
                    onClick={() => setStep(1)}
                  >
                    Back to connections
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <footer className={styles.footer}>
          <span>Sweet Spot is designed to support—not replace—your care team.</span>
          <span>Demo experience · Not medical advice</span>
        </footer>
      </div>
    </main>
  );
}

function Benefit({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className={styles.benefit}>
      <span className={styles.benefitIcon}>{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
    </div>
  );
}

function SourceStatus({ connection }: { connection: Connection }) {
  if (connection.state === "idle") return null;
  return (
    <span
      className={`${styles.statusPill} ${
        connection.state === "connected" ? styles.statusConnected : ""
      } ${connection.state === "error" ? styles.statusError : ""}`}
    >
      {connection.state === "uploading" && <span className={styles.spinner} />}
      {connection.state === "connected" && <CheckIcon />}
      {connection.state === "error" && "!"}
      {connection.state === "uploading"
        ? "Connecting"
        : connection.state === "connected"
          ? "Connected"
          : "Try again"}
    </span>
  );
}

function SourceIcon({ kind }: { kind: DataKind }) {
  if (kind === "dexcom") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 15.5 8 11l3.2 3.2L20.5 5" />
        <path d="M15.5 5h5v5" />
      </svg>
    );
  }
  if (kind === "whoop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 12h3l2-5 3.5 10 3-8 2 3H21" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12H5m5-5-5 5 5 5" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12h4l2-5 4 10 2.5-5H21" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c.7 5.3 3.3 7.9 8 8.5-4.7.6-7.3 3.2-8 8.5-.7-5.3-3.3-7.9-8-8.5C8.7 9.9 11.3 7.3 12 2Z" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8Z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}
