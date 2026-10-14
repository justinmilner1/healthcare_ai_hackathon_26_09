// POST /api/invite { visitId }  -> resend that visit's presigned link by SMS and/or email. Owner: Justin.
// `visitId` identifies the visit (design §4.4) and may also be that visit's invite token.
// Used by the provider pages' "Send link" button. Queues a `notify.invite` job (§3.4) and returns
// 202 { link, jobId, queued }: the link is the useful part on screen, and staff never waits on SES. A second
// click while the first send is still in flight joins it; a resend later is a real resend (lib/jobs.ts).
// Per-channel delivery status is recorded on the visit and shown to staff in T19 (§8.3).
//
// Sending invites is staff's job (§5.2, `visits:invite`), and the visit has to be one of the caller's own
// practice's: another practice's visit id is a 404, not a 403, so the refusal says nothing about whether that
// visit exists (lib/guard.ts).

import { after, NextResponse } from "next/server";
import { requireCapability, requireVisitInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { intakeLink } from "@/lib/sms";

async function postHandler(req: Request) {
  const me = await requireCapability("visits:invite");
  const body = (await req.json().catch(() => ({}))) as { visitId?: string };
  if (!body.visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  const visit = await requireVisitInPractice(body.visitId, me);
  const { job, deduped } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);
  return NextResponse.json({ link: intakeLink(visit.token), jobId: job.id, queued: true, deduped }, { status: 202 });
}

export const POST = withRoute("POST /api/invite", postHandler);
