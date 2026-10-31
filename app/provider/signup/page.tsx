"use client";

import Image from "next/image";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState } from "react";
import PersonaBrand from "@/components/PersonaBrand";
import Stepper from "@/components/Stepper";
import { apiFetch } from "@/lib/csrf";

// Creating the workspace and signing in are two steps: POST /api/provider makes the practice and the admin
// user (design §4.1, §4.2), then Auth.js emails a sign-in link to the same address (§5.1). Nobody is signed
// in by filling in a form; the link in the inbox is the proof the address is theirs.
export default function ProviderSignup() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name: "", email: "", practice: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (step === 0) {
      setStep(1);
      return;
    }

    setBusy(true);
    try {
      const res = await apiFetch("/api/provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const provider = await res.json();
      if (!res.ok) {
        throw new Error(provider.error ?? "Could not create the practice.");
      }
      // signIn redirects the browser to /provider/check-email (authConfig.pages.verifyRequest).
      await signIn("email", { email: form.email.trim().toLowerCase(), callbackUrl: "/provider" });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create the practice.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="ss-page sour-theme">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Provider workspace" />
          <Stepper label="Setup progress" labels={["You", "Practice"]} step={step} />
          <Link href="/provider" className="ss-text-button">
            Back to practices
          </Link>
        </header>

        <section className="onboard-card ss-card">
          <aside className="onboard-art">
            <p className="onboard-art-eyebrow">MEET SOUR</p>
            <h1>
              Clear data.
              <br />
              Better <em>visits.</em>
            </h1>
            <div className="onboard-character ss-float">
              <Image
                src="/assets/sour/sour.png"
                alt="Sour, the provider's concise clinical assistant"
                width={500}
                height={500}
                priority
              />
            </div>
            <div className="onboard-quote">
              <span>✦</span>
              <p>
                I&apos;ll keep the numbers first and the noise out of the way.
              </p>
            </div>
          </aside>

          <form className="onboard-content" onSubmit={submit}>
            {error && (
              <div className="ss-error" role="alert">
                {error}
              </div>
            )}

            {step === 0 ? (
              <div className="onboard-step ss-enter" key="identity">
                <div>
                  <p className="ss-eyebrow">YOUR PROVIDER PROFILE</p>
                  <h2 className="ss-title">First, tell Sour who you are.</h2>
                  <p className="ss-lede">
                    We&apos;ll email you a sign-in link when the workspace is
                    ready. No password to pick, no setup call.
                  </p>
                </div>
                <div className="onboard-fields">
                  <label className="ss-label">
                    <span>Your name</span>
                    <input
                      className="ss-input"
                      required
                      autoFocus
                      autoComplete="name"
                      placeholder="Dr. Maya Chen"
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </label>
                  <label className="ss-label">
                    <span>Work email</span>
                    <input
                      className="ss-input"
                      required
                      type="email"
                      autoComplete="email"
                      placeholder="maya@practice.com"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="onboard-step ss-enter" key="practice">
                <div>
                  <p className="ss-eyebrow">YOUR PRACTICE</p>
                  <h2 className="ss-title">Give the workspace a home.</h2>
                  <p className="ss-lede">
                    Patients will see this practice name in their invite and
                    pre-visit check-in.
                  </p>
                </div>
                <div className="onboard-fields">
                  <label className="ss-label">
                    <span>Practice name</span>
                    <input
                      className="ss-input"
                      autoFocus
                      autoComplete="organization"
                      placeholder="Northstar Endocrinology"
                      value={form.practice}
                      onChange={(e) =>
                        setForm({ ...form, practice: e.target.value })
                      }
                    />
                  </label>
                  <div className="onboard-review">
                    <div className="onboard-review-avatar">
                      {form.name.trim().charAt(0).toUpperCase() || "D"}
                    </div>
                    <div>
                      <strong>{form.name}</strong>
                      <span>
                        {form.practice || "Independent practice"} · {form.email}
                      </span>
                    </div>
                    <span className="ss-pill ss-pill-info">Ready</span>
                  </div>
                </div>
              </div>
            )}

            <div className="onboard-actions">
              {step > 0 ? (
                <button
                  type="button"
                  className="ss-text-button"
                  onClick={() => setStep(0)}
                >
                  ← Back
                </button>
              ) : (
                <span className="onboard-hint">Takes less than a minute</span>
              )}
              <button
                className="ss-button ss-button-primary"
                disabled={busy}
              >
                {busy
                  ? "Creating workspace…"
                  : step === 0
                    ? "Continue →"
                    : "Create workspace and email me a link →"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
