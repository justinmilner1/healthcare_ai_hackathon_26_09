// The consent screen's one answer (design §2.4). Owner: sweetie.
//
// POST /api/consent { token, accept: true }   -> 200 { accepted: true }   one tap to continue
// POST /api/consent { token, accept: false }  -> 200 { accepted: false }  declined; the session ends here
//
// Behind the code screen, not in front of it: the token says which visit (§4.4) and a verified session
// (§5.3) is what makes this the patient's own answer, so requireVerifiedPatient runs before anything is
// written. A forwarded link can no more consent on someone's behalf than it can read their week.
//
// Declining "ends the session politely" (§2.4). Politely is the screen's job; ending it is this route's:
// every patient session for the visit is revoked and the cookie is cleared, so the pages behind the gate
// close immediately and so do the API routes that check the same session. The visit itself is left alone —
// the appointment still stands, and staff see an unanswered intake.
//
// Either answer is a row in the audit trail (§10.2's "every patient-side decision"), written through
// lib/auditStore.ts like the verification before it, so it speaks the vocabulary the admin page filters on
// and its detail goes through §4.8's gate (T51).

import { NextResponse } from "next/server";
import { recordPatientConsent } from "@/lib/auditStore";
import { needsConsent, recordConsent } from "@/lib/consent";
import { requireVerifiedPatient } from "@/lib/guard";
import { log, withRoute } from "@/lib/log";
import { PATIENT_SESSION_COOKIE, revokeSessions } from "@/lib/patientSession";
import { visitByToken } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; accept?: unknown };
  const visit = await visitByToken(body.token ?? null);
  // The same answer as POST /api/verify for a token that was never ours or has been regenerated (§5.5):
  // nothing here confirms that a visit exists.
  if (!visit) return NextResponse.json({ error: "That link is not valid. Check the text or email from your doctor's office." }, { status: 404 });
  await requireVerifiedPatient(req, visit);

  if (typeof body.accept !== "boolean") {
    return NextResponse.json({ error: "Say whether you agree: accept must be true or false." }, { status: 400 });
  }

  if (body.accept) {
    // Already past the screen: say so and keep the original time rather than writing a second consent.
    const first = needsConsent(visit);
    await recordConsent(visit.id, true);
    if (first) await recordPatientConsent(visit, true);
    log.info("patient_consent_accepted", { visitId: visit.id });
    return NextResponse.json({ accepted: true });
  }

  await recordConsent(visit.id, false);
  // After the revoke rather than before it, so the row can say how many sessions the decline closed: that is
  // the half of §2.4 this route performs, and `rows` is the field the gate allows it under (§4.8).
  const revoked = await revokeSessions(visit.id);
  await recordPatientConsent(visit, false, { rows: revoked });
  log.info("patient_consent_declined", { visitId: visit.id, count: revoked });

  const res = NextResponse.json({ accepted: false });
  // Belt and braces: the rows are gone, so the cookie already proves nothing, but a browser holding a dead
  // cookie would be sent through the code screen with it still attached. Clearing it is one less thing.
  res.cookies.set(PATIENT_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}

export const POST = withRoute("POST /api/consent", postHandler);
