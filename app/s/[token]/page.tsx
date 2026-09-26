"use client";

// Sweetie: voice-first intake, reached from the presigned link. Owner: Justin (voice + brain), Nisarga (onboarding at /intake).
// Voice mode: Sweetie speaks each message aloud and listens for the reply; a final transcript is posted to
// /api/sweetie like typed text. Typing always works too. Uses GET/POST /api/sweetie and POST /api/upload.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ChatMessage, IntakeFieldDef, IntakeState, IntakeStatus, UploadKind } from "@/lib/types";
import { hush, listenOnce, say, voiceSupport, warmVoices } from "@/lib/voice";

type AgentInfo = { connected: boolean; model: string };
type VoiceState = "off" | "speaking" | "listening" | "thinking" | "idle";

export default function SweetiePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [skipError, setSkipError] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<IntakeStatus | null>(null);
  const [intake, setIntake] = useState<IntakeState | null>(null);
  const [fields, setFields] = useState<IntakeFieldDef[]>([]);
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<VoiceState>("off");
  const [interim, setInterim] = useState("");
  const [support, setSupport] = useState({ listen: false, speak: false });
  const bottom = useRef<HTMLDivElement>(null);
  const voiceOn = useRef(false);
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
      });
    return () => {
      voiceOn.current = false;
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
    return d.reply ?? "";
  }, []);

  // ---- voice loop: speak the last Sweetie line, then listen, then send, then repeat ------------------------

  const listen = useCallback(() => {
    if (!voiceOn.current) return;
    setVoice("listening");
    setInterim("");
    listener.current = listenOnce({
      onInterim: (t) => setInterim(t),
      onSpeechStart: () => hush(),
      onFinal: (t) => {
        setInterim("");
        void sendMessage(t, true);
      },
      onEnd: () => {
        // No speech caught: stay in the loop but don't hammer the mic. The person can tap the mic again.
        setVoice((v) => (v === "listening" ? "idle" : v));
      },
      onError: () => setVoice("idle"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speakThenListen = useCallback(
    async (line: string) => {
      if (!voiceOn.current) return;
      setVoice("speaking");
      await say(line);
      if (voiceOn.current && !(status?.done && intake?.wrapped)) listen();
      else setVoice("idle");
    },
    [listen, status?.done, intake?.wrapped],
  );

  async function sendMessage(raw: string, spoken = false) {
    const mine = raw.trim();
    if (!mine || busy || skipping) return;
    setText("");
    setMessages((m) => [...m, { role: "patient", content: mine }]);
    setBusy(true);
    if (voiceOn.current) setVoice("thinking");
    const res = await fetch("/api/sweetie", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, message: mine }) });
    const d = await res.json();
    const reply = applyReply(d);
    setBusy(false);
    if (voiceOn.current && (spoken || voice !== "off")) await speakThenListen(reply);
  }

  async function startVoice() {
    if (busy || skipping) return;
    voiceOn.current = true;
    const last = [...messages].reverse().find((m) => m.role === "sweetie")?.content ?? "";
    await speakThenListen(last);
  }

  function stopVoice() {
    voiceOn.current = false;
    listener.current?.stop();
    hush();
    setInterim("");
    setVoice("off");
  }

  async function upload(kind: UploadKind, file: File) {
    if (busy || skipping) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("token", token);
    fd.set("kind", kind);
    fd.set("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) {
      setBusy(false);
      const line = `That file didn't work: ${d.error}. Want to try again, or ask me how to export it?`;
      setMessages((m) => [...m, { role: "sweetie", content: line }]);
      if (voiceOn.current) await speakThenListen(line);
      return;
    }
    if (d.status) setStatus(d.status);
    setBusy(true);
    if (voiceOn.current) {
      listener.current?.stop();
      setVoice("thinking");
    }
    const r2 = await fetch("/api/sweetie", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, event: { type: "upload", kind, count: d.count, days: d.days } }),
    });
    const reply = applyReply(await r2.json());
    setBusy(false);
    if (voiceOn.current) await speakThenListen(reply);
  }

  async function skipQuestions() {
    if (busy || skipping) return;
    stopVoice();
    setSkipping(true);
    setSkipError("");
    try {
      const response = await fetch("/api/sweetie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, event: { type: "skip_questions" } }),
      });
      if (!response.ok) throw new Error("We couldn't save your choice. Please try again.");
      router.push(`/patient/${token}`);
    } catch (error) {
      setSkipError(error instanceof Error ? error.message : "We couldn't save your choice. Please try again.");
      setSkipping(false);
    }
  }

  const canVoice = support.speak && support.listen;

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col p-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Sweetie 🍬</h1>
        <AgentBadge agent={agent} />
      </header>

      <button type="button" disabled={busy || skipping || !status} onClick={() => void skipQuestions()} className="mt-3 rounded border px-3 py-2 text-sm disabled:opacity-50">
        {skipping ? "Saving…" : "Skip questions and view my week"}
      </button>
      {skipError && <p role="alert" className="mt-2 text-sm text-red-700">{skipError}</p>}

      <fieldset disabled={busy || skipping} className="mt-2 flex flex-wrap gap-2 text-xs">
        <UploadButton label="Dexcom CSV" kind="dexcom" done={status?.hasDexcom} onFile={upload} />
        <UploadButton label="Maps Timeline JSON" kind="timeline" done={status?.hasLocation} onFile={upload} />
        <UploadButton label="WHOOP CSV" kind="whoop" done={status?.hasWhoop} onFile={upload} />
      </fieldset>
      {intake && fields.length > 0 && <Progress intake={intake} fields={fields} />}

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

      <div className="mt-3 flex items-center gap-2">
        {canVoice ? (
          voice === "off" ? (
            <button type="button" onClick={startVoice} className="flex items-center gap-2 rounded-full bg-pink-600 px-4 py-2 text-sm font-medium text-white">
              <MicIcon /> Talk to Sweetie
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => (voice === "listening" ? listener.current?.stop() : voice === "speaking" ? (hush(), listen()) : listen())}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white ${voice === "listening" ? "animate-pulse bg-red-600" : voice === "speaking" ? "bg-pink-600" : voice === "thinking" ? "bg-gray-500" : "bg-pink-600"}`}
                title={voice === "listening" ? "Tap when you're done" : voice === "speaking" ? "Tap to skip and answer" : "Tap to talk"}
              >
                <MicIcon />
                {voice === "listening" ? "Listening…" : voice === "speaking" ? "Sweetie is talking" : voice === "thinking" ? "Thinking…" : "Tap to talk"}
              </button>
              <button type="button" onClick={stopVoice} className="rounded-full border border-black/15 px-3 py-2 text-xs">Switch to typing</button>
            </>
          )
        ) : (
          <span className="text-xs text-gray-500">Voice needs Chrome or Safari. You can type below.</span>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendMessage(text);
        }}
        className="mt-2 flex gap-2"
      >
        <input className="flex-1 rounded border p-2" value={text} onChange={(e) => setText(e.target.value)} placeholder={voice === "off" ? "Type a reply…" : "Or type instead…"} disabled={busy || skipping} />
        <button className="rounded bg-black px-4 text-white disabled:opacity-50" disabled={busy || skipping}>Send</button>
      </form>
    </main>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
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

function Progress({ intake, fields }: { intake: IntakeState; fields: IntakeFieldDef[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
      {fields.map((f) => {
        const c = intake.fields[f.id]?.confidence ?? "unfilled";
        const done = c === "medium" || c === "high";
        return (
          <span key={f.id} title={intake.fields[f.id]?.value ?? f.goal} className={`rounded-full px-2 py-0.5 ${done ? "bg-green-100 text-green-800" : c === "low" ? "bg-amber-50 text-amber-800" : f.required ? "bg-gray-100 text-gray-500" : "bg-gray-50 text-gray-400"}`}>
            {done ? "✓ " : ""}{f.label}
          </span>
        );
      })}
      {intake.flagged && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-800">Flagged for the office</span>}
    </div>
  );
}
