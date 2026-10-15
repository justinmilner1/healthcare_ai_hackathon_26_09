// Resolving a visit (design §4.4). Everything a patient gives us during intake hangs off a Visit, and the
// invite token identifies the visit (§5.3). Routes and pages speak in visit ids and tokens only: a patient id
// is not a way in, because a patient has many visits and only the visit knows which week is being discussed.

import { db } from "./db";
import { noteDemo } from "./demo";

/** The care team name shown to a patient when the provider row has no name yet (Auth.js, §5.1). */
export const CARE_TEAM = "your care team";

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
  if (visit) noteDemo(visit.patient.practice);
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

/** Who the patient thinks they are talking to. */
export const providerName = (visit: { providerUser: { name: string | null } | null }) =>
  visit.providerUser?.name ?? CARE_TEAM;
