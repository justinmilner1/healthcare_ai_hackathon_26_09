// POST /api/upload  multipart form: token, kind (dexcom|timeline|whoop|visits), file
// Needs a verified patient session for that visit (design §5.3).
// Parses on the way in; the file hangs off the visit the token identifies (design §4.4, §4.6) and the parsed
// rows go in the UploadData row beside it. Returns { kind, count, status }.
// Owners: Dexcom -> Nisarga, location -> Robbert, WHOOP -> unassigned.

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { parseClarityCsv } from "@/lib/glucose";
import { parseTimeline, parseVisitsCsv } from "@/lib/location";
import { log, withRoute } from "@/lib/log";
import { parseWhoopCsv } from "@/lib/sleep";
import type { UploadKind } from "@/lib/types";
import { patientAllowed, VERIFICATION_REQUIRED } from "@/lib/patientSession";
import { visitByToken } from "@/lib/visit";

const KINDS: UploadKind[] = ["dexcom", "timeline", "whoop", "visits"];

// DELETE /api/upload { token, kind }: remove every version so older uploads cannot reappear.
async function deleteHandler(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.token !== "string" || !body.token || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "A token and valid upload kind are required." }, { status: 400 });
  }
  const visit = await visitByToken(body.token);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  if (!(await patientAllowed(req, visit))) return NextResponse.json(VERIFICATION_REQUIRED, { status: 401 });

  // Hand-labelled visits also contain location history and must not survive Timeline removal.
  const kinds = body.kind === "timeline" ? ["timeline", "visits"] : [body.kind];
  await db.$transaction([
    db.upload.deleteMany({ where: { visitId: visit.id, kind: { in: kinds } } }),
    // Cached narratives may cite the removed data. Regenerate them from the remaining sources.
    db.summary.deleteMany({ where: { visitId: visit.id } }),
  ]);
  const bundle = await loadBundle(visit.id);
  log.info("upload_deleted", { patientId: visit.patientId, visitId: visit.id, kind: body.kind });
  return NextResponse.json({ kind: body.kind, status: bundle?.status });
}

async function postHandler(req: Request) {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const kind = String(form.get("kind") ?? "") as UploadKind;
  const file = form.get("file");

  if (!KINDS.includes(kind)) return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  const visit = await visitByToken(token);
  if (!visit) return NextResponse.json({ error: "invalid token" }, { status: 404 });
  // §5.3 The token names the visit; the verified session is what opens it.
  if (!(await patientAllowed(req, visit))) return NextResponse.json(VERIFICATION_REQUIRED, { status: 401 });
  if (visit.isSandbox) return NextResponse.json({ error: "This demo patient accepts only Dexcom sandbox imports. Use a separate patient for real uploads." }, { status: 403 });

  const raw = await file.text();
  let parsed: unknown[];
  try {
    parsed =
      kind === "dexcom" ? parseClarityCsv(raw)
      : kind === "timeline" ? parseTimeline(raw)
      : kind === "whoop" ? parseWhoopCsv(raw)
      : parseVisitsCsv(raw);
  } catch (e) {
    log.warn("upload_unparsable", { patientId: visit.patientId, visitId: visit.id, kind, bytes: raw.length, error: e });
    return NextResponse.json({ error: `could not parse ${kind}: ${e instanceof Error ? e.message : e}` }, { status: 422 });
  }
  if (parsed.length === 0) {
    // The filename is the patient's own words and stays out of the log; the byte count says as much.
    log.warn("upload_empty", { patientId: visit.patientId, visitId: visit.id, kind, bytes: raw.length });
    return NextResponse.json({ error: `no usable rows found in ${file.name}` }, { status: 422 });
  }

  const upload = await db.upload.create({
    data: {
      visitId: visit.id,
      kind,
      filename: file.name,
      bytes: raw.length,
      parsedRows: parsed.length,
      // T11 moves the raw bytes to S3 and leaves the key here (§3.3).
      data: { create: { parsed: JSON.stringify(parsed), raw } },
    },
  });
  log.info("upload_stored", { patientId: visit.patientId, visitId: visit.id, uploadId: upload.id, kind, rows: parsed.length, bytes: raw.length });
  const bundle = await loadBundle(visit.id);
  // Day span for glucose uploads, so Sweetie can say "about 7 days" when she thanks the patient.
  const days = kind === "dexcom" && parsed.length > 1
    ? Math.max(1, Math.round((Date.parse((parsed[parsed.length - 1] as { t: string }).t) - Date.parse((parsed[0] as { t: string }).t)) / 86400000))
    : undefined;
  return NextResponse.json({ kind, count: parsed.length, days, status: bundle?.status });
}

export const DELETE = withRoute("DELETE /api/upload", deleteHandler);
export const POST = withRoute("POST /api/upload", postHandler);
