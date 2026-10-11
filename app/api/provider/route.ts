// The signed-in provider and their work. Owner: Justin.
// POST /api/provider { name, email, practice? } -> { id, name, email, practice }   (idempotent on email)
// GET  /api/provider                             -> the signed-in provider with their visits, intake progress
//                                                   and summary state; 401 when there is no session
//
// A provider is a User in a Practice (design §4.1, §4.2) and the rows below are visits (§4.4): `id` is the
// visit, `patientId` the person it is for, and the pages send `id` back to /api/patient, /api/sour and
// /api/invite.
//
// GET takes no id any more: the session says who is asking (§5.1), so one provider can no longer read another
// provider's list by changing a query string, and the `?list=1` that fed the old practice picker — every
// practice in the database, to anyone — is gone with the picker. Role checks per route are T06 (§5.2).

import { NextResponse } from "next/server";
import { currentProvider } from "@/lib/auth";
import { db } from "@/lib/db";
import { withRoute } from "@/lib/log";
import { upsertProvider } from "@/lib/practice";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "@/lib/sweetie";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string; practice?: string };
  if (!body.name || !body.email) return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  const user = await upsertProvider({ name: body.name, email: body.email, practice: body.practice });
  return NextResponse.json({ id: user.id, name: user.name, email: user.email, practice: user.practice.name, createdAt: user.createdAt });
}

async function getHandler() {
  const session = await currentProvider();
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  const provider = await db.user.findUnique({ where: { id: session.id }, include: { practice: true } });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  const visits = await db.visit.findMany({
    where: { providerUserId: provider.id },
    orderBy: { createdAt: "desc" },
    include: {
      patient: true,
      uploads: { select: { kind: true } },
      summaries: { select: { audience: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return NextResponse.json({
    id: provider.id,
    name: provider.name,
    practice: provider.practice.name,
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
        status: v.status,
        token: v.token,
        phone: v.patient.phone,
        email: v.patient.email,
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
