// POST /api/book  { name, phone?, email?, providerId?, optIn?, apptAt? }
// Creates a patient with a presigned intake token. Sends the SMS if opted in and Twilio is configured.
// Returns { patientId, token, link, sms: { sent, error? } }. Owner: Justin.

import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { intakeLink, sendSms } from "@/lib/sms";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    phone?: string;
    email?: string;
    providerId?: string;
    optIn?: boolean;
    apptAt?: string;
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
      phone: body.phone,
      email: body.email,
      providerId: provider.id,
      optIn: Boolean(body.optIn),
      apptAt: body.apptAt ? new Date(body.apptAt) : null,
      token,
    },
  });

  const link = intakeLink(token);
  const sms =
    body.optIn && body.phone
      ? await sendSms(body.phone, `${provider.name}'s office: get ready for your visit in 5 minutes with Sweetie: ${link}`)
      : { sent: false, error: "not opted in or no phone" };

  return NextResponse.json({ patientId: patient.id, token, link, sms });
}
