"use client";

// The consent screen (design §2.4). The one screen between the code and Sweetie: what is collected, that it
// is optional, that a clinician reviews it, and how to have it deleted — then one tap to continue.
//
// Shown on first open only, which is decided on the server (components/VerifyGate.tsx, lib/consent.ts
// needsConsent) rather than in a cookie here, so a second device and a reload are the same screen as a
// second visit: none of them.
//
// The copy arrives as `points` rather than being written here: lib/consent.ts is where the four statements
// live, so a unit test can check that all four are present (lib/consent.test.ts) without a browser. It is
// also why they are not imported directly — lib/consent.ts reaches the database, and this file runs in the
// browser.
//
// Declining is a real choice and gets a real answer: the session ends (POST /api/consent revokes it) and
// this says so kindly, without arguing and without a second ask.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import type { ConsentPoint } from "@/lib/consent";
import { apiFetch } from "@/lib/csrf";

export default function ConsentScreen({
  token,
  clinicianName,
  practiceName,
  points,
}: {
  token: string;
  clinicianName: string;
  practiceName: string | null;
  points: ConsentPoint[];
}) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState("");

  async function answer(accept: boolean) {
    if (busy) return;
    setBusy(accept ? "accept" : "decline");
    setError("");
    try {
      const response = await apiFetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, accept }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "We could not save that just now. Please try again.");
        setBusy(null);
        return;
      }
      if (!accept) {
        setDeclined(true);
        setBusy(null);
        return;
      }
      // The gate is a server component, so the way through it is a real navigation: the layout re-reads the
      // visit and renders Sweetie behind it. Same reason as the code screen (components/VerifyScreen.tsx).
      window.location.reload();
    } catch {
      setError("We could not reach the office just now. Check your connection and try again.");
      setBusy(null);
    }
  }

  if (declined) return <Declined clinicianName={clinicianName} />;

  return (
    <main className="ss-page sweetie-theme patient-consent-page">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
        </header>

        <section className="ss-card patient-consent-card ss-enter">
          <Image src="/assets/sweetie/sweetie.png" alt="Sweetie" width={88} height={88} priority />

          <p className="ss-eyebrow">{practiceName ?? "Your care team"}</p>
          <h1 className="ss-title">Before we start.</h1>
          <p className="ss-lede">
            Here is what this check-in does with what you tell it. Have a read — it takes a minute — and then
            you decide.
          </p>

          <dl className="patient-consent-points">
            {points.map((point) => (
              <div key={point.id} className="patient-consent-point">
                <dt>{point.title}</dt>
                <dd>{point.body}</dd>
              </div>
            ))}
          </dl>

          <div className="patient-consent-actions">
            <button
              type="button"
              className="ss-button ss-button-primary"
              onClick={() => void answer(true)}
              disabled={busy !== null}
            >
              {busy === "accept" ? "One moment…" : "I agree — let's start"}
            </button>
            <button type="button" className="ss-text-button" onClick={() => void answer(false)} disabled={busy !== null}>
              {busy === "decline" ? "Saving…" : "No thanks, not this time"}
            </button>
          </div>

          {error ? (
            <p className="ss-error" role="alert">
              {error}
            </p>
          ) : null}

          <p className="patient-consent-help">
            Agreeing here is not a medical consent form, and it is not consent to treatment. It only covers
            what you choose to share with {practiceName ?? "your care team"} before this visit.
          </p>
        </section>
      </div>
    </main>
  );
}

/** §2.4: "declining ends the session politely". No arguing, no second ask, no dark pattern. */
function Declined({ clinicianName }: { clinicianName: string }) {
  const heading = useRef<HTMLHeadingElement>(null);

  // The card is replaced, not navigated to, so focus would otherwise stay on a button that is gone. Moving
  // it to the heading is what a screen reader needs to be told the screen changed (§6.4).
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="ss-page sweetie-theme patient-consent-page">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
        </header>

        <section className="ss-card patient-consent-card patient-consent-declined ss-enter" role="status">
          <Image src="/assets/sweetie/sweetie.png" alt="Sweetie" width={88} height={88} priority />

          <h1 className="ss-title" tabIndex={-1} ref={heading}>
            That is completely fine.
          </h1>
          <p className="ss-lede">
            Nothing has been collected, and you will not be asked anything else. Your appointment goes ahead
            as planned — you can tell {clinicianName} everything in person.
          </p>
          <p className="patient-consent-help">
            You can close this page. If you change your mind, open the link from your text or email again.
          </p>
        </section>
      </div>
    </main>
  );
}
