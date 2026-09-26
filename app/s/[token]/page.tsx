"use client";

// Sweetie: voice-first intake, reached from the presigned link. Owner: Justin (voice + brain), Nisarga (onboarding at /intake).
// One mic in the chat bar toggles hands-free mode: tap, talk, Sweetie answers aloud and listens again. Tap again to stop.
// A final transcript is posted to /api/sweetie exactly like typed text. Uses GET/POST /api/sweetie and POST /api/upload.

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, IntakeFieldDef, IntakeState, IntakeStatus, UploadKind } from "@/lib/types";
import { explainMicError, hush, listenOnce, say, voiceSupport, warmVoices } from "@/lib/voice";

type AgentInfo = { connected: boolean; model: string };
type Mic = "off" | "listening" | "thinking" | "speaking" | "idle";

export default function SweetiePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [fields, setFields] = useState<IntakeFieldDef[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mic, setMic] = useState<Mic>("off");
  const [micNote, setMicNote] = useState("");
  const [interim, setInterim] = useState("");
  const [support, setSupport] = useState({ listen: false, speak: false });
  const bottom = useRef<HTMLDivElement>(null);
  const micOn = useRef(false); // hands-free mode; refs so the async loop never reads stale state
  const done = useRef(false);
  const listener = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setSupport(voiceSupport());
    warmVoices();
    fetch(`/api/sweetie?token=${token}`)
      .then((r) => r.json())
      .then((d) => {
        setMessages(d.messages ?? []);
        setStatus(d.status ?? null);
        setIntake(d.intake ?? null);
        setFields(d.intakeFields ?? []);
        setAgent(d.agent ?? null);
        done.current = Boolean(d.status?.done && d.intake?.wrapped);
      });
    return () => {
      micOn.current = false;
      listener.current?.stop();
      hush();
    };
  }, [token]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim]);

  const applyReply = useCallback((d: { reply?: string; status?: IntakeStatus; intake?: IntakeState; intakeFields?: IntakeFieldDef[]; agent?: AgentInfo }) => {
    if (d.reply) setMessages((m) => [...m, { role: "sweetie", content: d.reply! }]);
    if (d.status) setStatus(d.status);
    if (d.intake) setIntake(d.intake);
    if (d.intakeFields) setFields(d.intakeFields);
    if (d.agent) setAgent(d.agent);
    done.current = Boolean(d.status?.done && d.intake?.wrapped);
    return d.reply ?? "";
  }, []);

  // ---- hands-free loop -----------------------------------------------------------------------------------

  const listen = useCallback(() => {
    if (!micOn.current) return;
    setMic("listening");
    setMicNote("");
    setInterim("");
    listener.current = listenOnce({
      onInterim: (t) => setInterim(t),
      onSpeechStart: () => hush(),
      onFinal: (t) => {
        setInterim("");
        void send(t);
      },
      onEnd: () => setMic((m) => (m === "listening" ? "idle" : m)),
      onError: (code) => {
        setMicNote(explainMicError(code));
        if (code === "not-allowed" || code === "service-not-allowed" || code === "unsupported") {
          micOn.current = false;
          setMic("off");
        } else setMic("idle");
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speakThenListen = useCallback(
    async (line: string) => {
      if (!micOn.current) return;
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
    if (!mine) return;
    setText("");
    setMessages((m) => [...m, { role: "patient", content: mine }]);
    setBusy(true);
    if (micOn.current) setMic("thinking");
    const res = await fetch("/api/sweetie", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, message: mine }) });
    const reply = applyReply(await res.json());
    setBusy(false);
    if (micOn.current) await speakThenListen(reply);
  }

  function toggleMic() {
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
    const fd = new FormData();
    fd.set("token", token);
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) {
      const line = `That file didn't work: ${d.error}. Want to try again, or ask me how to export it?`;
      setMessages((m) => [...m, { role: "sweetie", content: line }]);
      if (micOn.current) await speakThenListen(line);
      return;
    }
    if (d.status) setStatus(d.status);
    setBusy(true);
    if (micOn.current) {
      listener.current?.stop();
      setMic("thinking");
    }
    const r2 = await fetch("/api/sweetie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, event: { type: "upload", kind, count: d.count, days: d.days } }),
    });
    const reply = applyReply(await r2.json());
    setBusy(false);
    if (micOn.current) await speakThenListen(reply);
  }

  const canVoice = support.speak && support.listen;
  const micLabel = mic === "listening" ? "Listening… tap when you're done" : mic === "speaking" ? "Sweetie is speaking. Start talking to interrupt." : mic === "thinking" ? "Thinking…" : mic === "idle" ? "Tap the mic to talk" : "";

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col p-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Sweetie 🍬</h1>
        <AgentBadge agent={agent} />
      </header>

      {status && intake && <IntakeSteps status={status} intake={intake} fields={fields} onFile={upload} />}

      <div className="mt-4 flex-1 space-y-2 overflow-y-auto rounded border p-3">
        {messages.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === "sweetie" ? "bg-pink-50" : "ml-auto bg-gray-100"}`}>
            {m.content}
          </div>
        ))}
        {interim && <div className="ml-auto max-w-[85%] rounded-lg bg-gray-50 px-3 py-2 text-sm italic text-gray-500">{interim}…</div>}
        {status?.done && (
          <a href={`/patient/${token}`} className="block rounded bg-green-50 px-3 py-2 text-center text-sm underline">
            All done. See your summary →
          </a>
        )}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        className="mt-3"
      >
        <div className="flex items-center gap-2 rounded-full border border-black/15 bg-white py-1 pl-4 pr-1 focus-within:border-black/40">
          <input
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mic === "listening" ? (interim ? "" : "Listening…") : "Type or tap the mic"}
            disabled={busy}
          />
          {canVoice && (
            <button
              type="button"
              onClick={toggleMic}
              aria-pressed={mic !== "off"}
              aria-label={mic === "off" ? "Talk to Sweetie" : "Stop voice"}
              title={mic === "off" ? "Talk to Sweetie" : "Stop voice"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                mic === "listening" ? "animate-pulse bg-red-600 text-white" : mic === "speaking" ? "bg-pink-600 text-white" : mic === "thinking" ? "bg-gray-400 text-white" : mic === "idle" ? "bg-pink-100 text-pink-700" : "text-gray-500 hover:bg-black/5"
              }`}
            >
              {mic === "speaking" ? <SpeakerIcon /> : <MicIcon />}
            </button>
          )}
          <button type="submit" disabled={busy || !text.trim()} className="h-9 rounded-full bg-black px-4 text-sm text-white disabled:opacity-30">
            Send
          </button>
        </div>
        <p className="mt-1 h-4 px-4 text-[11px] text-gray-500">{micNote || micLabel}</p>
      </form>
    </main>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

