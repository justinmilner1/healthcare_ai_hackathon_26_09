// Provider sign up, patient list, and provider list. Owner: Justin.
// POST /api/provider { name, email, practice? } -> { id, name, email, practice }   (idempotent on email)
// GET  /api/provider?id=...                      -> provider with patients, intake progress and summary state
// GET  /api/provider?list=1                      -> all providers (no auth in the demo; used by the /provider picker)

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRoute } from "@/lib/log";
import { answeredCount, fieldsFor, parseIntake, requiredCount } from "@/lib/sweetie";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string; practice?: string };
  if (!body.name || !body.email) return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  const provider = await db.provider.upsert({
    where: { email: body.email.toLowerCase() },
    update: { name: body.name, practice: body.practice },
    create: { name: body.name, email: body.email.toLowerCase(), practice: body.practice },
  });
  return NextResponse.json(provider);
}

async function getHandler(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("list")) {
    const providers = await db.provider.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { patients: true } } } });
    return NextResponse.json(providers.map((p) => ({ id: p.id, name: p.name, practice: p.practice, patients: p._count.patients })));
  }
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const provider = await db.provider.findUnique({
    where: { id },
    include: {
      patients: {
        orderBy: { createdAt: "desc" },
        include: {
          uploads: { select: { kind: true } },
          summaries: { select: { audience: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  return NextResponse.json({
    id: provider.id,
    name: provider.name,
    practice: provider.practice,
    patients: provider.patients.map((p) => {
      const defs = fieldsFor(p.visitType, p.reason);
      const intake = parseIntake(p.intake, defs);
      const uploads = Array.from(new Set(p.uploads.map((u) => u.kind)));
      return {
        id: p.id,
        name: p.name,
        apptAt: p.apptAt,
        visitType: p.visitType,
        reason: p.reason,
        token: p.token,
        phone: p.phone,
        email: p.email,
        createdAt: p.createdAt,
        uploads,
        answered: answeredCount(intake, defs),
        required: requiredCount(defs),
        flagged: intake.flagged,
        wrapped: intake.wrapped,
        hasSummary: p.summaries.length > 0,
        summaryAt: p.summaries[0]?.createdAt ?? null,
      };
    }),
  });
}

export const POST = withRoute("POST /api/provider", postHandler);
export const GET = withRoute("GET /api/provider", getHandler);
