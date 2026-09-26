// Browser voice for Sweetie: speech synthesis to talk, speech recognition to listen. Client only.
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

/** Speak text aloud. Resolves when finished or cancelled. Strips emoji so the voice does not say "candy". */
export function say(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    window.speechSynthesis.cancel();
    const clean = text.replace(/[\p{Extended_Pictographic}️]/gu, "").replace(/\s+/g, " ").trim();
    if (!clean) return resolve();
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.0;
    u.pitch = 1.0;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

export function hush() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** One listening turn. Calls onInterim while the person talks and onFinal once with the finished sentence. */
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