function AgentBadge({ agent }: { agent: AgentInfo | null }) {
  if (!agent) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        Making connection…
      </div>
    );
  }
  const explanation = agent.connected
    ? `Sweetie sends each reply to ${agent.model} through Amazon Bedrock.`
    : "Sweetie is using fixed fallback questions instead of an AI model because no model API key is configured. To connect the model, set OPENAI_API_KEY in .env and restart the development server.";
  return (
    <button
      type="button"
      className={`group relative flex cursor-help items-center gap-1.5 rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${agent.connected ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"}`}
      aria-label={explanation}
    >
      <span className={`h-2 w-2 rounded-full ${agent.connected ? "bg-green-500" : "bg-gray-400"}`} />
      {agent.connected ? `Connected to ${agent.model}` : "Scripted demo mode"}
      <span className="pointer-events-none absolute right-0 top-full z-10 mt-2 hidden w-72 rounded-lg bg-gray-900 p-3 text-left text-xs leading-relaxed text-white shadow-lg group-hover:block group-focus:block">
        {explanation}
      </span>
    </button>
  );
}

function UploadButton({ label, kind, done, onFile }: { label: string; kind: UploadKind; done?: boolean; onFile: (k: UploadKind, f: File) => void }) {
  return (
    <label className={`cursor-pointer rounded border px-2 py-1 ${done ? "bg-green-100" : "bg-white"}`}>
      {done ? "✓ " : ""}{label}
      <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(kind, e.target.files[0])} />
    </label>
  );
}

