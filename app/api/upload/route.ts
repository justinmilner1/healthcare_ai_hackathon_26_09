// POST /api/upload  multipart form: token, kind (dexcom|timeline|whoop|visits), file
// Parses on the way in and stores both raw and parsed. Returns { kind, count, status }.
// Owners: Dexcom -> Nisarga, location -> Robbert, WHOOP -> unassigned.

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { parseClarityCsv } from "@/lib/glucose";
import { parseTimeline, parseVisitsCsv } from "@/lib/location";
import { parseWhoopCsv } from "@/lib/sleep";
import type { UploadKind } from "@/lib/types";

const KINDS: UploadKind[] = ["dexcom", "timeline", "whoop", "visits"];

export async function POST(req: Request) {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const kind = String(form.get("kind") ?? "") as UploadKind;
  const file = form.get("file");

  if (!KINDS.includes(kind)) return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  const patient = await db.patient.findUnique({ where: { token } });
  if (!patient) return NextResponse.json({ error: "invalid token" }, { status: 404 });

  const raw = await file.text();
  let parsed: unknown[];
  try {
    parsed =
      kind === "dexcom" ? parseClarityCsv(raw)
      : kind === "timeline" ? parseTimeline(raw)
      : kind === "whoop" ? parseWhoopCsv(raw)
      : parseVisitsCsv(raw);
  } catch (e) {
    return NextResponse.json({ error: `could not parse ${kind}: ${e instanceof Error ? e.message : e}` }, { status: 422 });
  }
  if (parsed.length === 0) return NextResponse.json({ error: `no usable rows found in ${file.name}` }, { status: 422 });

  await db.upload.create({
    data: { patientId: patient.id, kind, filename: file.name, raw, parsed: JSON.stringify(parsed) },
  });
  const bundle = await loadBundle(patient.id);
  // Day span for glucose uploads, so Sweetie can say "about 7 days" when she thanks the patient.
  const days = kind === "dexcom" && parsed.length > 1
    ? Math.max(1, Math.round((Date.parse((parsed[parsed.length - 1] as { t: string }).t) - Date.parse((parsed[0] as { t: string }).t)) / 86400000))
    : undefined;
  return NextResponse.json({ kind, count: parsed.length, days, status: bundle?.status });
}
