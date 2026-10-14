// POST /api/invite { visitId }                    -> resend that visit's presigned link by SMS and/or email
// POST /api/invite { visitId, regenerate: true }  -> replace the link first, then send the new one (§5.5)
// Owner: Justin. `visitId` identifies the visit (design §4.4) and may also be that visit's invite token.
// Used by the provider pages' "Send link" and "New link" buttons. Queues a `notify.invite` job (§3.4) and
// returns 202 { link, jobId, queued }: the link is the useful part on screen, and staff never waits on SES. A
// second click while the first send is still in flight joins it; a resend later is a real resend (lib/jobs.ts).
// Per-channel delivery status is recorded on the visit and shown to staff in T19 (§8.3).
//
// Regenerating is the destructive half, so it takes a signed-in provider from the practice that owns the
// visit, and it does what §5.5 says: the old token stops working, and every patient session and pending code
// that stood on it is gone, so a browser still holding the cookie is out too.

import { randomBytes } from "node:crypto";
import { after, NextResponse } from "next/server";
import { currentProvider } from "@/lib/auth";
import { db } from "@/lib/db";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { revokeSessions } from "@/lib/patientSession";
import { intakeLink } from "@/lib/sms";
import { findVisit } from "@/lib/visit";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { visitId?: string; regenerate?: boolean };
  if (!body.visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  const visit = await findVisit(body.visitId);
  if (!visit) return NextResponse.json({ error: "visit not found" }, { status: 404 });

  let token = visit.token;
  if (body.regenerate) {
    const provider = await currentProvider();
    if (!provider) return NextResponse.json({ error: "sign in first" }, { status: 401 });
    if (provider.practiceId !== visit.patient.practiceId) {
      log.warn("invite_regenerate_cross_practice", { visitId: visit.id, userId: provider.id, practiceId: provider.practiceId });
      return NextResponse.json({ error: "that visit belongs to another practice" }, { status: 403 });
    }
    token = randomBytes(16).toString("base64url");
    const revoked = await revokeSessions(visit.id);
    await db.visit.update({ where: { id: visit.id }, data: { token } });
    // The old link's holder is no longer verified, so the visit is back to waiting for someone to open the
    // new one. Only from `verified`: a visit already in intake keeps the state it earned (§4.4).
    await db.visit.updateMany({ where: { id: visit.id, status: "verified" }, data: { status: "invited" } });
    log.info("invite_regenerated", { visitId: visit.id, userId: provider.id, count: revoked });
  }

  const { job, deduped } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);
  return NextResponse.json({ link: intakeLink(token), jobId: job.id, queued: true, deduped, regenerated: Boolean(body.regenerate) }, { status: 202 });
}

export const POST = withRoute("POST /api/invite", postHandler);
