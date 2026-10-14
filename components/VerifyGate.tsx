// The gate in front of every patient page (design §2.3, §5.3). A server component, so an unverified link
// never receives the page behind it — not its markup and not its JavaScript.
//
// It sits in the two layouts that cover the patient's side of the app (`/s/[token]` and its intake page,
// `/patient/[id]`), which is why there is one of these rather than a check in each page: a page added under
// either route is behind the code screen the moment it exists.

import { cookies } from "next/headers";
import Image from "next/image";
import type { ReactNode } from "react";
import VerifyScreen from "@/components/VerifyScreen";
import { channelsFor, CODE_TTL_MS, needsVerification, PATIENT_SESSION_COOKIE, verifiedSession } from "@/lib/patientSession";
import { visitByToken } from "@/lib/visit";

export default async function VerifyGate({ token, children }: { token: string; children: ReactNode }) {
  const visit = await visitByToken(token);
  if (!visit) {
    return <PatientNotice message="We couldn't find that link. Check the text or email from your doctor's office." />;
  }

  if (needsVerification(visit)) {
    const cookieStore = await cookies();
    const session = await verifiedSession(visit.id, cookieStore.get(PATIENT_SESSION_COOKIE)?.value);
    if (!session) {
      const channels = channelsFor(visit.patient);
      if (channels.length === 0) {
        // §2.2 has staff record a phone or an email with the visit. Without one there is nowhere to send a
        // code, so there is no way in from here and saying so beats a screen that cannot work.
        return (
          <PatientNotice message="This link has no phone number or email address on file, so we can't send you a code. Please call your doctor's office." />
        );
      }
      return (
        <VerifyScreen
          token={visit.token}
          channels={channels}
          practiceName={visit.patient.practice.name}
          minutes={Math.round(CODE_TTL_MS / 60_000)}
        />
      );
    }
  }

  return <>{children}</>;
}

/** The same card the summary page uses while it loads, for the two things that are nobody's fault. */
function PatientNotice({ message }: { message: string }) {
  return (
    <main className="ss-page sweetie-theme patient-page-state">
      <div className="ss-card patient-state-card">
        <Image src="/assets/sweetie/sweetie.png" alt="Sweetie" width={76} height={76} priority />
        <p>{message}</p>
      </div>
    </main>
  );
}
