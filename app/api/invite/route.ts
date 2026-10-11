// POST /api/invite { patientId }  -> resend the visit's presigned link by SMS and/or email. Owner: Justin.
// Used by the provider page's "Send link" button. Returns { link, sms, email }.

import { NextResponse } from "next/server";
import { withRoute } from "@/lib/log";
import { sendIntakeInvite } from "@/lib/notify";
import { findVisit, providerName } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { patientId?: string };
  if (!body.patientId) return NextResponse.json({ error: "patientId is required" }, { status: 400 });
  const visit = await findVisit(body.patientId);
  if (!visit) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  const result = await sendIntakeInvite({
    id: visit.patientId,
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
