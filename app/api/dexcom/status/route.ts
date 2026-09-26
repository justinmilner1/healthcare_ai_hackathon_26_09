import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { configured, SANDBOX_FILENAME } from "@/lib/dexcom";
import type { GlucoseReading } from "@/lib/types";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const patient = token ? await db.patient.findUnique({ where: { token }, select: { id: true, isSandbox: true } }) : null;
  if (!patient) return NextResponse.json({ error: "Invalid patient link." }, { status: 404 });
  const latest = patient.isSandbox ? await db.upload.findFirst({ where: { patientId: patient.id, kind: "dexcom", filename: SANDBOX_FILENAME }, orderBy: { createdAt: "desc" } }) : null;
  const readings = latest ? JSON.parse(latest.parsed) as GlucoseReading[] : [];
  return NextResponse.json({ sandboxPatient: patient.isSandbox, configured: configured(), connected: readings.length > 0, count: readings.length, start: readings[0]?.t ?? null, end: readings.at(-1)?.t ?? null }, { headers: { "Cache-Control": "no-store" } });
}
