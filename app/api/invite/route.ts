// POST /api/invite { visitId }  -> resend that visit's presigned link by SMS and/or email. Owner: Justin.
// Used by the provider pages' "Send link" button. `visitId` may also be the visit's token (design §4.4).
// Returns { link, sms, email }.

import { NextResponse } from "next/server";
import { withRoute } from "@/lib/log";
import { sendIntakeInvite } from "@/lib/notify";
import { findVisit, providerName } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { visitId?: string };
  if (!body.visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  const visit = await findVisit(body.visitId);
  if (!visit) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  const result = await sendIntakeInvite({
    visitId: visit.id,
    patientId: visit.patientId,
    name: visit.patient.name,
    phone: visit.patient.phone,
    email: visit.patient.email,
    token: visit.token,
    providerName: providerName(visit),
    apptAt: visit.scheduledAt,
  });
  return NextResponse.json(result);
}

export const POST = withRoute("POST /api/invite", postHandler);
