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
import { codeReach } from "@/lib/notify";
import { channelsFor } from "@/lib/patientSession";
import { signUpPractice } from "@/lib/practice";
import { FORMER_COLLEAGUE, reviewerNames } from "@/lib/review";
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
      // §13.4's flag rides on the practice, and `codeReach` below needs it to answer whether a demo
      // practice may write to this patient's own address at all (lib/demo.ts).
      patient: { include: { practice: { select: { isDemo: true } } } },
      uploads: { select: { kind: true } },
      summaries: { select: { audience: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  // §8.3 What each message to this visit did, in one query for the whole list rather than a relation on
  // every row: the dashboard prints it beside the send button (lib/visitStore.ts).
  const deliveries = await deliveriesByVisit(visits.map((v) => v.id));
  // §7.3 "shows in the dashboard": the status pill comes off the row, but who signed it off is a user id, so
  // the names are joined in one query for the whole list rather than one per row (lib/review.ts).
  const reviewers = await reviewerNames(visits.map((v) => v.reviewedBy));
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
      // §2.3, §5.3, T121 Can this patient be sent the six-digit code their link needs? Answered here rather
      // than on the screen because two thirds of it are the deployment's (`codeReach` asks the senders
      // themselves, lib/notify.ts) and the dashboard is a client component.
      //
      // T173 Two answers, because there are two causes and they want different remedies: a channel that
      // closed (`codeUnreachable`) and no channel to close (`noContactOnFile`). The second used to be
      // excluded from the first — "a patient with neither a phone nor an address cannot be telephoned about
      // it either, and §2.2's gap has its own fix" — and §2.2's fix is on the creation screen, which staff
      // are not on any more by the time they are looking at this row. So the row said nothing at all about a
      // link that cannot open, beside a live **Send link** button. Mutually exclusive by construction: one
      // needs `onFile` non-empty and the other needs it empty, so the screen says one line or the other.
      const onFile = channelsFor(v.patient);
      const reach = codeReach({
        channels: onFile,
        phone: v.patient.phone,
        email: v.patient.email,
        suppression: v.patient,
        demo: v.patient.practice.isDemo,
      });
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
        // §8.1 Why a channel is closed, so the dashboard can say it next to the delivery result rather than
        // leaving staff to wonder why an invite reads "skipped" (lib/suppression.ts).
        suppression: {
          emailUndeliverableAt: v.patient.emailUndeliverableAt,
          emailUndeliverableReason: v.patient.emailUndeliverableReason,
          smsOptOutAt: v.patient.smsOptOutAt,
        },
        token: v.token,
        phone: v.patient.phone,
        email: v.patient.email,
        /** §2.3 True when contact details are on file and none of them can carry a code, so the patient
         *  cannot open their link at all and the front desk has to telephone them (T121). */
        codeUnreachable: onFile.length > 0 && reach.channels.length === 0,
        /** §2.2, §2.3 True when there is no contact detail at all, which is the same consequence — the link
         *  will not open — reached the other way, and with the remedy the front desk can act on rather than a
         *  telephone call they cannot make (T173). Never true at the same time as `codeUnreachable`. */
        noContactOnFile: onFile.length === 0,
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
        // §7.3 The sign-off, in the shape the one-pager uses too (ReviewRecord, lib/types.ts): null until a
        // clinician has pressed Mark reviewed.
        review: v.reviewedAt ? { at: v.reviewedAt.toISOString(), by: v.reviewedBy, byName: (v.reviewedBy && reviewers[v.reviewedBy]) || FORMER_COLLEAGUE } : null,
      };
    }),
  });
}

export const POST = withRoute("POST /api/provider", postHandler);
export const GET = withRoute("GET /api/provider", getHandler);
