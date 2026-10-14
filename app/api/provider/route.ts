// The signed-in provider and their practice's work. Owner: Justin.
// POST /api/provider { name, email, practice? } -> { id, name, email, practice }   (public sign-up, §2.1)
// GET  /api/provider                             -> the signed-in provider, their role, and the practice's
//                                                   visits with intake progress and summary state
//
// A provider is a User in a Practice (design §4.1, §4.2) and the rows below are visits (§4.4): `id` is the
// visit, `patientId` the person it is for, and the pages send `id` back to /api/patient, /api/sour and
// /api/invite.
//
// GET takes no id: the session says who is asking (§5.1), and the list is scoped to their *practice* rather
// than to the one user, because §5.2 gives a clinician the practice's summaries and staff the practice's
// visits — a visit booked by the receptionist is the doctor's to read. `visits:read` is the floor for that,
// which every role holds; what a role may then do with a visit is checked by the route that does it.
//
// POST is the one provider route with no session, because it is how the first session comes to exist. It can
// only ever create: see signUpPractice in lib/practice.ts.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireCapability } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { signUpPractice } from "@/lib/practice";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "@/lib/sweetie";
import { deliveriesByVisit } from "@/lib/visitStore";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; email?: unknown; practice?: unknown };
  const user = await signUpPractice(body);
  return NextResponse.json({ id: user.id, name: user.name, email: user.email, practice: user.practice.name, role: user.role, createdAt: user.createdAt });
}

async function getHandler() {
  const session = await requireCapability("visits:read");
  const provider = await db.user.findUnique({ where: { id: session.id }, include: { practice: true } });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  const visits = await db.visit.findMany({
    where: { patient: { practiceId: provider.practiceId } },
    orderBy: { createdAt: "desc" },
    include: {
      patient: true,
      uploads: { select: { kind: true } },
      summaries: { select: { audience: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  // §8.3 What each channel did with this visit's invite, in one query for the whole list rather than a
  // relation on every row: the dashboard prints it beside the send button (lib/visitStore.ts).
  const deliveries = await deliveriesByVisit(visits.map((v) => v.id));
  return NextResponse.json({
    id: provider.id,
    name: provider.name,
    email: provider.email,
    // The role is what the dashboard hides its admin-only and clinical links behind. It is a convenience for
    // the screen, never the check: every route re-reads it from the session (lib/guard.ts).
    role: provider.role,
    practice: provider.practice.name,
    practiceId: provider.practiceId,
    visits: visits.map((v) => {
      const defs = fieldsFor(v.visitType, v.reason);
      const intake = parseIntake(v.intake, defs);
      const uploads = Array.from(new Set(v.uploads.map((u) => u.kind)));
      return {
        id: v.id,
        patientId: v.patientId,
        name: v.patient.name,
        apptAt: v.scheduledAt,
        visitType: v.visitType,
        reason: v.reason,
        // §4.4's own status, printed as it is stored. The screen used to infer a stage from upload counts
        // and answer counts, which could disagree with the column every other part of the app reads.
        status: v.status,
        channel: v.contactChannel,
        consentChannel: v.consentChannel,
        consentRecordedAt: v.consentRecordedAt,
        consentRecordedBy: v.consentRecordedBy,
        deliveries: deliveries[v.id] ?? [],
        token: v.token,
        phone: v.patient.phone,
        email: v.patient.email,
        // §10.5 Set the moment a deletion is asked for and cleared only by the row going. The dashboard
        // stops offering anything on a row whose patient is on the way out (app/provider/dashboard.tsx).
        patientDeletedAt: v.patient.deletedAt,
        createdAt: v.createdAt,
        uploads,
        answered: answeredCount(intake, defs),
        required: requiredCount(defs),
        flagged: intake.flagged,
        wrapped: intake.wrapped,
        hasSummary: v.summaries.length > 0,
        summaryAt: v.summaries[0]?.createdAt ?? null,
      };
    }),
  });
}

export const POST = withRoute("POST /api/provider", postHandler);
export const GET = withRoute("GET /api/provider", getHandler);
