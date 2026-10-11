// Sign in (design §5.1): an address, a link in the inbox, no password. The form posts to the server action in
// ../actions.ts; Auth.js is what redirects here with ?error= when something went wrong, because
// authConfig.pages points both signIn and error at this route.

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import PersonaBrand from "@/components/PersonaBrand";
import { currentProvider } from "@/lib/auth";
import { requestSignInLink } from "../actions";

/** Auth.js error codes, in the words of someone who just wanted to read a summary. */
const MESSAGES: Record<string, string> = {
  InvalidEmail: "That does not look like an email address. Check it and try again.",
  EmailSignInError: "We could not send the link just now. Try again in a moment.",
  Verification: "That link has already been used or has expired. Here is a fresh one.",
  AccessDenied: "That address cannot sign in to this workspace.",
  Configuration: "Sign-in is not configured on this server. Ask whoever runs it to set AUTH_SECRET.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; email?: string }> }) {
  if (await currentProvider()) redirect("/provider");
  const { error, email } = await searchParams;
  const message = error ? (MESSAGES[error] ?? MESSAGES.EmailSignInError) : null;

  return (
    <main className="ss-page sour-theme">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sour" context="Provider workspace" />
          <Link href="/" className="ss-text-button">
            Back home
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
              <Image src="/assets/sour/sour.png" alt="Sour, the provider's concise clinical assistant" width={500} height={500} priority />
            </div>
            <div className="onboard-quote">
              <span>✦</span>
              <p>I&apos;ll keep the numbers first and the noise out of the way.</p>
            </div>
          </aside>

          <form className="onboard-content" action={requestSignInLink}>
            {message && (
              <div className="ss-error" role="alert">
                {message}
              </div>
            )}

            <div className="onboard-step ss-enter">
              <div>
                <p className="ss-eyebrow">PROVIDER SIGN-IN</p>
                <h2 className="ss-title">Sign in with a link.</h2>
                <p className="ss-lede">
                  Type your work email and we&apos;ll send a one-time sign-in link. No password to remember, and
                  nothing clinical ever goes in the email.
                </p>
              </div>
              <div className="onboard-fields">
                <label className="ss-label" htmlFor="email">
                  <span>Work email</span>
                  <input
                    id="email"
                    name="email"
                    className="ss-input"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="maya@practice.com"
                    defaultValue={email ?? ""}
                  />
                </label>
              </div>
            </div>

            <div className="onboard-actions">
              <span className="onboard-hint">
                New here? <Link href="/provider/signup">Create a workspace</Link>
              </span>
              <button className="ss-button ss-button-primary" type="submit">
                Email me a link →
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
