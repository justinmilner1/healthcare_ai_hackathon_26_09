"use client";

// The code screen (design §2.3, §5.3). What a patient link shows until a code from the phone or email on
// file comes back. Everything about this screen is deliberately uninformative: the practice name, which the
// invite already carried, and the channel the code went to — never the patient's name, never the number or
// the address. A forwarded link gets this and nothing else.
//
// The code is asked for on mount, because "opening the link sends a code" is the flow in §2.3. A reload does
// not mint a new one: POST /api/verify reuses a code that is still live, so the digits in the patient's hand
// keep working. "Send a new code" is the explicit resend.

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import { apiFetch } from "@/lib/csrf";

type Channel = "sms" | "email";

const where = (channels: readonly Channel[]) => {
  const words = channels.map((c) => (c === "sms" ? "your phone" : "your email"));
  if (words.length === 0) return "your contact details";
  return words.length === 1 ? words[0] : `${words[0]} and ${words[1]}`;
};

export default function VerifyScreen({
  token,
  channels,
  practiceName,
  minutes,
}: {
  token: string;
  channels: Channel[];
  practiceName: string;
  minutes: number;
}) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("Sending your code…");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const asked = useRef(false);
  const field = useRef<HTMLInputElement>(null);

  const ask = useCallback(
    async (resend: boolean) => {
      setSending(true);
      setError("");
      try {
        const response = await apiFetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, ...(resend ? { resend: true } : {}) }),
        });
        const data = await response.json();
        if (!response.ok) {
          setNote("");
          setError(data.error ?? "We could not send a code just now. Please try again.");
          return;
        }
        setNote(
          data.reused
            ? `We already sent a code to ${where(channels)}. Check there, or send a new one.`
            : `We sent a 6-digit code to ${where(channels)}. It expires in ${minutes} minutes.`,
        );
        field.current?.focus();
      } catch {
        setNote("");
        setError("We could not reach the office just now. Check your connection and try again.");
      } finally {
        setSending(false);
      }
    },
    [channels, minutes, token],
  );

  useEffect(() => {
    // Once per mount. React runs effects twice in development, and a second POST there would be harmless
    // (the live code is reused) but would also say "we already sent one" on a first visit.
    if (asked.current) return;
    asked.current = true;
    void ask(false);
  }, [ask]);

  async function submit() {
    const typed = code.trim();
    if (typed.length !== 6 || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: typed }),
      });
      const data = await response.json();
      if (!response.ok) {
        setCode("");
        // The code is gone in every case but a wrong guess, so the note about it being on its way goes too:
        // leaving it there would contradict the line right above it.
        if (data.reason !== "wrong") setNote("");
        setError(
          data.reason === "wrong" && typeof data.remaining === "number" && data.remaining > 0
            ? `${data.error} ${data.remaining} ${data.remaining === 1 ? "try" : "tries"} left.`
            : (data.error ?? "That code did not work."),
        );
        field.current?.focus();
        return;
      }
      // The gate is a server component, so the way back in is a real navigation: the layout re-reads the
      // cookie and renders the page behind it.
      window.location.reload();
    } catch {
      setError("We could not check that code just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="ss-page sweetie-theme patient-verify-page">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
        </header>

        <section className="ss-card patient-verify-card ss-enter">
          <Image src="/assets/sweetie/sweetie.png" alt="Sweetie" width={96} height={96} priority />

          <p className="ss-eyebrow">{practiceName}</p>
          <h1 className="ss-title">Let&apos;s check it&apos;s you.</h1>
          <p className="ss-lede">
            Before anything else, type the code we just sent you. It keeps your check-in private even if this
            link is shared.
          </p>

          <form
            className="patient-verify-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="ss-label" htmlFor="verify-code">
              <span>6-digit code</span>
              <input
                id="verify-code"
                ref={field}
                className="ss-input patient-verify-input"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                // A six-box code field is prettier and worse: one input is what a password manager, a
                // screen reader and a paste all understand (§6.4).
                maxLength={6}
                placeholder="123456"
                autoFocus
                aria-describedby="verify-note"
                required
              />
            </label>

            <button className="ss-button ss-button-primary" type="submit" disabled={busy || code.trim().length !== 6}>
              {busy ? "Checking…" : "Continue →"}
            </button>
          </form>

          {error ? (
            <p className="ss-error" role="alert">
              {error}
            </p>
          ) : null}
          <p id="verify-note" className="patient-verify-note" role="status">
            {note}
          </p>

          <button type="button" className="ss-text-button" onClick={() => void ask(true)} disabled={sending || busy}>
            {sending ? "Sending…" : "Send a new code"}
          </button>
          <p className="patient-verify-help">
            Nobody from the office will ever call to ask you for this code. If you did not expect this,
            you can close the page.
          </p>
        </section>
      </div>
    </main>
  );
}
