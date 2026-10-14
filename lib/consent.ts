// The consent screen in front of the intake (design §2.4). Owner: sweetie.
//
// §2.4 is one screen, shown on first open only, that says four things — what Sweetie collects, that it is
// optional, that a clinician reviews it, how to have it deleted — and takes one tap to continue.
//
// Three things live here rather than in the component, so each is testable without a browser:
//
//   consentPoints()  the four statements, as data. A screen is the only place §2.4 can be satisfied, and a
//                    screen is the hardest thing to assert on, so the copy is a list with an id per required
//                    statement and lib/consent.test.ts checks that all four are there and say what they must.
//   needsConsent()   whether this visit still has to be asked. Pure, so the gate and the route agree.
//   recordConsent()  the one write. §2.4's "acceptance stored on the visit with time" is `intakeConsentAt`
//                    (§4.4); a decline is its own timestamp, and the route ends the session on top of it.
//
// Nothing here reads a cookie or imports next/*: the gate (components/VerifyGate.tsx) and the route
// (app/api/consent/route.ts) bring the visit and the decision, which keeps this loadable by `node --test`.

import type { PrismaClient } from "@prisma/client";
import { db } from "./db";

/** One statement on the screen. `id` is the §2.4 requirement it answers, and is what the tests check. */
export type ConsentPoint = { id: ConsentPointId; title: string; body: string };

/** The four things §2.4 requires the screen to say, in the order it lists them. */
export const CONSENT_POINT_IDS = ["collects", "optional", "reviewed", "delete"] as const;
export type ConsentPointId = (typeof CONSENT_POINT_IDS)[number];

/** Who the patient is being asked to share with. Both come off the visit (lib/visit.ts providerName). */
export type ConsentAudience = { clinicianName: string; practiceName: string | null };

/**
 * The screen's copy. Plain language, second person, no clinical terms — the same voice as Sweetie's own
 * questions, because this is the first thing the patient reads (§6.4 asks for the page to be understandable,
 * not only operable). The names are interpolated rather than hard-coded so the patient recognises the
 * practice that texted them.
 */
export function consentPoints({ clinicianName, practiceName }: ConsentAudience): ConsentPoint[] {
  const practice = practiceName?.trim() || "the practice";
  return [
    {
      id: "collects",
      title: "What Sweetie collects",
      body:
        "A few questions about how you have been, in your own words, before your visit. If you want to, you can also add a Dexcom, Google Timeline or WHOOP export so your clinician can see your week.",
    },
    {
      id: "optional",
      title: "All of it is optional",
      body:
        "You can skip any question, add no files at all, and stop whenever you like. Your appointment goes ahead either way, and nothing here changes your care.",
    },
    {
      id: "reviewed",
      title: "A clinician reviews it",
      body: `What you share is summarised for ${clinicianName} at ${practice} to read before your visit. Sweetie is not a clinician and cannot give you medical advice, and nobody outside the practice sees this.`,
    },
    {
      id: "delete",
      title: "You can have it deleted",
      body: `Ask ${practice} at any time and they delete your answers, your files and the summary made from them. You do not have to give a reason.`,
    },
  ];
}

/**
 * Whether this visit still has to be asked (§2.4 "first open only"). Accepting once is what clears it, so a
 * reload, a second device, and the summary page opened days later all go straight through.
 *
 * A sandbox visit is exempt for the same reason it skips the code screen (lib/patientSession.ts
 * needsVerification): it is the isolated Dexcom demonstration (§9.2), a synthetic patient with no real data
 * behind the link and nobody there to consent.
 */
export const needsConsent = (visit: { isSandbox: boolean; intakeConsentAt: Date | null }) =>
  !visit.isSandbox && !visit.intakeConsentAt;

/** Only the part of the client this module uses, so a test can pass one pointed at a fixture schema. */
export type ConsentClient = Pick<PrismaClient, "visit">;

/**
 * Record the answer. Accepting is forward-only — a visit already past the screen keeps its original time, so
 * the stored acceptance is when the patient actually agreed and not when they last opened the link.
 *
 * A decline keeps its own timestamp and leaves `intakeConsentAt` null, so the gate asks again if the patient
 * comes back; the session ending is the route's half of §2.4 ("declining ends the session politely").
 */
export async function recordConsent(
  visitId: string,
  accept: boolean,
  now: Date = new Date(),
  client: ConsentClient = db,
): Promise<void> {
  if (accept) {
    await client.visit.updateMany({ where: { id: visitId, intakeConsentAt: null }, data: { intakeConsentAt: now } });
    return;
  }
  await client.visit.update({ where: { id: visitId }, data: { intakeConsentDeclinedAt: now } });
}
