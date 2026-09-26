// Provider sign up and patient list. Owner: (unassigned; cut to a hardcoded provider if behind).
// POST /api/provider { name, email, practice? } -> { id, name, email, practice }   (idempotent on email)
// GET  /api/provider?id=...                      -> provider with patients and their intake status

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; email?: string; practice?: string };
  if (!body.name || !body.email) return NextResponse.json({ error: "name and email are required" }, { status: 400 });
  const provider = await db.provider.upsert({
    where: { email: body.email.toLowerCase() },
    update: { name: body.name, practice: body.practice },
    create: { name: body.name, email: body.email.toLowerCase(), practice: body.practice },
  });
  return NextResponse.json(provider);
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const provider = await db.provider.findUnique({
    where: { id },
    include: {
      patients: {
        orderBy: { createdAt: "desc" },
        include: { uploads: { select: { kind: true } }, summaries: { select: { audience: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      },
    },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });
  return NextResponse.json({
    id: provider.id,
    name: provider.name,
    practice: provider.practice,
    patients: provider.patients.map((p) => ({
      id: p.id,
      name: p.name,
      apptAt: p.apptAt,
      token: p.token,
      uploads: Array.from(new Set(p.uploads.map((u) => u.kind))),
      hasSummary: p.summaries.length > 0,
    })),
  });
}
