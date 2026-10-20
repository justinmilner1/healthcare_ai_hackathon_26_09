// The two dead ends in front of a patient link (design §2.3, §6.4; T98).
//
// Both of them used to render the card the summary page uses while it loads: the Sweetie avatar and one
// sentence in the 11px muted caption style, with no wordmark, no heading, and — on the screen that tells the
// patient to phone the practice — no practice name on the page. A loading placeholder is the wrong thing for
// a state the patient cannot get out of from inside the app, and the no-contact state is the one screen in
// the whole flow that asks them to go and do something offline.
//
// So each is a patient screen in the register of the code screen next door (components/VerifyScreen.tsx):
// the Sweet Spot wordmark, the practice where there is one, a heading saying what has happened, and the
// instruction in `.ss-lede` — the body size the rest of the patient flow reads at.
//
// `practiceName` is optional rather than looked up here, which is §2.3's "a forwarded link alone reveals
// nothing" in one prop: the not-found state has no visit, so it has no practice to name, and naming nothing
// is also what keeps it from telling a real token from a made-up one. Where a link does resolve, the code
// screen already carries the practice, so saying it here is no new disclosure.

import Image from "next/image";
import PersonaBrand from "@/components/PersonaBrand";

export default function PatientNotice({
  title,
  message,
  practiceName,
}: {
  title: string;
  message: string;
  practiceName?: string;
}) {
  return (
    <main className="ss-page sweetie-theme patient-notice-page">
      <div className="ss-container">
        <header className="ss-topbar">
          <PersonaBrand persona="sweetie" context="Your pre-visit companion" />
        </header>

        <section className="ss-card patient-notice-card ss-enter">
          <Image src="/assets/sweetie/sweetie.png" alt="Sweetie" width={96} height={96} priority />

          {practiceName ? <p className="ss-eyebrow">{practiceName}</p> : null}
          <h1 className="ss-title">{title}</h1>
          <p className="ss-lede">{message}</p>
        </section>
      </div>
    </main>
  );
}
