import Image from "next/image";
import Link from "next/link";
import PersonaBrand from "@/components/PersonaBrand";

export default function Home() {
  return (
    <main className="ss-page sweetie-theme home-page">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand
            persona="sweetie"
            context="One clearer conversation"
          />
          <nav className="home-nav" aria-label="Main navigation">
            <Link href="/provider" className="ss-button ss-button-primary">
              Practice dashboard
              <span aria-hidden="true">→</span>
            </Link>
          </nav>
        </header>

        <section className="home-hero ss-card ss-enter">
          <div className="home-copy">
            <p className="ss-eyebrow">BEFORE THE VISIT · DURING THE VISIT</p>
            <h1 className="ss-display">
              A whole week of context.
              <br />
              One <em>better</em> conversation.
            </h1>
            <p className="ss-lede">
              Sweetie gathers the patient&apos;s glucose, sleep, places, and
              story. Sour turns it into the one-page brief their
              endocrinologist actually needs.
            </p>
            <div className="home-actions">
              <Link href="/provider" className="ss-button ss-button-primary">
                Open the practice dashboard
                <span aria-hidden="true">→</span>
              </Link>
              <Link href="/provider/signup" className="ss-text-button">
                Set up a practice
              </Link>
            </div>
            <div className="home-trust">
              <span>7 days of context</span>
              <i />
              <span>5-minute intake</span>
              <i />
              <span>1-page summary</span>
            </div>
          </div>

          {/* T209: `aria-label="Meet Sweetie and Sour"` came off this (§6.4). Prohibited on a role-less
              <div> and therefore dropped, so the name was never announced — and of the three ways out of
              that (a role that may be named, the words moved onto visible text, or the label removed) this
              is the one where removing it is right. The box is two glows and two <figure>s; everything a
              user needs is already inside it and already announced, twice over — each image's alt names
              its character and its job, and each <figcaption> names it again in text. A role="group" here
              would add a layer to walk through to be told what the layer already says. */}
          <div className="home-visual">
            <div className="home-glow home-glow-pink" />
            <div className="home-glow home-glow-yellow" />
            <figure className="home-character home-character-sweetie ss-float">
              <Image
                src="/assets/sweetie/sweetie.png"
                alt="Sweetie, the friendly patient intake assistant"
                width={440}
                height={440}
                priority
              />
              <figcaption>
                <strong>Sweetie</strong>
                <span>Patient intake</span>
              </figcaption>
            </figure>
            <figure className="home-character home-character-sour ss-float">
              <Image
                src="/assets/sour/sour.png"
                alt="Sour, the concise provider summary assistant"
                width={440}
                height={440}
                priority
              />
              <figcaption>
                <strong>Sour</strong>
                <span>Provider brief</span>
              </figcaption>
            </figure>
            <div className="home-handoff">
              <span>Patient story</span>
              <b>→</b>
              <span>Clinical signal</span>
            </div>
          </div>
        </section>

        <section className="home-journey" aria-labelledby="journey-title">
          <div className="home-section-heading">
            <div>
              <p className="ss-eyebrow">ONE CONNECTED CARE JOURNEY</p>
              <h2 className="ss-title" id="journey-title">
                Built for both sides of the room.
              </h2>
            </div>
            <p>
              Patients arrive remembered. Providers start with the signal,
              not the search.
            </p>
          </div>

          <div className="home-lanes">
            <article className="home-lane home-lane-sweetie">
              <div className="home-lane-number">01</div>
              <div className="home-lane-icon">
                <Image
                  src="/assets/sweetie/sweetie.png"
                  alt=""
                  width={62}
                  height={62}
                />
              </div>
              <p className="ss-eyebrow">FOR PATIENTS</p>
              <h3>Sweetie makes sharing feel human.</h3>
              <p>
                A warm, one-question-at-a-time conversation gathers uploads
                and the details people forget in the exam room.
              </p>
              <ul>
                <li>Dexcom, Timeline, and WHOOP</li>
                <li>Meals, symptoms, and visit goals</li>
                <li>A secure link—no account required</li>
              </ul>
            </article>

            <article className="home-lane home-lane-sour">
              <div className="home-lane-number">02</div>
              <div className="home-lane-icon">
                <Image
                  src="/assets/sour/sour.png"
                  alt=""
                  width={62}
                  height={62}
                />
              </div>
              <p className="ss-eyebrow">FOR CARE TEAMS</p>
              <h3>Sour gets straight to what matters.</h3>
              <p>
                A terse, data-first brief surfaces glucose patterns, context,
                and specific questions for the visit.
              </p>
              <ul>
                <li>Time in range and glucose trends</li>
                <li>Spikes linked to places and sleep</li>
                <li>Patient-specific questions to ask</li>
              </ul>
            </article>
          </div>
        </section>

        <footer className="home-footer">
          <span>Sweet Spot · Diabetes visit preparation</span>
          <span>Not medical advice</span>
        </footer>
      </div>
    </main>
  );
}
