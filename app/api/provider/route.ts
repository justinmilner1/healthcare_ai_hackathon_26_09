// Provider sign up, visit list, and provider list. Owner: Justin.
// POST /api/provider { name, email, practice? } -> { id, name, email, practice }   (idempotent on email)
// GET  /api/provider?id=...                      -> provider with their visits, intake progress and summary state
// GET  /api/provider?list=1                      -> all providers (no auth in the demo; used by the /provider picker)
//
// A provider is a User in a Practice (design §4.1, §4.2) and the rows below are visits (§4.4). The response
// still speaks in patient ids because today a patient has exactly one visit; T03 moves the pages onto visits
// and T05/T06 replace this route with Auth.js sign-in and role checks.

import { NextResponse } from "next/server";
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

async function getHandler(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("list")) {
    const users = await db.user.findMany({ orderBy: { createdAt: "asc" }, include: { practice: true, _count: { select: { visits: true } } } });
    return NextResponse.json(users.map((u) => ({ id: u.id, name: u.name, practice: u.practice.name, patients: u._count.visits })));
  }
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const provider = await db.user.findUnique({ where: { id }, include: { practice: true } });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  const visits = await db.visit.findMany({
    where: { providerUserId: id },
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
    patients: visits.map((v) => {
      const defs = fieldsFor(v.visitType, v.reason);
      const intake = parseIntake(v.intake, defs);
      const uploads = Array.from(new Set(v.uploads.map((u) => u.kind)));
      return {
        id: v.patientId,
        name: v.patient.name,
        apptAt: v.scheduledAt,
        visitType: v.visitType,
        reason: v.reason,
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
