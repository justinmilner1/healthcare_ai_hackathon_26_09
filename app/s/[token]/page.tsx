"use client";

import Image from "next/image";
import { use, useEffect, useRef, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import type {
  ChatMessage,
  IntakeFieldDef,
  IntakeState,
  IntakeStatus,
  UploadKind,
} from "@/lib/types";

type AgentInfo = { connected: boolean; model: string };

export default function SweetiePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [fields, setFields] = useState<IntakeFieldDef[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<UploadKind | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/sweetie?token=${encodeURIComponent(token)}`)
      .then((response) => response.json())
      .then((data) => {
        setMessages(data.messages ?? []);
        setStatus(data.status ?? null);
        setIntake(data.intake ?? null);
        setFields(data.intakeFields ?? []);
        setAgent(data.agent ?? null);
      });
  }, [token]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    const mine = text.trim();
    setText("");
    setMessages((current) => [
      ...current,
      { role: "patient", content: mine },
    ]);
    setBusy(true);
    try {
      const response = await fetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, message: mine }),
      });
      const data = await response.json();
      setMessages((current) => [
        ...current,
        {
          role: "sweetie",
          content:
            data.reply ??
            "I had trouble with that reply. Could you try once more?",
        },
      ]);
      setStatus(data.status);
      if (data.intake) setIntake(data.intake);
      if (data.intakeFields) setFields(data.intakeFields);
      if (data.agent) setAgent(data.agent);
    } finally {
      setBusy(false);
    }
  }

  async function upload(kind: UploadKind, file: File) {
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
        setMessages((current) => [
          ...current,
          {
            role: "sweetie",
            content: `That file didn't work: ${data.error}. Want to try again, or ask me how to export it?`,
          },
        ]);
        return;
      }
      if (data.status) setStatus(data.status);

      setBusy(true);
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
      const next = await sweetieResponse.json();
      if (next.reply) {
        setMessages((current) => [
          ...current,
          { role: "sweetie", content: next.reply },
        ]);
      }
      if (next.status) setStatus(next.status);
      if (next.intake) setIntake(next.intake);
      if (next.intakeFields) setFields(next.intakeFields);
      if (next.agent) setAgent(next.agent);
    } finally {
      setUploading(null);
      setBusy(false);
    }
  }

  const completeFields = fields.filter((field) => {
    const confidence = intake?.fields[field.id]?.confidence;
    return confidence === "medium" || confidence === "high";
  }).length;
  const progress = fields.length
    ? Math.round((completeFields / fields.length) * 100)
    : 0;

  return (
    <main className="ss-page sweetie-theme sweetie-chat-page">
      <div className="ss-container sweetie-chat-container">
        <header className="ss-topbar sweetie-chat-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
          <AgentBadge agent={agent} />
        </header>

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
                Share what you have. Sweetie will guide the rest one question
                at a time.
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
                {completeFields} of {fields.length || "—"} details collected
              </small>
            </div>

            <div className="sweetie-upload-list">
              <p>Connected health data</p>
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
            </div>
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

            {intake && fields.length > 0 && (
              <Progress intake={intake} fields={fields} />
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
                      width={34}
                      height={34}
                    />
                  )}
                  <div className="sweetie-message">{message.content}</div>
                </div>
              ))}
              {busy && (
                <div className="sweetie-message-row">
                  <Image
                    src="/assets/sweetie/sweetie.png"
                    alt=""
                    width={34}
                    height={34}
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
              {status?.done && (
                <a
                  href={`/patient/${token}`}
                  className="sweetie-done-card"
                >
                  <span>✓</span>
                  <div>
                    <strong>Your check-in is complete</strong>
                    <small>See the summary you&apos;ll share with your doctor</small>
                  </div>
                  <b aria-hidden="true">→</b>
                </a>
              )}
              <div ref={bottom} />
            </div>

            <form onSubmit={send} className="sweetie-composer">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type your reply…"
                disabled={busy}
                aria-label="Reply to Sweetie"
              />
              <button
                disabled={busy || !text.trim()}
                aria-label="Send message"
              >
                <span>Send</span>
                <b aria-hidden="true">↑</b>
              </button>
            </form>
            <p className="sweetie-composer-note">
              Sweetie can help prepare for your visit, but cannot give medical
              advice.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function AgentBadge({ agent }: { agent: AgentInfo | null }) {
  if (!agent) {
    return (
      <div className="sweetie-agent-badge sweetie-agent-loading">
        <span />
        Making connection…
      </div>
    );
  }

  const explanation = agent.connected
    ? `Sweetie sends each reply to ${agent.model} through Amazon Bedrock.`
    : "Sweetie is using fixed fallback questions because no model API key is configured.";

  return (
    <button
      type="button"
      className={`sweetie-agent-badge ${
        agent.connected ? "sweetie-agent-connected" : ""
      }`}
      aria-label={explanation}
      title={explanation}
    >
      <span />
      {agent.connected ? `Connected to ${agent.model}` : "Scripted demo mode"}
    </button>
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
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file) onFile(kind, file);
          e.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function Progress({
  intake,
  fields,
}: {
  intake: IntakeState;
  fields: IntakeFieldDef[];
}) {
  return (
    <div className="sweetie-field-progress" aria-label="Topics covered">
      {fields.map((field) => {
        const confidence =
          intake.fields[field.id]?.confidence ?? "unfilled";
        const done = confidence === "medium" || confidence === "high";
        return (
          <span
            key={field.id}
            title={intake.fields[field.id]?.value ?? field.goal}
            className={done ? "sweetie-field-done" : ""}
          >
            {done ? "✓ " : ""}
            {field.label}
          </span>
        );
      })}
      {intake.flagged && (
        <span className="sweetie-field-flagged">Flagged for the office</span>
      )}
    </div>
  );
}
