// "Check your email" (design §5.1). Auth.js redirects here after it has handed the link to lib/mailer.ts
// (authConfig.pages.verifyRequest). The address is deliberately not in the URL, so this page cannot say which
// inbox to look in — and does not need to.

import Image from "next/image";
import Link from "next/link";
import PersonaBrand from "@/components/PersonaBrand";
import { SIGN_IN_LINK_SECONDS } from "@/lib/auth";
import { devMailDir } from "@/lib/devMailbox";
import { emailProvider } from "@/lib/email";

export default function CheckEmailPage() {
  // No backend configured means the link went to the local mailbox instead of an inbox; say where.
  const local = !emailProvider();

  return (
    <main className="ss-page sour-theme">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Provider workspace" />
          <Link href="/provider/signin" className="ss-text-button">
            Use a different email
          </Link>
        </header>

        <section className="onboard-card ss-card">
          <aside className="onboard-art">
            <p className="onboard-art-eyebrow">ONE LINK AWAY</p>
            <h1>
              Check your
              <br />
              <em>inbox.</em>
            </h1>
            <div className="onboard-character ss-float">
              <Image src="/assets/sour/sour.png" alt="" width={500} height={500} priority />
            </div>
            <div className="onboard-quote">
              <span>✦</span>
              <p>I&apos;ll have the summaries open by the time you&apos;re back.</p>
            </div>
          </aside>

          <div className="onboard-content">
            <div className="onboard-step ss-enter">
              <div>
                <p className="ss-eyebrow">SIGN-IN LINK SENT</p>
                <h2 className="ss-title">We just emailed you a link.</h2>
                <p className="ss-lede">
                  Open it on this device to finish signing in. It works once and expires in{" "}
                  {Math.round(SIGN_IN_LINK_SECONDS / 60)} minutes. Nothing about a patient is in the email —
                  only the link.
                </p>
              </div>
              {local && (
                <div className="onboard-fields">
                  <p className="onboard-hint">
                    This server has no email provider configured, so the message went to the local mailbox at{" "}
                    <code>{devMailDir()}/</code>. Run <code>npm run mail</code> to read it.
                  </p>
                </div>
              )}
            </div>

            <div className="onboard-actions">
              <Link href="/provider/signin" className="ss-text-button">
                ← Send another link
              </Link>
              <Link href="/" className="ss-button ss-button-primary">
                Back home
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
