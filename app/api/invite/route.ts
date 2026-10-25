// POST /api/invite { visitId }                    -> resend that visit's presigned link by SMS and/or email
// POST /api/invite { visitId, regenerate: true }  -> replace the link first, then send the new one (§5.5)
// Owner: Justin. `visitId` identifies the visit (design §4.4) and may also be that visit's invite token.
// Used by the provider pages' "Send link" and "New link" buttons. Queues a `notify.invite` job (§3.4) and
// returns 202 { link, jobId, queued, reason? }: the link is the useful part on screen, and staff never waits
// on SES. A second click while the first send is still in flight joins it; a resend later is a real resend
// (lib/jobs.ts). Per-channel delivery status is recorded on the visit and shown to staff in T19 (§8.3).
//
// `queued` is a claim about whether an invite is really going out, and not about the queue (T120, after T111
// made it one in POST /api/book). It used to mean only that a row had gone into `Job`, and two screens read
// it as "the message is going out" — the dashboard row's note and the Sour page's — in the deployment with no
// email and no SMS backend at all that `scripts/agent-check.sh` and a fresh `.env` are both in. `reason` is
// what staff read when the answer is that nothing can go out, and §8.1's fallback is the link, which is
// already here.
//
// T150 made that claim the whole question rather than a third of it. T120 answered it with
// `inviteSendability`, which asks the senders themselves and says in its own doc comment what it is not
// asking — "a suppressed address or a demo practice closes a channel on facts that live on the row". Those
// two facts are `visit.patient`'s and `visit.patient.practice`'s, both already loaded by the guard below, and
// on a deployment that *can* send they are the only things left that stop an invite: a demo practice pressing
// **Send link** for a patient whose number is a real one was answered `queued: true`, so the row said
// "Sending now" and only the delivery row, minutes later, said that §13.4 had refused it. `inviteReach`
// (lib/notify.ts) is the composition T145 built for POST /api/book — the rows before the environment, so the
// sentence staff read names what no amount of configuration will fix.
//
// The job is enqueued either way, deliberately, and for the reason POST /api/book gives: it is what writes
// this visit's delivery rows, `skipped` ones included (T110), so §8.3's MESSAGES cell still says what became
// of the channel instead of falling silent about it. What changes is only what staff are promised.
//
// Sending invites is staff's job (§5.2, `visits:invite`), and the visit has to be one of the caller's own
// practice's: another practice's visit id is a 404, not a 403, so the refusal says nothing about whether that
// visit exists (lib/guard.ts). Regenerating is the same job and the same capability — §5.5 gives it to staff —
// and it does what that section says: the old token stops working, and every patient session and pending code
// that stood on it is gone, so a browser still holding the cookie is out too.

import { randomBytes } from "node:crypto";
import { after, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { NO_CONSENT_TO_MESSAGE } from "@/lib/delivery";
import { requireCapability, requireVisitInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { inviteReach } from "@/lib/notify";
import { revokeSessions } from "@/lib/patientSession";
import { intakeLink } from "@/lib/sms";

async function postHandler(req: Request) {
  const me = await requireCapability("visits:invite");
  const body = (await req.json().catch(() => ({}))) as { visitId?: string; regenerate?: boolean };
  if (!body.visitId) return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  const visit = await requireVisitInPractice(body.visitId, me);

  let token = visit.token;
  if (body.regenerate) {
    token = randomBytes(16).toString("base64url");
    const revoked = await revokeSessions(visit.id);
    await db.visit.update({ where: { id: visit.id }, data: { token } });
    // The old link's holder is no longer verified, so the visit is back to waiting for someone to open the
    // new one. Only from `verified`: a visit already in intake keeps the state it earned (§4.4).
    await db.visit.updateMany({ where: { id: visit.id, status: "verified" }, data: { status: "invited" } });
    log.info("invite_regenerated", { visitId: visit.id, userId: me.id, count: revoked });
  }

  const { job, deduped } = await enqueue({ kind: "notify.invite", payload: { visitId: visit.id }, idempotencyKey: `notify.invite:${visit.id}` });
  nudge(after);

  const sent = { link: intakeLink(token), jobId: job.id, deduped, regenerated: Boolean(body.regenerate) };
  // Two different statements, kept apart the way POST /api/book keeps them: a practice that chose to message
  // nobody is not a deployment that cannot (§2.2 against §8.1). Only the second one is anybody's to fix.
  if (visit.contactChannel === "none") return NextResponse.json({ ...sent, queued: false, reason: NO_CONSENT_TO_MESSAGE }, { status: 202 });
  // §13.4 and §8.1 before the deployment (T150). `requireVisitInPractice` hands back the patient and their
  // practice (`WITH_CONTEXT`, lib/visit.ts), so every row `inviteReach` needs is in hand: no extra query, and
  // the destinations are the row's own, which is what §13.4 is a rule about. `visit.patient` is passed whole
  // as `suppression` — the three §8.1 columns are on it (lib/suppression.ts `SuppressionFacts`).
  const reach = inviteReach({
    channel: visit.contactChannel,
    phone: visit.patient.phone,
    email: visit.patient.email,
    suppression: visit.patient,
    demo: visit.patient.practice.isDemo,
  });
  if (!reach.channels.length) return NextResponse.json({ ...sent, queued: false, reason: reach.reason }, { status: 202 });
  return NextResponse.json({ ...sent, queued: true }, { status: 202 });
}

export const POST = withRoute("POST /api/invite", postHandler);
