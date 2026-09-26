"use client";

// Sweetie: voice-first intake, reached from the presigned link.
// Typed and spoken transcripts use the same /api/sweetie transport.

import Image from "next/image";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import DexcomDemoLink from "@/components/DexcomDemoLink";
import type {
  ChatMessage,
  IntakeFieldDef,
  IntakeState,
  IntakeStatus,
  UploadKind,
} from "@/lib/types";
import {
  explainMicError,
  hush,
  listenOnce,
  say,
  voiceSupport,
  warmVoices,
} from "@/lib/voice";

type AgentInfo = { connected: boolean; model: string };
type Mic = "off" | "listening" | "thinking" | "speaking" | "idle";

export default function SweetiePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [skipError, setSkipError] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [sandboxPatient, setSandboxPatient] = useState<boolean | null>(null);
  const [dexcomStatusError, setDexcomStatusError] = useState(false);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [fields, setFields] = useState<IntakeFieldDef[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<UploadKind | null>(null);
  const [mic, setMic] = useState<Mic>("off");
  const [micNote, setMicNote] = useState("");
  const [interim, setInterim] = useState("");
  const [support, setSupport] = useState({ listen: false, speak: false });
  const bottom = useRef<HTMLDivElement>(null);
  const micOn = useRef(false);
  const done = useRef(false);
  const listener = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSandboxPatient(null);
    setDexcomStatusError(false);
    fetch(`/api/dexcom/status?token=${encodeURIComponent(token)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Status unavailable");
        const data = await response.json();
        if (typeof data?.sandboxPatient !== "boolean") throw new Error("Invalid status");
        if (!controller.signal.aborted) setSandboxPatient(data.sandboxPatient);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDexcomStatusError(true);
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    setSupport(voiceSupport());
    warmVoices();
    fetch(`/api/sweetie?token=${encodeURIComponent(token)}`)
      .then((response) => response.json())
      .then((data) => {
        setMessages(data.messages ?? []);
        setStatus(data.status ?? null);
        setIntake(data.intake ?? null);
        setFields(data.intakeFields ?? []);
        setAgent(data.agent ?? null);
        done.current = Boolean(data.status?.done && data.intake?.wrapped);
      });

    return () => {
      micOn.current = false;
      listener.current?.stop();
      hush();
    };
  }, [token]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim, busy]);

  const applyReply = useCallback(
    (data: {
      reply?: string;
      status?: IntakeStatus;
      intake?: IntakeState;
      intakeFields?: IntakeFieldDef[];
      agent?: AgentInfo;
    }) => {
      if (data.reply) {
        setMessages((current) => [
          ...current,
          { role: "sweetie", content: data.reply! },
        ]);
      }
      if (data.status) setStatus(data.status);
      if (data.intake) setIntake(data.intake);
      if (data.intakeFields) setFields(data.intakeFields);
      if (data.agent) setAgent(data.agent);
      done.current = Boolean(data.status?.done && data.intake?.wrapped);
      return data.reply ?? "";
    },
    [],
  );

  const listen = useCallback(() => {
    if (!micOn.current) return;
    setMic("listening");
    setMicNote("");
    setInterim("");
    listener.current = listenOnce({
      onInterim: setInterim,
      onSpeechStart: hush,
      onFinal: (transcript) => {
        setInterim("");
        void send(transcript);
      },
      onEnd: () =>
        setMic((current) => (current === "listening" ? "idle" : current)),
      onError: (code) => {
        setMicNote(explainMicError(code));
        if (
          code === "not-allowed" ||
          code === "service-not-allowed" ||
          code === "unsupported"
        ) {
          micOn.current = false;
          setMic("off");
        } else {
          setMic("idle");
        }
      },
    });
    // send is a function declaration and intentionally shares the live voice loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speakThenListen = useCallback(
    async (line: string) => {
      if (!micOn.current || !line) return;
      setMic("speaking");
      await say(line);
      if (!micOn.current) return;
      if (done.current) {
        micOn.current = false;
        setMic("off");
        return;
      }
      listen();
    },
    [listen],
  );

  async function send(raw: string) {
    const mine = raw.trim();
    if (!mine || busy || uploading || skipping) return;
    setText("");
    setMessages((current) => [
      ...current,
      { role: "patient", content: mine },
    ]);
    setBusy(true);
    if (micOn.current) setMic("thinking");

    try {
      const response = await fetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, message: mine }),
      });
      const reply = applyReply(await response.json());
      setBusy(false);
      if (micOn.current) await speakThenListen(reply);
    } catch {
      const line = "I had trouble with that reply. Could you try once more?";
      setMessages((current) => [
        ...current,
        { role: "sweetie", content: line },
      ]);
      setBusy(false);
      if (micOn.current) await speakThenListen(line);
    }
  }

  function toggleMic() {
    if (skipping) return;
    if (micOn.current) {
      micOn.current = false;
      listener.current?.stop();
      hush();
      setInterim("");
      setMic("off");
      return;
    }
    micOn.current = true;
    setMicNote("");
    listen();
  }

  async function upload(kind: UploadKind, file: File) {
    if (sandboxPatient !== false || busy || uploading || skipping) return;
    setUploading(kind);
    const form = new FormData();
    form.set("token", token);
    form.set("kind", kind);
    form.set("file", file);

    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });
      const data = await response.json();
      if (!response.ok) {
        const line = `That file didn't work: ${data.error}. Want to try again, or ask me how to export it?`;
        setMessages((current) => [
          ...current,
          { role: "sweetie", content: line },
        ]);
        if (micOn.current) await speakThenListen(line);
        return;
      }
      if (data.status) setStatus(data.status);

      setBusy(true);
      if (micOn.current) {
        listener.current?.stop();
        setMic("thinking");
      }
      const sweetieResponse = await fetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          event: {
            type: "upload",
            kind,
            count: data.count,
            days: data.days,
          },
        }),
      });
      const reply = applyReply(await sweetieResponse.json());
      setBusy(false);
      if (micOn.current) await speakThenListen(reply);
    } finally {
      setUploading(null);
      setBusy(false);
    }
  }

  async function skipQuestions() {
    if (busy || uploading || skipping) return;
    micOn.current = false;
    listener.current?.stop();
    hush();
    setInterim("");
    setMic("off");
    setSkipping(true);
    setSkipError("");
    try {
      const response = await fetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, event: { type: "skip_questions" } }),
      });
      if (!response.ok) throw new Error("We couldn't save your choice. Please try again.");
      const data = await response.json();
      if (data.skipRefused) {
        // Nothing answered and nothing uploaded: stay in the chat, point back at the first question.
        if (data.status) setStatus(data.status);
        if (data.intake) setIntake(data.intake);
        setSkipError("Answer Sweetie's first question first, then you can skip the rest.");
        setSkipping(false);
        return;
      }
      router.push(`/patient/${token}`);
    } catch (error) {
      setSkipError(error instanceof Error ? error.message : "We couldn't save your choice. Please try again.");
      setSkipping(false);
    }
  }

  const completeFields = fields.filter((field) => {
    const confidence = intake?.fields[field.id]?.confidence;
    return confidence === "medium" || confidence === "high";
  }).length;
  const finished = Boolean(status?.done || intake?.wrapped);
  const totalSteps = fields.length + 1;
  const completedSteps = completeFields + (finished ? 1 : 0);
  const progress = totalSteps
    ? Math.round((completedSteps / totalSteps) * 100)
    : 0;
  const canVoice = support.speak && support.listen;
  const micLabel =
    mic === "listening"
      ? "Listening… tap when you're done"
      : mic === "speaking"
        ? "Sweetie is speaking. Start talking to interrupt."
        : mic === "thinking"
          ? "Thinking…"
          : mic === "idle"
            ? "Tap the mic to talk"
            : "";

  return (
    <main className="ss-page sweetie-theme sweetie-chat-page">
      <div className="ss-container sweetie-chat-container">
        <header className="ss-topbar sweetie-chat-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
          {agent && !agent.connected ? (
            <span className="sweetie-agent-badge">Demo mode</span>
          ) : (
            <span className="sweetie-agent-badge sweetie-agent-connected">
              <span />
              Private &amp; secure
            </span>
          )}
        </header>

        {sandboxPatient === false && <DexcomDemoLink token={token} disabled={busy || Boolean(uploading) || skipping} />}
        {sandboxPatient === true && (
          <p className="mb-4 text-sm">
            <a href={`/s/${token}/intake`} className="underline">Connect Dexcom sandbox</a>
            {" "}— only the dedicated demo patient is permitted.
          </p>
        )}
        {sandboxPatient === null && (
          <p role="status" className="mb-4 text-sm">
            {dexcomStatusError ? "Could not check connections. Reload to try again; file uploads are hidden until the patient type is confirmed." : "Checking data connections…"}
          </p>
        )}

        <section className="sweetie-chat-shell ss-card ss-enter">
          <aside className="sweetie-chat-sidebar">
            <div className="sweetie-chat-intro">
              <p className="ss-eyebrow">YOUR CHECK-IN</p>
              <h1>
                Let&apos;s get your story
                <br />
                <em>ready.</em>
              </h1>
              <p>
                Two quick questions, one at a time. Sharing health data is
                optional.
              </p>
            </div>

            <div className="sweetie-chat-character">
              <Image
                src="/assets/sweetie/sweetie.png"
                alt="Sweetie"
                width={280}
                height={280}
                priority
              />
            </div>

            <div className="sweetie-progress-card">
              <div>
                <span>Conversation progress</span>
                <strong>{progress}%</strong>
              </div>
              <div className="sweetie-progress-track">
                <span style={{ width: `${progress}%` }} />
              </div>
              <small>
                {finished
                  ? "Your story is ready"
                  : `${completeFields} of ${fields.length || "—"} questions answered`}
              </small>
            </div>

            {/* Skipping only makes sense once there is something to show. Until the patient has answered
                a question or added data, the primary action is the conversation itself. */}
            {(completeFields > 0 || status?.hasDexcom || status?.hasLocation || status?.hasWhoop) && !finished ? (
              <button type="button" className="ss-text-button sweetie-skip-link" disabled={busy || Boolean(uploading) || skipping || !status} onClick={() => void skipQuestions()}>
                {skipping ? "Saving…" : "Skip the rest and view my week"}
              </button>
            ) : !finished ? (
              <p className="sweetie-skip-hint">Answer Sweetie&apos;s first question to get started. It takes about five minutes.</p>
            ) : null}
            {skipError && <p role="alert">{skipError}</p>}

            {sandboxPatient === false && (
              <fieldset disabled={busy || Boolean(uploading) || skipping} className="sweetie-upload-list">
                <p>Optional health data</p>
                <UploadButton
                  label="Dexcom"
                  detail="Glucose CSV"
                  short="D"
                  kind="dexcom"
                  done={status?.hasDexcom}
                  loading={uploading === "dexcom"}
                  onFile={upload}
                />
                <UploadButton
                  label="Timeline"
                  detail="Google JSON"
                  short="M"
                  kind="timeline"
                  done={status?.hasLocation}
                  loading={uploading === "timeline"}
                  onFile={upload}
                />
                <UploadButton
                  label="WHOOP"
                  detail="Sleep CSV"
                  short="W"
                  kind="whoop"
                  done={status?.hasWhoop}
                  loading={uploading === "whoop"}
                  onFile={upload}
                />
              </fieldset>
            )}
          </aside>

          <div className="sweetie-conversation">
            <header className="sweetie-conversation-head">
              <div>
                <span className="sweetie-online-dot" />
                <div>
                  <strong>Sweetie</strong>
                  <small>Here with you · one question at a time</small>
                </div>
              </div>
              <span className="sweetie-private">⌾ Private check-in</span>
            </header>

            {status && intake && fields.length > 0 && (
              <Progress status={status} intake={intake} fields={fields} />
            )}

            <div className="sweetie-messages" aria-live="polite">
              {messages.map((message, index) => (
                <div
                  key={`${message.createdAt ?? "message"}-${index}`}
                  className={`sweetie-message-row ${
                    message.role === "patient"
                      ? "sweetie-message-patient"
                      : ""
                  }`}
                >
                  {message.role === "sweetie" && (
                    <Image
                      src="/assets/sweetie/sweetie.png"
                      alt=""
                      width={36}
                      height={36}
                    />
                  )}
                  <div className="sweetie-message">{message.content}</div>
                </div>
              ))}
              {interim && (
                <div className="sweetie-message-row sweetie-message-patient">
                  <div className="sweetie-message sweetie-interim">
                    {interim}…
                  </div>
                </div>
              )}
              {busy && (
                <div className="sweetie-message-row">
                  <Image
                    src="/assets/sweetie/sweetie.png"
                    alt=""
                    width={36}
                    height={36}
                  />
                  <div
                    className="sweetie-message sweetie-typing"
                    aria-label="Sweetie is typing"
                  >
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              )}
              {finished && (
                <a href={`/patient/${token}`} className="sweetie-done-card">
                  <span>✓</span>
                  <div>
                    <strong>Your check-in is complete</strong>
                    <small>
                      See the summary you&apos;ll share with your doctor
                    </small>
                  </div>
                  <b aria-hidden="true">→</b>
                </a>
              )}
              <div ref={bottom} />
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send(text);
              }}
              className="sweetie-composer"
            >
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  mic === "listening"
                    ? interim
                      ? ""
                      : "Listening…"
                    : "Type or tap the mic…"
                }
                disabled={busy}
                aria-label="Reply to Sweetie"
              />
              {canVoice && (
                <button
                  type="button"
                  onClick={toggleMic}
                  aria-pressed={mic !== "off"}
                  aria-label={mic === "off" ? "Talk to Sweetie" : "Stop voice"}
                  title={mic === "off" ? "Talk to Sweetie" : "Stop voice"}
                  className={`sweetie-mic-button sweetie-mic-${mic}`}
                >
                  {mic === "speaking" ? <SpeakerIcon /> : <MicIcon />}
                </button>
              )}
              <button
                type="submit"
                disabled={busy || !text.trim()}
                aria-label="Send message"
                className="sweetie-send-button"
              >
                <span>Send</span>
                <b aria-hidden="true">↑</b>
              </button>
            </form>
            <p className="sweetie-composer-note">
              {micNote ||
                micLabel ||
                "Sweetie can prepare for your visit, but cannot give medical advice."}
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