type Step = { key: string; label: string; state: "done" | "current" | "todo" };

/** The intake as numbered steps, all visible at once: each field of the visit template, then done.
 * Sharing data is not a step; it sits below as an optional panel. */
function IntakeSteps({ status, intake, fields, onFile }: { status: IntakeStatus; intake: IntakeState; fields: IntakeFieldDef[]; onFile: (k: UploadKind, f: File) => void }) {
  const filled = (id: string) => {
    const c = intake.fields[id]?.confidence ?? "unfilled";
    return c === "medium" || c === "high";
  };
  const finished = intake.wrapped || status.done;
  const firstOpen = fields.find((f) => !filled(f.id));
  const currentKey = finished ? "done" : (firstOpen?.id ?? "done");
  const steps: Step[] = [
    ...fields.map<Step>((f) => ({ key: f.id, label: f.label, state: filled(f.id) ? "done" : f.id === currentKey ? "current" : "todo" })),
    { key: "done", label: "Done", state: finished ? "done" : "todo" },
  ];
  const total = steps.length;
  const doneCount = steps.filter((x) => x.state === "done").length;
  const currentIndex = Math.max(0, steps.findIndex((x) => x.key === currentKey));
  const shared = [status.hasDexcom && "Dexcom", status.hasLocation && "Timeline", status.hasWhoop && "WHOOP"].filter(Boolean) as string[];

  return (
    <section className="mt-3 space-y-2" aria-label="Intake progress">
      <div className="rounded-lg border border-black/10 bg-[var(--viz-surface)] p-3">
        <div className="flex items-baseline justify-between">
          <p className="text-sm">
            <span className="font-semibold">{finished ? "All done" : `Step ${currentIndex + 1} of ${total}`}</span>
            {!finished && <span className="text-[var(--viz-ink-2)]"> · {steps[currentIndex].label}</span>}
          </p>
          <p className="text-[11px] text-[var(--viz-muted)]">about 10 minutes</p>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/5">
          <div className="h-full rounded-full bg-pink-500 transition-all" style={{ width: `${(doneCount / total) * 100}%` }} />
        </div>
        <ol className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {steps.map((st, i) => (
            <li
              key={st.key}
              aria-current={st.state === "current" ? "step" : undefined}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-1 ${
                st.state === "done"
                  ? "border-green-200 bg-green-50 text-green-800"
                  : st.state === "current"
                    ? "border-pink-300 bg-pink-50 font-medium text-pink-800"
                    : "border-black/10 text-[var(--viz-muted)]"
              }`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${st.state === "done" ? "bg-green-600 text-white" : st.state === "current" ? "bg-pink-600 text-white" : "bg-black/10"}`}>
                {st.state === "done" ? "✓" : i + 1}
              </span>
              {st.label}
            </li>
          ))}
        </ol>
        {intake.flagged && <p className="mt-2 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-800">Flagged for the office. Someone will follow up before the visit.</p>}
      </div>

      <details className="rounded-lg border border-dashed border-black/15 px-3 py-2 text-xs text-[var(--viz-ink-2)]">
        <summary className="cursor-pointer select-none">
          <span className="font-medium text-[var(--viz-ink)]">Optional:</span> share your data
          {shared.length > 0 && <span className="text-green-700"> · {shared.join(", ")} added</span>}
        </summary>
        <p className="mt-2 text-[11px] text-[var(--viz-muted)]">If you have a Dexcom export handy, your doctor can see the week in numbers. Timeline and WHOOP add context. None of it is required.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <UploadButton label="Dexcom CSV" kind="dexcom" done={status.hasDexcom} onFile={onFile} />
          <UploadButton label="Maps Timeline JSON" kind="timeline" done={status.hasLocation} onFile={onFile} />
          <UploadButton label="WHOOP CSV" kind="whoop" done={status.hasWhoop} onFile={onFile} />
        </div>
      </details>
    </section>
  );
}
