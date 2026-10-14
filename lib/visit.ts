// Resolving a visit (design §4.4). Everything a patient gives us during intake hangs off a Visit, and the
// invite token identifies the visit (§5.3). Routes and pages speak in visit ids and tokens only: a patient id
// is not a way in, because a patient has many visits and only the visit knows which week is being discussed.

import { recordPatientVerified } from "./auditStore";
import { db } from "./db";

/** The care team name shown to a patient when the provider row has no name yet (Auth.js, §5.1). */
export const CARE_TEAM = "your care team";

const WITH_CONTEXT = {
  patient: { include: { practice: true } },
  providerUser: true,
} as const;

/** The visit a visit id or an invite token points at. Nothing else matches. */
export async function findVisit(idOrToken: string) {
  if (!idOrToken) return null;
  return db.visit.findFirst({
    where: { OR: [{ id: idOrToken }, { token: idOrToken }] },
    include: WITH_CONTEXT,
  });
}

/**
 * The visit an invite link opens. Only the token matches, so a guessed visit id is not a way in.
 *
 * A token that resolves here is §10.2's "patient-link verification": the token is the patient's credential
 * (§5.3), and accepting it is the moment worth recording. The row is written here rather than in each of the
 * six routes that take a token — intake, upload, the three Dexcom routes, the summary — so none of them can
 * be the one that forgets, and so T08's six-digit code has one place to add itself. Repeated calls inside a
 * quarter of an hour are one row (lib/auditStore.ts): a patient working through intake presents the same
 * link on every message, which is one session and not forty verifications.
 */
export async function visitByToken(token: string | null | undefined) {
  if (!token) return null;
  const visit = await db.visit.findUnique({ where: { token }, include: WITH_CONTEXT });
  if (visit) await recordPatientVerified(visit);
  return visit;
}

export type VisitWithContext = NonNullable<Awaited<ReturnType<typeof findVisit>>>;

/** Who the patient thinks they are talking to. */
export const providerName = (visit: { providerUser: { name: string | null } | null }) =>
  visit.providerUser?.name ?? CARE_TEAM;
