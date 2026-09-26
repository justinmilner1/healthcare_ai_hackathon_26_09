// POST /api/invite { patientId }  -> resend the presigned link by SMS and/or email. Owner: Justin.
// Used by the provider page's "Send link" button. Returns { link, sms, email }.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendIntakeInvite } from "@/lib/notify";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { patientId?: string };
  if (!body.patientId) return NextResponse.json({ error: "patientId is required" }, { status: 400 });
  const patient = await db.patient.findUnique({ where: { id: body.patientId }, include: { provider: true } });
  if (!patient) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  const result = await sendIntakeInvite({ ...patient, providerName: patient.provider.name });
  return NextResponse.json(result);
}
