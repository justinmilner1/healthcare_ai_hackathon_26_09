// POST /api/book  { name, phone?, email?, providerId?, optIn?, apptAt?, visitType?, reason? }
// Creates a patient with one visit (design §4.4) whose presigned token is the intake link, and, if opted in,
// queues a `notify.invite` job to send that link by SMS and/or email (§3.4).
// Returns { patientId, token, link, queued, jobId? }. Owner: Justin.

import { randomBytes } from "crypto";
import { after, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { ensureDemoProvider } from "@/lib/practice";
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

  const booked = { patientId: visit.patientId, token, link: intakeLink(token) };
  if (!body.optIn) return NextResponse.json({ ...booked, queued: false, reason: "not opted in" });

  // The send is a job, so adding a patient returns as fast as the insert and a throttled SES call cannot cost
  // the clinic the patient row it just created (§3.4, §8).
  const { job } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);
  return NextResponse.json({ ...booked, queued: true, jobId: job.id });
}

export const POST = withRoute("POST /api/book", postHandler);
