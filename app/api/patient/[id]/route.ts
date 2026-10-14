// GET /api/patient/[id]  -> PatientBundle for one visit (design §4.4). `id` is a visit id or the presigned
// token from the invite, which is how /patient/<token> loads straight from the link (§5.3).
//
// Two kinds of caller, one bundle, and each has to prove something (§5.2, §5.3):
//
//   the patient    a verified patient session bound to this visit — the cookie POST /api/verify set
//   a clinician    a signed-in provider in the practice the visit belongs to
//
// The invite token on its own is neither. It names the visit and opens the code screen; a forwarded link
// gets a 401 from here and reveals nothing (§2.3).

import { NextResponse } from "next/server";
import { currentProvider } from "@/lib/auth";
import { loadBundle } from "@/lib/bundle";
import { log, withRoute } from "@/lib/log";
import { patientAllowed, VERIFICATION_REQUIRED } from "@/lib/patientSession";
import { findVisit } from "@/lib/visit";

async function getHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The visit first, because who may read it depends on which visit it is. A patient id matches nothing.
  const visit = await findVisit(id);
  if (!visit) return NextResponse.json({ error: "visit not found" }, { status: 404 });

  // The cookie is bound to the visit, not to the identifier in the URL, so a patient who has verified may
  // ask by either (§4.5).
  if (!(await patientAllowed(req, visit))) {
    const provider = await currentProvider();
    if (!provider) return NextResponse.json(VERIFICATION_REQUIRED, { status: 401 });
    if (provider.practiceId !== visit.patient.practiceId) {
      // One practice never sees another's data (§5.2). Not 404: the caller is signed in, so saying "not
      // yours" is honest and tells them nothing they could not already guess from having the id.
      log.warn("patient_bundle_cross_practice", { visitId: visit.id, userId: provider.id, practiceId: provider.practiceId });
      return NextResponse.json({ error: "that visit belongs to another practice" }, { status: 403 });
    }
  }

  const bundle = await loadBundle(visit.id);
  if (!bundle) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  return NextResponse.json(bundle);
}

export const GET = withRoute("GET /api/patient/[id]", getHandler);
