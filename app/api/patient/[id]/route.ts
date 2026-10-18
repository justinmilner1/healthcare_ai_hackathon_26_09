// GET /api/patient/[id]  -> PatientBundle for one visit (design §4.4). `id` is a visit id or the presigned
// token from the invite, which is how /patient/<token> loads straight from the link (§5.3).
//
// Two audiences, two credentials, which is why the branch below exists:
//
//   a token    the patient's own way in (§2.7, §5.3) — and the token is only half of it. The other half is
//              the verified session the six-digit code leaves behind, so a forwarded link gets a 401 from
//              here and reveals nothing (§2.3, lib/guard.ts).
//   a visit id a provider's way in, and it is guessable in a way a token is not — so it needs a session, a
//              role that may read a summary, and the visit has to belong to the caller's practice (§5.2).
//
// Both orders of that check matter. The token is tried first, so the patient flow never touches the provider
// session; and a visit id from another practice answers exactly as a visit id that was never issued does,
// because a 403 here would confirm the visit exists (lib/guard.ts).
//
// The token branch answers with `patientView` of the bundle rather than the bundle: one object is built for
// both audiences, and the clinician's half of it — their summary with its safety flags, the summary job's
// state, the sign-off — is not a patient's to receive (§5.2, §10.6).
//
// This is the read §10.2 is about: the bundle is a visit's intake, its transcript as Sour reads it, its
// uploads and its summary in one response. A provider's read of it writes one audit row per part that was
// actually in the response (lib/auditStore.ts). The patient's own read of their own visit is not that: the
// row for them is the link verification, written where the token is accepted (lib/visit.ts).

import { NextResponse } from "next/server";
import { visitPartsRead } from "@/lib/auditLog";
import { recordVisitRead } from "@/lib/auditStore";
import { loadBundle, patientView } from "@/lib/bundle";
import { requireCapability, requireVerifiedPatient, requireVisitInPractice } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { visitByToken } from "@/lib/visit";

async function getHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const visit = await visitByToken(id);
  // A provider only when the id was not a token: `me` is also what says whether this read is one §10.2
  // records, since the patient reading their own visit is not a user reading a patient's.
  let me = null;
  if (visit) {
    await requireVerifiedPatient(req, visit);
  } else {
    me = await requireCapability("summaries:read");
    await requireVisitInPractice(id, me);
  }
  const bundle = await loadBundle(id);
  if (!bundle) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  // After the bundle, so the row records what was handed over, and not before in case it was nothing.
  if (me) await recordVisitRead({ practiceId: me.practiceId, visitId: bundle.visitId, actor: me, parts: visitPartsRead(bundle) });
  // The two audiences get the same visit, not the same object: a patient reading their own link gets their
  // own summary and none of the clinician's half of the bundle (§5.2, §10.6, lib/bundle.ts `patientView`).
  return NextResponse.json(me ? bundle : patientView(bundle));
}

export const GET = withRoute("GET /api/patient/[id]", getHandler);
