// POST /api/deletion { patientId, confirm } -> { patientId, queued: true }
//
// §2.8's "patient deletion request, made through the practice", and §10.5's "staff action deletes a patient's
// data end to end (S3 objects included) and records it". Owner: compliance.
//
// Transport only, like every other route here: the rules are lib/retention.ts, the deleting is
// lib/retentionStore.ts, and the work itself is the `patient.delete` job (§3.4) so it survives a failure half
// way through an object store. What this route does is check that the person asking may ask, that they are
// asking about their own practice's patient, and that they meant this patient and not the row above it.
//
// Three refusals, each saying something different:
//
//   401  nobody is signed in (lib/guard.ts)
//   403  a clinician: §10.5 is a staff action, and reading summaries is not a reason to be able to destroy
//        the record behind them (lib/access.ts "patients:delete")
//   404  no such patient, or one in another practice — the same answer either way, because a 403 here would
//        confirm that a stranger's clinic has a patient with that id (the reason lib/guard.ts gives)
//   400  the confirmation does not match the patient's name
//
// Not a DELETE on /api/patient/[id]: that route's id is a *visit* (§4.4), and the thing being deleted here is
// a person across all of their visits.

import { after, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireCapability } from "@/lib/guard";
import { nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { confirmsDeletion } from "@/lib/retention";
import { requestPatientDeletion } from "@/lib/retentionStore";

async function postHandler(req: Request) {
  const me = await requireCapability("patients:delete");
  const body = (await req.json().catch(() => ({}))) as { patientId?: unknown; confirm?: unknown };
  const patientId = typeof body.patientId === "string" ? body.patientId : "";

  const patient = patientId
    ? await db.patient.findUnique({ where: { id: patientId }, select: { id: true, practiceId: true, name: true, deletedAt: true } })
    : null;
  if (!patient || patient.practiceId !== me.practiceId) {
    log.warn("patient_not_in_practice", { userId: me.id, practiceId: me.practiceId, code: "patient_not_in_practice" });
    return NextResponse.json({ error: "patient not found" }, { status: 404 });
  }

  // §10.5 "with confirmation". The patient's own name, typed out: the mistake worth guarding against is
  // deleting the wrong row, and one more button cannot catch that (lib/retention.ts confirmsDeletion).
  if (!confirmsDeletion(body.confirm, patient.name)) {
    return NextResponse.json(
      { error: "Type the patient's name exactly as it appears on their row to confirm this deletion.", code: "deletion_not_confirmed" },
      { status: 400 },
    );
  }

  // Asking again for a patient already marked is not refused: the first job may have failed, and staff have
  // no other way to retry it. The idempotency key collapses a double press while one is still in flight.
  const { jobId, deduped } = await requestPatientDeletion({ patientId: patient.id, requestedBy: me.id });
  // Local development, the demo and the e2e suite have no scheduler, so the request that queues also drains
  // after the response (lib/jobs.ts). In AWS this does nothing and EventBridge picks the job up (§3.4).
  nudge(after);
  return NextResponse.json({ patientId: patient.id, queued: true, jobId, deduped, alreadyRequested: Boolean(patient.deletedAt) });
}

export const POST = withRoute("POST /api/deletion", postHandler);
