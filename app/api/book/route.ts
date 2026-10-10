// POST /api/book  { name, phone?, email?, providerId?, optIn?, apptAt?, visitType?, reason? }
// Creates a patient with a presigned intake token and, if opted in, sends the link by SMS and/or email.
// Returns { patientId, token, link, sms: {sent, error?}, email: {sent, error?} }. Owner: Justin.

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log, withRoute } from "@/lib/log";
import { sendIntakeInvite } from "@/lib/notify";
import { intakeLink } from "@/lib/sms";
import { knownVisitType } from "@/lib/sweetie";

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

  // A hardcoded demo provider beats a broken login (AGENTS.md).
  const provider = body.providerId
    ? await db.provider.findUnique({ where: { id: body.providerId } })
    : await db.provider.upsert({
        where: { email: "demo@sweetspot.local" },
        update: {},
        create: { name: "Dr. Demo Endo", email: "demo@sweetspot.local", practice: "Sweet Spot Endocrinology" },
      });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  const token = randomBytes(16).toString("base64url");
  const patient = await db.patient.create({
    data: {
      name: body.name,
      phone: body.phone?.trim() || null,
      email: body.email?.trim().toLowerCase() || null,
      providerId: provider.id,
      optIn: Boolean(body.optIn),
      apptAt: body.apptAt ? new Date(body.apptAt) : null,
      visitType: body.visitType?.trim() || null,
      reason: body.reason?.trim() || null,
      token,
    },
  });

  // visitType is free text on the way in, so only a type we recognise is logged; anything else is "other".
  log.info("patient_created", { patientId: patient.id, providerId: provider.id, visitType: knownVisitType(patient.visitType) });

  if (!body.optIn) {
    return NextResponse.json({ patientId: patient.id, token, link: intakeLink(token), sms: { sent: false, error: "not opted in" }, email: { sent: false, error: "not opted in" } });
  }
  const result = await sendIntakeInvite({ ...patient, providerName: provider.name });
  return NextResponse.json({ patientId: patient.id, token, ...result });
}

export const POST = withRoute("POST /api/book", postHandler);
