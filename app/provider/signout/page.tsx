// Sign out (design §5.1). Auth.js sends its own signout link here (authConfig.pages.signOut); the button
// posts to the server action, which deletes the Session row and clears the cookie. A GET never ends a
// session, so a prefetch or an image tag cannot sign anyone out.

import Image from "next/image";
import Link from "next/link";
import PersonaBrand from "@/components/PersonaBrand";
import { currentProvider } from "@/lib/auth";
import { signOutProvider } from "../actions";

export default async function SignOutPage() {
  const provider = await currentProvider();

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
            <p className="onboard-art-eyebrow">SEE YOU SOON</p>
            <h1>
              Leaving the
              <br />
              <em>workspace.</em>
            </h1>
            <div className="onboard-character ss-float">
              <Image src="/assets/sour/sour.png" alt="" width={500} height={500} priority />
            </div>
          </aside>

          <div className="onboard-content">
            <div className="onboard-step ss-enter">
              <div>
                <p className="ss-eyebrow">SIGN OUT</p>
                {provider ? (
                  <>
                    <h2 className="ss-title">Sign out of Sweet Spot?</h2>
                    <p className="ss-lede">
                      You are signed in as <strong>{provider.email}</strong>. Signing out ends this session on
                      this device; the next sign-in is another emailed link.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="ss-title">You are signed out.</h2>
                    <p className="ss-lede">This session has ended. Ask for a new link whenever you need one.</p>
                  </>
                )}
              </div>
            </div>

            <div className="onboard-actions">
              {provider ? (
                <>
                  <Link href="/provider" className="ss-text-button">
                    ← Back to the dashboard
                  </Link>
                  <form action={signOutProvider}>
                    <button className="ss-button ss-button-primary" type="submit">
                      Sign out
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <span className="onboard-hint">No active session on this device.</span>
                  <Link href="/provider/signin" className="ss-button ss-button-primary">
                    Sign in again →
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
