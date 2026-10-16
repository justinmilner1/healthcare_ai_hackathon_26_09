// Browser voice for Sweetie: speech synthesis to talk, speech recognition to listen. Client only.
//
// No lib/voice.test.ts, and no row in the `npm run test:coverage` table (design §12.1): every line of this
// file is a call into `window.speechSynthesis` or `webkitSpeechRecognition`, neither of which exists under
// `node --test`. A stub for them would be a test of the stub. The browser's half is exercised by the e2e
// suite, and the agent's half does not go through here at all: a final transcript is posted to
// /api/sweetie exactly like typed text, which is why lib/sweetieTurn.ts neither knows nor cares which it
// was.
// Chrome and Safari (desktop and iOS) ship both behind the webkit prefix; nothing to install, no keys.
// The brain is unchanged: a final transcript is posted to /api/sweetie exactly like typed text.

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function RecognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupport(): { listen: boolean; speak: boolean } {
  return { listen: RecognitionCtor() !== null, speak: typeof window !== "undefined" && "speechSynthesis" in window };
}

const PREFERRED_VOICES = ["Samantha", "Karen", "Moira", "Google US English", "Microsoft Aria", "Microsoft Jenny"];

let cachedVoices: SpeechSynthesisVoice[] = [];

/** Browsers load voices asynchronously; call once on mount so the first utterance gets a good voice. */
export function warmVoices() {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const load = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
  load();
  window.speechSynthesis.onvoiceschanged = load;
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = cachedVoices.length ? cachedVoices : window.speechSynthesis.getVoices();
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((x) => x.name.startsWith(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang.startsWith("en") && v.default) ?? voices.find((v) => v.lang.startsWith("en")) ?? null;
}

let current: SpeechSynthesisUtterance | null = null; // keep a reference: Chrome drops GC'd utterances mid-sentence

/** Speak text aloud. Resolves when finished, cancelled, or when the browser goes quiet without saying so.
 * Chrome quirks handled: speaking immediately after cancel() can silently drop the utterance; long utterances
 * pause unless resume() is poked; onend sometimes never fires. */
export function say(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return resolve();
    const synth = window.speechSynthesis;
    const clean = text.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/g, " ").trim();
    if (!clean) return resolve();
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    current = u;
    const v = pickVoice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    let settled = false;
    let started = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      clearTimeout(guard);
      if (current === u) current = null;
      resolve();
    };
    u.onstart = () => {
      started = true;
    };
    u.onend = finish;
    u.onerror = finish;
    // Fallback: roughly 15 chars/sec plus slack. If the browser never reports the end, we still move on.
    const guard = setTimeout(finish, 1500 + clean.length * 80);
    const tick = setInterval(() => {
      if (started && !synth.speaking && !synth.pending) finish();
      else if (synth.paused) synth.resume();
    }, 250);
    setTimeout(() => synth.speak(u), 80);
  });
}

export function hush() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** One listening turn. Calls onInterim while the person talks and onFinal once with the finished sentence. */
/** Human-readable reason a listen failed, for the UI. */
export function explainMicError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone is blocked. Allow it in the address bar, then tap the mic again.";
  if (code === "audio-capture") return "No microphone found.";
  if (code === "network") return "Speech recognition needs an internet connection.";
  if (code === "unsupported") return "This browser cannot listen. Try Chrome or Safari, or type instead.";
  return `Couldn't hear you (${code}). Tap the mic to try again.`;
}

export function listenOnce(handlers: { onInterim?: (t: string) => void; onFinal: (t: string) => void; onEnd?: () => void; onSpeechStart?: () => void; onError?: (code: string) => void }): { stop: () => void } {
  const Ctor = RecognitionCtor();
  if (!Ctor) {
    handlers.onError?.("unsupported");
    handlers.onEnd?.();
    return { stop: () => {} };
  }
  const r = new Ctor();
  r.lang = "en-US";
  r.continuous = false;
  r.interimResults = true;
  let finalText = "";
  let done = false;
  r.onspeechstart = () => handlers.onSpeechStart?.();
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const t = res[0]?.transcript ?? "";
      if (res.isFinal) finalText += t;
      else interim += t;
    }
    if (interim) handlers.onInterim?.(interim);
  };
  r.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") handlers.onError?.(e.error);
  };
  (r as unknown as { onnomatch: (() => void) | null }).onnomatch = () => {
    /* treated like no-speech: onend follows */
  };
  r.onend = () => {
    if (done) return;
    done = true;
    const t = finalText.trim();
    if (t) handlers.onFinal(t);
    handlers.onEnd?.();
  };
  try {
    r.start();
  } catch {
    handlers.onError?.("start-failed");
    handlers.onEnd?.();
  }
  return {
    stop: () => {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
