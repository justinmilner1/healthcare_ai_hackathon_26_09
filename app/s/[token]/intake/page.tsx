"use client";

import Image from "next/image";
import DexcomDemoLink from "@/components/DexcomDemoLink";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeStatus, UploadKind } from "@/lib/types";
import { asSentence } from "@/lib/uploads";
import styles from "./intake.module.css";
import { apiFetch, CSRF_PARAM, ensureCsrfToken } from "@/lib/csrf";
import { type DexcomEnv, isDexcomEnv } from "@/lib/dexcomEnv";
import { dexcomCardHint, dexcomConnectControl } from "@/lib/dexcomHint";
import { countOf } from "@/lib/plural";

type DexcomStatus = {
  /** Which Dexcom this deployment talks to (design §9.2). The sandbox answers with synthetic readings, so
   *  everything the page says about a connection depends on which one it is. */
  env: DexcomEnv;
  /** Whether this visit is the kind that may connect at all: a synthetic visit to the sandbox, a real one
   *  to production. The server decides (lib/dexcom.ts visitMatchesEnv); the page only asks. */
  canConnect: boolean;
  sandboxPatient: boolean;
  configured: boolean;
  connected: boolean;
  count: number;
  start: string | null;
  end: string | null;
};

const DEXCOM_MESSAGES: Record<DexcomEnv, Record<string, string>> = {
  sandbox: {
    connected: "Dexcom sandbox connected. Imported synthetic readings are shown below.",
    cancelled: "Dexcom sandbox connection was cancelled. You can try again when ready.",
    expired: "The Dexcom sandbox connection request expired. Please start a new connection.",
    failed: "We could not connect or import Dexcom sandbox data. Please try again.",
    no_data: "Dexcom sandbox returned no glucose readings to import. You can reconnect and try again.",
  },
  production: {
    connected: "Dexcom connected. Your imported readings are shown below.",
    cancelled: "The Dexcom connection was cancelled. You can try again when ready.",
    expired: "The Dexcom connection request expired. Please start a new connection.",
    failed: "We could not connect to Dexcom or import your readings. Please try again.",
    no_data: "Dexcom returned no glucose readings to import. You can reconnect and try again.",
  },
};

const DEXCOM_OUTCOMES = Object.keys(DEXCOM_MESSAGES.sandbox);

function formatImportDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  return new Date(value).toLocaleString();
}

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
  const [isFinishing, setIsFinishing] = useState(false);
  const [removing, setRemoving] = useState<DataKind | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState<DataKind | null>(null);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [dexcomStatus, setDexcomStatus] = useState<DexcomStatus | null>(null);
  const [dexcomError, setDexcomError] = useState("");
  // The outcome of a connection attempt, not the sentence for it: which sentence depends on which Dexcom
  // this deployment talks to, and that only arrives with the status below.
  const [dexcomOutcome, setDexcomOutcome] = useState("");
  // The sandbox Dexcom button is a plain form POST, so there is no fetch to hang a header off: the token
  // rides in the query string instead (see CSRF_PARAM in lib/csrf.ts). It can only be read once the page
  // is hydrated, which is also when the button first becomes clickable.
  const [csrfToken, setCsrfToken] = useState("");

  useEffect(() => {
    setCsrfToken(ensureCsrfToken());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDexcomStatus(null);
    setDexcomError("");
    const query = new URLSearchParams(window.location.search);
    if (query.get("demo") === "1") setStep(1);
    const outcome = query.get("dexcom");
    setDexcomOutcome("");
    if (outcome && DEXCOM_OUTCOMES.includes(outcome)) {
      setDexcomOutcome(outcome);
      setStep(1);
    }

    fetch(`/api/dexcom/status?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Status unavailable");
        const data = await response.json();
        if (
          !isDexcomEnv(data?.env) ||
          typeof data?.canConnect !== "boolean" ||
          typeof data?.sandboxPatient !== "boolean" ||
          typeof data?.configured !== "boolean" ||
          typeof data?.connected !== "boolean" ||
          !Number.isInteger(data?.count) || data.count < 0 ||
          !(data.start === null || typeof data.start === "string") ||
          !(data.end === null || typeof data.end === "string")
        ) throw new Error("Invalid status");
        if (!controller.signal.aborted) setDexcomStatus(data as DexcomStatus);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDexcomError("We could not check data connections. Reload this page to try again. File uploads are hidden until the patient type is confirmed.");
        }
      });

    return () => controller.abort();
  }, [token]);

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
    if (!dexcomStatus || dexcomStatus.sandboxPatient || isUploading || isFinishing) return;
    const previous = connections[kind];
    setConnectionNotice("");
    setConfirmRemoval(null);
    setConnections((current) => ({
      ...current,
      [kind]: { state: "uploading", detail: `Reading ${file.name}` },
    }));

    const form = new FormData();
    form.set("token", token);
    form.set("kind", kind);
    form.set("file", file);

    try {
      const response = await apiFetch("/api/upload", { method: "POST", body: form });
      const result = (await response.json()) as {
        count?: number;
        error?: string;
      };

      if (!response.ok) {
        // The route's refusals are written to be read aloud mid-sentence by Sweetie (lib/uploads.ts); on a
        // card they stand alone, so they get a capital and a full stop.
        throw new Error(asSentence(result.error ?? "That file could not be connected."));
      }

      setConnections((current) => ({
        ...current,
        [kind]: {
          state: "connected",
          // The same counting rule as the brief and the patient summary, from the same helper (T60, T80).
          // Grouped as well as agreeing: a week of Dexcom readings is "2,016 records", which is how the
          // Sour brief and /patient/[id] both name this very upload.
          detail: `${countOf(result.count ?? 0, "record")} securely added`,
        },
      }));
    } catch (error) {
      setConnections((current) => ({
        ...current,
        [kind]: {
          state: previous.state === "connected" ? "connected" : "error",
          detail:
            error instanceof Error
              ? error.message
              : "That file could not be connected.",
        },
      }));
    }
  }

  async function removeSource(kind: DataKind) {
    if (!dexcomStatus || dexcomStatus.sandboxPatient || isUploading || isFinishing) return;
    setRemoving(kind);
    setPageError("");
    setConnectionNotice("");
    try {
      const response = await apiFetch("/api/upload", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, kind }),
      });
      if (!response.ok) throw new Error("We couldn't remove that data. Please try again.");
      setConnections((current) => ({ ...current, [kind]: { state: "idle" } }));
      setConfirmRemoval(null);
      setConnectionNotice(`${SOURCES.find((source) => source.kind === kind)?.name} data removed. You can upload it again anytime.`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "We couldn't remove that data. Please try again.");
    } finally {
      setRemoving(null);
    }
  }

  async function finishWithoutQuestions() {
    if (isFinishing || isUploading) return;
    setIsFinishing(true);
    setPageError("");
    try {
      const response = await apiFetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, event: { type: "skip_questions" } }),
      });
      if (!response.ok) throw new Error("We couldn't save your choice. Please try again.");
      router.push(`/patient/${token}`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "We couldn't save your choice. Please try again.");
      setIsFinishing(false);
    }
  }

  // Held back until the status says which Dexcom this is: "Dexcom sandbox connected" in front of a real
  // patient would be a lie about where their readings came from, and the wait is one fetch.
  const dexcomMessage = dexcomStatus && dexcomOutcome ? DEXCOM_MESSAGES[dexcomStatus.env][dexcomOutcome] : "";
  const connectedCount = dexcomStatus?.sandboxPatient
    ? Number(dexcomStatus.connected)
    : Object.values(connections).filter(
        (connection) => connection.state === "connected",
      ).length;
  // Whether there is a Dexcom connection to offer at all, which the lede below promises before any card is
  // on the screen (T91). False while the status is still on the wire, so the promise appears with the
  // control rather than the other way round.
  const offersDexcomConnection = dexcomStatus
    ? dexcomConnectControl({
        env: dexcomStatus.env,
        configured: dexcomStatus.configured,
        canConnect: dexcomStatus.canConnect,
        sandboxPatient: dexcomStatus.sandboxPatient,
      }) !== "none"
    : false;
  // T84 (§2.4, §2.5): the setup-complete card reports what was shared, so the row that says nothing was
  // has to look different from the row that says something was. The green tick means CONNECTED everywhere
  // else in this flow, one step earlier included, so it cannot also decorate "No data connected yet".
  const hasConnections = connectedCount > 0;
  const isUploading = removing !== null || Object.values(connections).some(
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
            {["Hello", "Connect", "Ready"].map((label, index) => (
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
                  {step === 2 && "Your week is ready to view. Questions are optional."}
                </span>
              </div>
            </div>
          </aside>

          <div className={styles.contentPanel}>
            {dexcomStatus?.sandboxPatient && (
              <div role="note" className={styles.demoNotice}>
                <strong>Demo mode · Synthetic data only</strong>
                Your patient record stays unchanged. Not for care decisions.
              </div>
            )}
            {dexcomMessage && <p role="status" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">{dexcomMessage}</p>}
            {dexcomError && <p role="alert" className={styles.pageError}>{dexcomError}</p>}
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
                    {dexcomStatus?.sandboxPatient ? "Synthetic data only for this demo" : "No passwords needed for this demo"}
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
                    {dexcomStatus?.sandboxPatient
                      ? offersDexcomConnection
                        ? "Demo mode: connect Dexcom to explore synthetic readings. Other sources are available in your regular intake."
                        : "Demo mode: synthetic readings only. Other sources are available in your regular intake."
                      : offersDexcomConnection
                        ? "Connect Dexcom or upload a file. Add sleep and location for more context."
                        : "Upload your Dexcom export. Add sleep and location for more context."}
                  </p>
                </div>

                {!dexcomStatus && !dexcomError && <p role="status">Checking data connections…</p>}
                <div className={styles.sourceList}>
                  {dexcomStatus && SOURCES.map((source) => {
                    const sandbox = dexcomStatus.sandboxPatient;
                    const unavailable = sandbox && source.kind !== "dexcom";
                    const connection: Connection = sandbox
                      ? { state: source.kind === "dexcom" && dexcomStatus.connected ? "connected" : "idle" }
                      : connections[source.kind];
                    // §2.5 Every control on this card is one the patient can use. Which connect control
                    // there is, if any, is lib/dexcomHint.ts's to decide, and "none" means render nothing
                    // rather than a greyed-out button the patient cannot press (T91).
                    const connectControl = source.kind === "dexcom"
                      ? dexcomConnectControl({ env: dexcomStatus.env, configured: dexcomStatus.configured, canConnect: dexcomStatus.canConnect, sandboxPatient: sandbox })
                      : "none";
                    // The same rule for the upload: a synthetic visit's uploads are refused (§13.4), and
                    // its cards already say so in words — the lede above and each card's own line — so
                    // there is no disabled button whose `title` a touch device never shows (T91).
                    const canUpload = !sandbox;
                    return (
                      <div
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
                            {!unavailable && (
                              <SourceStatus connection={connection} name={source.name} />
                            )}
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
                            {unavailable ? "File uploads are unavailable in demo mode" : sandbox ? (dexcomStatus.connected ? `${dexcomStatus.count.toLocaleString()} demo readings imported` : "Dexcom account · Synthetic demo data") : connection.detail ?? source.format}
                          </span>
                        </span>
                        {(canUpload || connectControl !== "none") && (
                        <div className={styles.sourceActions}>
                          {/* The OAuth button where this visit may connect (§9.2): a synthetic visit to the
                              sandbox, a real one to production. Where it may not, and the sandbox is what
                              this deployment talks to, a real patient is offered the separate demo visit
                              instead — which is nothing to offer once production is live, or where this
                              deployment has no Dexcom credentials at all. */}
                          {connectControl === "oauth" ? (
                            <form action={`/api/dexcom/connect?${CSRF_PARAM}=${encodeURIComponent(csrfToken)}`} method="POST">
                              <input type="hidden" name="token" value={token} />
                              <button type="submit" className={styles.accountConnect} disabled={isFinishing || !csrfToken}>
                                {dexcomStatus.env === "production"
                                  ? dexcomStatus.connected ? "Reconnect Dexcom" : "Connect Dexcom"
                                  : dexcomStatus.connected ? "Reconnect Dexcom · Demo" : "Connect Dexcom · Demo"}
                              </button>
                            </form>
                          ) : connectControl === "demo" ? (
                            <DexcomDemoLink token={token} compact buttonClassName={styles.accountConnect} disabled={isUploading || isFinishing} />
                          ) : null}
                          {canUpload && <>
                          <label className={styles.sourceAction}>
                            {connection.state === "uploading"
                              ? "Adding…"
                              : connection.state === "connected" ? "Replace file" : source.kind === "timeline" ? "Upload JSON" : "Upload CSV"}
                            <input
                              className={styles.fileInput}
                              type="file"
                              aria-label={`${connection.state === "connected" ? "Replace" : "Upload"} ${source.name} file`}
                              accept={source.accept}
                              disabled={isUploading || isFinishing}
                              onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (file) void upload(source.kind, file);
                                event.currentTarget.value = "";
                              }}
                            />
                          </label>
                          {connection.state === "connected" && (
                            <button
                              type="button"
                              className={styles.removeButton}
                              aria-label={`Remove ${source.name} data`}
                              disabled={isUploading || isFinishing}
                              onClick={() => setConfirmRemoval(source.kind)}
                            >
                              {removing === source.kind ? "Removing…" : "Remove"}
                            </button>
                          )}
                          </>}
                        </div>
                        )}
                        {source.kind === "dexcom" && (
                          <p className={styles.connectionHint}>
                            {dexcomCardHint({
                              env: dexcomStatus.env,
                              configured: dexcomStatus.configured,
                              canConnect: dexcomStatus.canConnect,
                              sandboxPatient: sandbox,
                              imported: dexcomStatus.connected,
                              importRange: dexcomStatus.start && dexcomStatus.end
                                ? `${formatImportDate(dexcomStatus.start)} – ${formatImportDate(dexcomStatus.end)}`
                                : null,
                              // The patient's own file, which the status route does not count: it reports the
                              // OAuth import alone, so a CSV is only visible here (T71).
                              uploaded: !sandbox && connections.dexcom.state === "connected",
                            })}
                          </p>
                        )}
                        {confirmRemoval === source.kind && (
                          <div className={styles.removeConfirmation}>
                            <p>Remove all {source.name} uploads from this check-in? Saved summaries will be cleared so they no longer show this data. You can upload again later.</p>
                            <div>
                              <button type="button" className={styles.removeButton} disabled={isUploading} onClick={() => void removeSource(source.kind)}>
                                Confirm removal
                              </button>
                              <button type="button" className={styles.textButton} disabled={isUploading} onClick={() => setConfirmRemoval(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {connectionNotice && <p role="status" className={styles.lede}>{connectionNotice}</p>}

                <div className={styles.connectFooter}>
                  <div className={styles.connectionCount}>
                    <span>{connectedCount}</span> of 3 connected{dexcomStatus?.sandboxPatient ? " · Dexcom-only demo" : ""}
                  </div>
                  <div className={styles.connectActions}>
                    <button
                      className={styles.textButton}
                      type="button"
                      disabled={isUploading}
                      onClick={() => setStep(2)}
                    >
                      Skip connections
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
                    Go straight to your week without answering questions.
                    If you&apos;d like to share more before your visit, chatting
                    with Sweetie is optional.
                  </p>
                </div>

                <div className={styles.readyCard}>
                  <div className={styles.readyRow}>
                    <span
                      className={`${styles.readyMark} ${
                        hasConnections ? styles.readyMarkDone : styles.readyMarkNone
                      }`}
                      data-mark={hasConnections ? "connected" : "none"}
                    >
                      {hasConnections ? <CheckIcon /> : <InfoIcon />}
                    </span>
                    <span>
                      <strong>
                        {hasConnections
                          ? `${countOf(connectedCount, "data source")} connected`
                          : dexcomStatus?.sandboxPatient
                            ? "You can connect the sandbox later"
                            : "No data connected yet"}
                      </strong>
                      {/* "more" only once there is some: the row under "No data connected yet" was offering
                          to add to nothing, which is the same confusion between the two states the mark had. */}
                      <small>
                        {hasConnections
                          ? "You can return to connections to add more data."
                          : "You can return to connections to add your data."}
                      </small>
                    </span>
                  </div>
                  <div className={styles.readyDivider} />
                  <div className={styles.readyRow}>
                    <span className={`${styles.readyMark} ${styles.readyMarkDone}`}>
                      <LockIcon />
                    </span>
                    <span>
                      <strong>Your choices are saved</strong>
                      <small>You can update them whenever you need.</small>
                    </span>
                  </div>
                </div>

                <div className={`${styles.actions} ${styles.completeActions}`}>
                  <button
                    className={`${styles.primaryButton} ${styles.chatButton}`}
                    type="button"
                    disabled={isFinishing || isUploading}
                    onClick={() => void finishWithoutQuestions()}
                  >
                    {isFinishing ? "Saving…" : "View my week"}
                    <ArrowIcon />
                  </button>
                  <p className={styles.completionHint}>Skip the questions. Your shared data stays saved.</p>
                  <div className={styles.secondaryActions}>
                  <button
                    className={styles.textButton}
                    type="button"
                    disabled={isFinishing}
                    onClick={() => router.push(`/s/${token}`)}
                  >
                    <MessageIcon />
                    Chat with Sweetie instead
                  </button>
                  <button
                    className={styles.textButton}
                    type="button"
                    disabled={isFinishing}
                    onClick={() => setStep(1)}
                  >
                    <BackIcon />
                    Back to connections
                  </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <footer className={styles.footer}>
          <span>Sweet Spot is designed to support—not replace—your care team.</span>
          <span>Not medical advice</span>
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

/**
 * The status of one source, as a pill and as an announcement (T49, §6.4). It is a live region that is
 * mounted empty rather than one that appears with the first upload, because a region inserted into the
 * page along with its text is not reliably read out; and the text it is read with has to name the source,
 * since "Try again" on its own says nothing about which card moved.
 */
function SourceStatus({ connection, name }: { connection: Connection; name: string }) {
  const idle = connection.state === "idle";
  return (
    <span
      role="status"
      className={
        idle
          ? "sr-only"
          : `${styles.statusPill} ${
              connection.state === "connected" ? styles.statusConnected : ""
            } ${connection.state === "error" ? styles.statusError : ""}`
      }
    >
      {connection.state === "uploading" && <span className={styles.spinner} />}
      {connection.state === "connected" && <CheckIcon />}
      {/* A marker element like its siblings, not a character in the text: the pill is uppercased, so a
          bare "!" read as a typo inside the word rather than as a warning. */}
      {connection.state === "error" && <AlertIcon />}
      {connection.state === "uploading"
        ? "Connecting"
        : connection.state === "connected"
          ? "Connected"
          : connection.state === "error" && (
              <>
                <span aria-hidden="true">Try again</span>
                <span className="sr-only">{name} could not be connected. Try again.</span>
              </>
            )}
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

// `data-icon` on these two is how e2e/connections.spec.ts tells the setup-complete row's two states apart
// (T84). It sits on the glyph rather than on the element around it so that the attribute and the shape can
// never drift from each other: putting back the tick puts back `data-icon="check"` with it.
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="check">
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  );
}

/** Neutral, for a row stating a fact rather than reporting something finished. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="info">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.5v4.5" />
      <path d="M12 8.2h.01" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4.6 2.9 19.6h18.2Z" />
      <path d="M12 10.1v3.5" />
      <path d="M12 16.6h.01" />
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
