// Mark a visit's summary reviewed (design §2.6, §7.3). Owner: Justin (Sour).
// POST /api/review { visitId } -> { review: { at, by, byName }, already }
//
// §7.3's button, and nothing else: the rules and the write are lib/review.ts, this is transport. `visitId`
// identifies the visit (§4.4) and may also be that visit's invite token, like the rest of the provider
// routes — the page sends the id it was given.
//
// A sign-off is clinical, so it is admin or clinician and not staff (`summaries:review`, §5.2), and the
// visit is resolved through the practice: another practice's visit id reads as a visit that does not exist
// (lib/guard.ts). There is no DELETE: a recorded sign-off is a statement a clinician made, and the product
// has nowhere to put "it was unmade" — a summary the data has moved on from says so on its own (§7.1).
//
// Pressing it twice is not an error. The first press is the record; the second returns that record with
// `already: true`, so a reload, a slow network and two clinicians on one patient all read the same.

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/auditStore";
import { requireCapability, requireVisitInPractice } from "@/lib/guard";
import { log, withRoute } from "@/lib/log";
import { markReviewed, REFUSAL_MESSAGES } from "@/lib/review";

async function postHandler(req: Request) {
  const me = await requireCapability("summaries:review");
  const body = (await req.json().catch(() => null)) as { visitId?: unknown } | null;
  if (!body || typeof body.visitId !== "string" || !body.visitId) {
    return NextResponse.json({ error: "visitId is required" }, { status: 400 });
  }
  const visit = await requireVisitInPractice(body.visitId, me);
  const outcome = await markReviewed(visit, me);
  if (!outcome.ok) {
    // 409 and not 400: the request is well formed and the caller may read this visit — it is the visit's own
    // state that refuses, which is something the page can act on by reloading.
    log.info("summary_review_refused", { visitId: visit.id, userId: me.id, practiceId: me.practiceId, code: outcome.reason });
    return NextResponse.json({ error: REFUSAL_MESSAGES[outcome.reason], code: outcome.reason }, { status: 409 });
  }
  if (!outcome.already) {
    // §10.2's table is where "a clinician signed this off" is visible beside who read what (lib/auditLog.ts).
    // Only the press that recorded the sign-off writes a row; a second press recorded nothing.
    await recordAudit({
      practiceId: me.practiceId,
      actorType: "user",
      actorId: me.id,
      action: "summary.reviewed",
      entityType: "visit",
      entityId: visit.id,
      detail: { role: me.role },
    });
    log.info("summary_reviewed", { visitId: visit.id, userId: me.id, practiceId: me.practiceId });
  }
  return NextResponse.json({ review: outcome.record, already: outcome.already });
}

export const POST = withRoute("POST /api/review", postHandler);
