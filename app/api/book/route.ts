// POST /api/book  { name, phone?, email?, providerId?, optIn?, apptAt?, visitType?, reason? }
// Creates a patient with one visit (design §4.4) whose presigned token is the intake link, and, if opted in,
// queues a `notify.invite` job to send that link by SMS and/or email (§3.4).
// Returns { visitId, patientId, token, link, queued, jobId? }. Owner: Justin.
// `visitId` is what every other route and page speaks in from here on (design §4.4).
//
// Booking is staff's job (§5.2, `visits:create`), so this needs a session: the patient and the visit land in
// the caller's practice and nowhere else. It used to fall back to the seeded demo provider when no session and
// no providerId were given, which meant anyone on the internet could create patients in the demo practice.
// `providerId` names the clinician the visit is for and now has to be a colleague — another practice's user id
// is a 404 (lib/guard.ts) — defaulting to the person booking it.

import { randomBytes } from "crypto";
import { after, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireCapability, requireMemberInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
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
  const me = await requireCapability("visits:create");
  if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  // The patient's own credential is the token this hands back (§5.3); the practice is the caller's (§5.2).
  const provider = body.providerId && body.providerId !== me.id ? await requireMemberInPractice(body.providerId, me) : me;

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
          practiceId: me.practiceId,
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

  const booked = { visitId: visit.id, patientId: visit.patientId, token, link: intakeLink(token) };
  if (!body.optIn) return NextResponse.json({ ...booked, queued: false, reason: "not opted in" });

  // The send is a job, so adding a patient returns as fast as the insert and a throttled SES call cannot cost
  // the clinic the patient row it just created (§3.4, §8).
  const { job } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);
  return NextResponse.json({ ...booked, queued: true, jobId: job.id });
}

export const POST = withRoute("POST /api/book", postHandler);
