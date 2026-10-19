// Resolving a visit (design §4.4). Everything a patient gives us during intake hangs off a Visit, and the
// invite token identifies the visit (§5.3). Routes and pages speak in visit ids and tokens only: a patient id
// is not a way in, because a patient has many visits and only the visit knows which week is being discussed.

import { db } from "./db";
import { markDemoPractice } from "./log";

/** The care team name shown to a patient when the provider row has no name yet (Auth.js, §5.1). */
export const CARE_TEAM = "your care team";

/**
 * And what the practice's own documents call the same visit: the words a clinician reads about their own
 * practice, never the patient's (§7.4, T86). `clinicianLine` below is what chooses between them.
 *
 * "recorded" rather than "assigned", because there usually *is* a row — §2.2 never asks the wizard for a
 * clinician, so `POST /api/book` puts the account that booked on the visit, which is the front desk. What is
 * missing is a name: the colleague an admin invited by email has none until they give one (§5.1,
 * lib/authAdapter.ts), and that is the state this line is for. Saying nobody is assigned would be a claim
 * about the row; saying nobody is recorded is a claim about the sheet, which is the true one.
 */
export const NO_CLINICIAN = "No clinician recorded";

const WITH_CONTEXT = {
  patient: { include: { practice: true } },
  providerUser: true,
} as const;

/** The visit a visit id or an invite token points at. Nothing else matches. */
export async function findVisit(idOrToken: string) {
  if (!idOrToken) return null;
  const visit = await db.visit.findFirst({
    where: { OR: [{ id: idOrToken }, { token: idOrToken }] },
    include: WITH_CONTEXT,
  });
  return noted(visit);
}

/**
 * §13.4's label, applied once at the gate every visit comes through. The practice is already on the row
 * (WITH_CONTEXT), so this costs nothing — and because it marks the *request* rather than the line
 * (lib/log.ts markDemo), it covers the `request_failed` and `job_failed` lines §11.1's alarms count, which
 * are written long after this call by code that has no practice in hand.
 */
function noted<T extends { patient: { practice: { isDemo: boolean } } } | null>(visit: T): T {
  if (visit) markDemoPractice(visit.patient.practice);
  return visit;
}

/** The visit an invite link opens. Only the token matches, so a guessed visit id is not a way in — and
 *  since T08 the token alone opens nothing but the code screen: §5.3's verification is the six-digit code,
 *  and that is where §10.2's audit row is written (app/api/verify/route.ts, lib/auditStore.ts). */
export async function visitByToken(token: string | null | undefined) {
  if (!token) return null;
  // A visit the retention sweep has cleared is not reachable by its link any more (§10.4): there is nothing
  // behind it, and letting the patient in would have them refill a row that is already marked swept — data
  // kept past the practice's window, by the very job whose point is that it is not. The provider path reads
  // visits by id (findVisit above) and still sees the emptied row.
  return noted(await db.visit.findFirst({ where: { token, retentionSweptAt: null }, include: WITH_CONTEXT }));
}

export type VisitWithContext = NonNullable<Awaited<ReturnType<typeof findVisit>>>;

/** Who the patient thinks they are talking to. Patient-facing only, because the fallback is: a provider's
 *  own document asks `clinicianLine` below instead (T86). */
export const providerName = (visit: { providerUser: { name: string | null } | null }) =>
  visit.providerUser?.name ?? CARE_TEAM;

/**
 * The clinician named on a document the practice reads — §7.4's printed one-pager.
 *
 * Not `providerName`: its fallback addresses the reader as the patient, and the reader of a sheet that goes
 * in a chart is the practice. Nor is that fallback rare. §2.2 never asks the wizard for a clinician, so the
 * visit carries whoever booked it — the front desk — and an invited colleague has no name on their row until
 * they give one (§5.1). So the ordinary sheet went out with the patient's words on it.
 *
 * `reviewedBy` is §7.3's sign-off, and it is an argument here so that two lines of the same sheet cannot
 * disagree about whether anyone at the practice is attached to this visit: a page whose banner reads
 * "Reviewed by Dr. Okafor" must not also say that nobody is. Whoever signed a summary off is a clinician of
 * this practice holding this visit, so they are whose sheet it is when nobody has been assigned.
 *
 * `||` rather than `??` at both steps: a provider row whose name is blank or whitespace is as unnamed as one
 * with no name at all, and printing it would leave the slot empty rather than say what it means.
 */
export const clinicianLine = (visit: { providerUser: { name: string | null } | null }, reviewedBy?: string | null) =>
  visit.providerUser?.name?.trim() || reviewedBy?.trim() || NO_CLINICIAN;
