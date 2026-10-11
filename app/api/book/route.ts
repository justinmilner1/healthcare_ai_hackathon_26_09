// POST /api/book  { name, phone?, email?, providerId?, optIn?, apptAt?, visitType?, reason? }
// Creates a patient with one visit (design §4.4) whose presigned token is the intake link, and, if opted in,
// sends that link by SMS and/or email.
// Returns { visitId, patientId, token, link, sms: {sent, error?}, email: {sent, error?} }. Owner: Justin.
// `visitId` is what every other route and page speaks in from here on (design §4.4).

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log, withRoute } from "@/lib/log";
import { sendIntakeInvite } from "@/lib/notify";
import { ensureDemoProvider } from "@/lib/practice";
import { intakeLink } from "@/lib/sms";
import { knownVisitType } from "@/lib/sweetie";
import { CARE_TEAM } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    phone?: string;
    email?: string;
    providerId?: string;
    optIn?: boolean;
    apptAt?: string;
    visitType?: string;
    reason?: string;
  };
  if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  // A hardcoded demo provider beats a broken login (AGENTS.md); sign-in is T05.
  const provider = body.providerId
    ? await db.user.findUnique({ where: { id: body.providerId } })
    : await ensureDemoProvider();
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  const token = randomBytes(16).toString("base64url");
  const visit = await db.visit.create({
    data: {
      providerUser: { connect: { id: provider.id } },
      optIn: Boolean(body.optIn),
      scheduledAt: body.apptAt ? new Date(body.apptAt) : null,
      visitType: body.visitType?.trim() || null,
      reason: body.reason?.trim() || null,
      token,
      patient: {
        create: {
          practiceId: provider.practiceId,
          name: body.name,
          phone: body.phone?.trim() || null,
          email: body.email?.trim().toLowerCase() || null,
        },
      },
    },
    include: { patient: true },
  });

  // visitType is free text on the way in, so only a type we recognise is logged; anything else is "other".
  log.info("patient_created", { patientId: visit.patientId, visitId: visit.id, providerId: provider.id, visitType: knownVisitType(visit.visitType) });

  if (!body.optIn) {
    return NextResponse.json({ visitId: visit.id, patientId: visit.patientId, token, link: intakeLink(token), sms: { sent: false, error: "not opted in" }, email: { sent: false, error: "not opted in" } });
  }
  const result = await sendIntakeInvite({
    visitId: visit.id,
    patientId: visit.patientId,
    name: visit.patient.name,
    phone: visit.patient.phone,
    email: visit.patient.email,
    token: visit.token,
    providerName: provider.name ?? CARE_TEAM,
    apptAt: visit.scheduledAt,
  });
  return NextResponse.json({ visitId: visit.id, patientId: visit.patientId, token, ...result });
}

export const POST = withRoute("POST /api/book", postHandler);
