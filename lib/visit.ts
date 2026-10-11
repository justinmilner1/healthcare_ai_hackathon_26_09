// Resolving a visit (design §4.4). Everything a patient gives us during intake hangs off a Visit, and the
// invite token identifies the visit (§5.3). The provider pages and the public routes still speak in patient
// ids, so these helpers accept either and resolve to the one visit; T03 moves the routes onto visit ids.

import { db } from "./db";

/** The care team name shown to a patient when the provider row has no name yet (Auth.js, §5.1). */
export const CARE_TEAM = "your care team";

const WITH_CONTEXT = {
  patient: { include: { practice: true } },
  providerUser: true,
} as const;

/** The visit a visit id, an invite token, or a patient id points at. Newest visit wins. */
export async function findVisit(idOrToken: string) {
  if (!idOrToken) return null;
  return db.visit.findFirst({
    where: { OR: [{ id: idOrToken }, { token: idOrToken }, { patientId: idOrToken }] },
    orderBy: { createdAt: "desc" },
    include: WITH_CONTEXT,
  });
}

/** The visit an invite link opens. Nothing else matches, so a patient id in the URL is not a way in. */
export async function visitByToken(token: string | null | undefined) {
  if (!token) return null;
  return db.visit.findUnique({ where: { token }, include: WITH_CONTEXT });
}

export type VisitWithContext = NonNullable<Awaited<ReturnType<typeof findVisit>>>;

/** Who the patient thinks they are talking to. */
export const providerName = (visit: { providerUser: { name: string | null } | null }) =>
  visit.providerUser?.name ?? CARE_TEAM;
