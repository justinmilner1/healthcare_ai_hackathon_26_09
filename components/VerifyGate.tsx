// The gate in front of every patient page (design §2.3, §5.3). A server component, so an unverified link
// never receives the page behind it — not its markup and not its JavaScript.
//
// It sits in the two layouts that cover the patient's side of the app (`/s/[token]` and its intake page,
// `/patient/[id]`), which is why there is one of these rather than a check in each page: a page added under
// either route is behind the code screen the moment it exists.
//
// Behind the code and in front of everything else is the consent screen (§2.4, components/ConsentScreen.tsx).
// It is the same gate for the same reason: §2.4 is "first open only", and the first open is whichever patient
// page the link lands on. Accepting is what opens them all; until then there is nothing else to see.

import { cookies } from "next/headers";
import type { ReactNode } from "react";
import ConsentScreen from "@/components/ConsentScreen";
import PatientNotice from "@/components/PatientNotice";
import VerifyScreen from "@/components/VerifyScreen";
import { consentPoints, needsConsent } from "@/lib/consent";
import { codeReach } from "@/lib/notify";
import { channelsFor, CODE_TTL_MS, needsVerification, PATIENT_SESSION_COOKIE, verifiedSession } from "@/lib/patientSession";
import { providerName, visitByToken } from "@/lib/visit";

export default async function VerifyGate({ token, children }: { token: string; children: ReactNode }) {
  const visit = await visitByToken(token);
  if (!visit) {
    // Nothing is known here, and nothing is said: a made-up token and a link the practice has replaced get
    // the same screen, with no practice on it (§2.3, components/PatientNotice.tsx).
    return (
      <PatientNotice
        title="This link didn't work."
        message="We couldn't find that link. Check the text or email from your doctor's office, or call them and ask for a new one."
      />
    );
  }

  if (needsVerification(visit)) {
    const cookieStore = await cookies();
    const session = await verifiedSession(visit.id, cookieStore.get(PATIENT_SESSION_COOKIE)?.value);
    if (!session) {
      const onFile = channelsFor(visit.patient);
      if (onFile.length === 0) {
        // §2.2 has staff record a phone or an email with the visit. Without one there is nowhere to send a
        // code, so there is no way in from here and saying so beats a screen that cannot work. The practice
        // is named, twice: "call the office" is only actionable if the page says which office, and this is
        // the one patient screen whose next step happens on a telephone.
        return (
          <PatientNotice
            practiceName={visit.patient.practice.name}
            title="We can't send you a code."
            message={`This link has no phone number or email address on file, so there is nowhere to send your 6-digit code. Please call ${visit.patient.practice.name} and they can help.`}
          />
        );
      }
      // The rest of the same question (T113, T121): a contact detail on file is not a code that can be
      // sent. A deployment with no sender behind the channels this patient has is the same dead end arrived
      // at from one side, and an address a provider has reported dead or a number that texted STOP (§8.1),
      // or a demo practice whose patient has a real address (§13.4), is the same dead end arrived at from
      // the other. `codeReach` is all three filters at once (lib/notify.ts). It is settled here, in front of
      // the screen, rather than left to the screen's first POST — the code screen's whole job is to say a
      // code is on its way, so a visit that cannot be sent one must not get that far: it would read "We sent
      // a 6-digit code to your phone" over a resend button that mints another one into the same silence.
      const { channels } = codeReach({
        channels: onFile,
        phone: visit.patient.phone,
        email: visit.patient.email,
        // §8.1 is recorded on the patient, which is the row `visitByToken` already loads (lib/visit.ts).
        suppression: visit.patient,
        demo: visit.patient.practice.isDemo,
      });
      if (channels.length === 0) {
        // One screen for all three, and one sentence: §2.3 lets the patient know a code is not coming and
        // nothing else. Naming the channel would say which details the practice holds, and saying why — "your
        // email bounced" — tells whoever a link was forwarded to that this patient has an email on file.
        return (
          <PatientNotice
            practiceName={visit.patient.practice.name}
            title="We can't send you a code right now."
            message={`There is no way to send your 6-digit code just now, so this link cannot be opened. Please call ${visit.patient.practice.name} and they can help.`}
          />
        );
      }
      return (
        <VerifyScreen
          token={visit.token}
          // The sendable ones, not everything on file: the note on that screen names the channel the code
          // went to (§2.3), and naming one with no sender behind it is the claim this ticket is about.
          channels={channels}
          practiceName={visit.patient.practice.name}
          minutes={Math.round(CODE_TTL_MS / 60_000)}
        />
      );
    }
  }

  if (needsConsent(visit)) {
    const audience = { clinicianName: providerName(visit), practiceName: visit.patient.practice.name };
    // The copy comes from lib/consent.ts, which reaches the database, so it is read here and handed over as
    // data: the screen itself is a client component.
    return <ConsentScreen token={visit.token} {...audience} points={consentPoints(audience)} />;
  }

  return <>{children}</>;
}
