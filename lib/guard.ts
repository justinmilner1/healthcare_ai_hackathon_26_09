// The checks every provider route starts with (design §5.2). Owner: identity.
//
// §5.2: "Every API route checks practice membership and role; a user never sees another practice's data."
// Three guards, in the order a route needs them, each throwing an HttpError that `withRoute` turns into the
// response and the log line (lib/httpError.ts):
//
//   requireProvider()                  401  nobody is signed in
//   requireCapability(capability)      403  signed in, wrong role for this route (lib/access.ts)
//   requireVisitInPractice(id, me)     404  no such visit, or it belongs to another practice
//
// The last one is a 404 on purpose and not a 403. A 403 would confirm that the visit exists, which is itself
// another practice's data: told apart, the two answers turn a visit id into an oracle for "is this patient
// seen at that clinic". The patient's own way in is unchanged and not here — the invite token is the
// credential for that (§5.3, lib/visit.ts), and it is a visit id that has to be earned.

import { can, roleLabel, type Capability } from "./access";
import { currentProvider, type ProviderUser } from "./auth";
import { db } from "./db";
import { HttpError } from "./httpError";
import { findVisit, type VisitWithContext } from "./visit";

/** The signed-in provider, or 401. The session is the only thing a route trusts about who is calling. */
export async function requireProvider(): Promise<ProviderUser> {
  const provider = await currentProvider();
  if (!provider) throw new HttpError(401, "Sign in first.", "request_unauthenticated");
  return provider;
}

/** The signed-in provider, if their role holds `capability`. Otherwise 403, naming the role so the person
 *  reading it knows to ask an admin rather than to try again. */
export async function requireCapability(capability: Capability): Promise<ProviderUser> {
  const provider = await requireProvider();
  if (!can(provider.role, capability)) {
    throw new HttpError(403, `A ${roleLabel(provider.role).toLowerCase()} account cannot do this. Ask an admin in your practice.`, "request_forbidden", {
      userId: provider.id,
      practiceId: provider.practiceId,
      role: provider.role,
      capability,
    });
  }
  return provider;
}

/** The visit, if it is one of this practice's. A visit id from another practice, a patient id, and a visit
 *  that never existed are the same 404 with the same body. */
export async function requireVisitInPractice(idOrToken: string | undefined | null, provider: ProviderUser): Promise<VisitWithContext> {
  const visit = idOrToken ? await findVisit(idOrToken) : null;
  if (!visit || visit.patient.practiceId !== provider.practiceId) {
    throw new HttpError(404, "visit not found", "visit_not_in_practice", {
      userId: provider.id,
      practiceId: provider.practiceId,
      visitId: visit?.id,
    });
  }
  return visit;
}

/** A colleague, by id, in the caller's practice — or 404, for the same reason as above. Used where one
 *  provider names another: the clinician a visit is booked for, the user whose role is being changed. */
export async function requireMemberInPractice(userId: string | undefined | null, provider: ProviderUser) {
  const member = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
  if (!member || member.practiceId !== provider.practiceId) {
    throw new HttpError(404, "user not found", "user_not_in_practice", { userId: provider.id, practiceId: provider.practiceId });
  }
  return member;
}
