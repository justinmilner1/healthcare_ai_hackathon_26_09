// POST /api/invite { patientId }  -> resend the visit's presigned link by SMS and/or email. Owner: Justin.
// Used by the provider page's "Send link" button. Queues a `notify.invite` job (design §3.4) and returns
// 202 { link, jobId, queued }: the link is the useful part on screen, and staff never waits on SES. A second
// click while the first send is still in flight joins it; a resend later is a real resend (lib/jobs.ts).
// Per-channel delivery status is recorded on the visit and shown to staff in T19 (§8.3).

import { after, NextResponse } from "next/server";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { intakeLink } from "@/lib/sms";
import { findVisit } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { patientId?: string };
  if (!body.patientId) return NextResponse.json({ error: "patientId is required" }, { status: 400 });
  const visit = await findVisit(body.patientId);
  if (!visit) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  const { job, deduped } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);
  return NextResponse.json({ link: intakeLink(visit.token), jobId: job.id, queued: true, deduped }, { status: 202 });
}

export const POST = withRoute("POST /api/invite", postHandler);