function UploadButton({
  label,
  detail,
  short,
  kind,
  done,
  loading,
  onFile,
}: {
  label: string;
  detail: string;
  short: string;
  kind: UploadKind;
  done?: boolean;
  loading: boolean;
  onFile: (kind: UploadKind, file: File) => void;
}) {
  return (
    <label
      className={`sweetie-upload-card ${
        done ? "sweetie-upload-done" : ""
      }`}
    >
      <span className="sweetie-upload-icon">{short}</span>
      <span>
        <strong>{label}</strong>
        <small>{loading ? "Adding file…" : done ? "Connected" : detail}</small>
      </span>
      <b>{loading ? "…" : done ? "✓" : "+"}</b>
      <input
        type="file"
        accept={kind === "timeline" ? ".json,application/json" : ".csv,text/csv"}
        disabled={loading}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(kind, file);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function Progress({
  status,
  intake,
  fields,
}: {
  status: IntakeStatus;
  intake: IntakeState;
  fields: IntakeFieldDef[];
}) {
  const filled = (id: string) => {
    const confidence = intake.fields[id]?.confidence ?? "unfilled";
    return confidence === "medium" || confidence === "high";
  };
  const finished = intake.wrapped || status.done;
  const firstOpen = fields.find((field) => !filled(field.id));
  const currentKey = finished ? "done" : (firstOpen?.id ?? "done");
  const steps = [
    ...fields.map((field) => ({
      key: field.id,
      label: field.label,
      done: filled(field.id),
    })),
    { key: "done", label: "Done", done: finished },
  ];

  return (
    <ol className="sweetie-field-progress" aria-label="Intake steps">
      {steps.map((step, index) => {
        const current = step.key === currentKey;
        return (
          <li
            key={step.key}
            title={
              step.key === "done"
                ? "Check-in complete"
                : intake.fields[step.key]?.value ??
                  fields.find((field) => field.id === step.key)?.goal
            }
            className={
              step.done
                ? "sweetie-field-done"
                : current
                  ? "sweetie-field-current"
                  : ""
            }
            aria-current={current ? "step" : undefined}
          >
            <b>{step.done ? "✓" : index + 1}</b>
            {step.label}
          </li>
        );
      })}
      {intake.flagged && (
        <li className="sweetie-field-flagged">Flagged for the office</li>
      )}
    </ol>
  );
}
