// POST /api/book  { name, phone?, email?, providerId?, apptAt?, visitType?, reason?, channel?, consentMethod?, consentAt? }
// Creates (or reuses) the patient and adds one visit (design §2.2, §4.4) whose presigned token is the intake
// link, and, when there is consent to message them, queues a `notify.invite` job to send that link (§3.4).
// Returns { visitId, patientId, token, link, patientReused, queued, jobId? }. Owner: Justin.
// `visitId` is what every other route and page speaks in from here on (design §4.4).
//
// Booking is staff's job (§5.2, `visits:create`), so this needs a session: the patient and the visit land in
// the caller's practice and nowhere else. `providerId` names the clinician the visit is for and has to be a
// colleague — another practice's user id is a 404 (lib/guard.ts) — defaulting to the person booking it.
//
// Thin on purpose (AGENTS.md): every rule is lib/visitIntake.ts, every write is lib/visitStore.ts, and the two
// of them are also what the CSV import uses, so the day-at-a-time path cannot drift from this one. What used
// to be an `optIn` boolean on the payload is now derived from the channel and the recorded consent: §2.2 wants
// a consent with a who, a when and a how behind it, and a checkbox is none of those.

import { after, NextResponse } from "next/server";
import { requireCapability, requireMemberInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { intakeLink } from "@/lib/sms";
import { parseVisitDraft } from "@/lib/visitIntake";
import { createVisit } from "@/lib/visitStore";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { providerId?: string; apptAt?: unknown; scheduledAt?: unknown } & Record<string, unknown>;
  const me = await requireCapability("visits:create");

  // `apptAt` is what the wizard has always called it; `scheduledAt` is the column's own name and what the CSV
  // import speaks. Both are accepted so neither caller has to translate.
  const parsed = parseVisitDraft({ ...body, scheduledAt: body.scheduledAt ?? body.apptAt ?? null });
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors[0], errors: parsed.errors }, { status: 400 });

  // The patient's own credential is the token this hands back (§5.3); the practice is the caller's (§5.2).
  const provider = body.providerId && body.providerId !== me.id ? await requireMemberInPractice(body.providerId, me) : me;
  const created = await createVisit(me, provider.id, parsed.draft);

  const booked = { ...created, link: intakeLink(created.token) };
  if (parsed.draft.channel === "none") return NextResponse.json({ ...booked, queued: false, reason: "no consent to message this patient" });

  // The send is a job, so adding a patient returns as fast as the insert and a throttled SES call cannot cost
  // the clinic the patient row it just created (§3.4, §8).
  const { job } = await enqueue({ kind: "notify.invite", payload: { visitId: created.visitId }, idempotencyKey: `notify.invite:${created.visitId}` });
  nudge(after);
  return NextResponse.json({ ...booked, queued: true, jobId: job.id });
}

export const POST = withRoute("POST /api/book", postHandler);
