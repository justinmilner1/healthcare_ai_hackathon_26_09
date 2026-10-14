import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { configured, SANDBOX_FILENAME } from "@/lib/dexcom";
import { requireVerifiedPatient } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import type { GlucoseReading } from "@/lib/types";
import { visitByToken } from "@/lib/visit";

async function getHandler(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const visit = await visitByToken(token);
  if (!visit) return NextResponse.json({ error: "Invalid patient link." }, { status: 404 });
  // §5.3 The same door as the rest of the patient flow: the link alone says nothing about the visit.
  await requireVerifiedPatient(req, visit);
  const latest = visit.isSandbox ? await db.upload.findFirst({ where: { visitId: visit.id, kind: "dexcom", filename: SANDBOX_FILENAME }, orderBy: { createdAt: "desc" }, include: { data: true } }) : null;
  const readings = latest?.data ? JSON.parse(latest.data.parsed) as GlucoseReading[] : [];
  return NextResponse.json({ sandboxPatient: visit.isSandbox, configured: configured(), connected: readings.length > 0, count: readings.length, start: readings[0]?.t ?? null, end: readings.at(-1)?.t ?? null }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withRoute("GET /api/dexcom/status", getHandler);
