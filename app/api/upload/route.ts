// POST /api/upload  multipart form: token, kind (dexcom|timeline|whoop|visits), file
// The gates in lib/uploads.ts run first (20 MB cap, type sniffing — design §9.1), then the parser, then the
// raw bytes go to the storage adapter (S3 in deployed environments, the filesystem here — §3.3) and the row
// keeps the key, the byte count and the parsed rows (§4.6). Returns { kind, count, status }.
// Owners: Dexcom -> Nisarga, location -> Robbert, WHOOP -> unassigned.

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { db } from "@/lib/db";
import { parseClarityCsv } from "@/lib/glucose";
import { parseTimeline, parseVisitsCsv } from "@/lib/location";
import { log, withRoute } from "@/lib/log";
import { parseWhoopCsv } from "@/lib/sleep";
import { deleteObjects, newUploadKey, putObject, storageBackend } from "@/lib/storage";
import type { UploadKind } from "@/lib/types";
import { checkSize, contentTypeFor, MAX_UPLOAD_BYTES, noRowsReason, sniffUpload, unreadableReason } from "@/lib/uploads";
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

  // Hand-labelled visits also contain location history and must not survive Timeline removal.
  const kinds = body.kind === "timeline" ? ["timeline", "visits"] : [body.kind];
  // Read the keys before the rows go, or the stored bytes outlive the only record of where they are.
  const doomed = await db.upload.findMany({ where: { visitId: visit.id, kind: { in: kinds } }, select: { s3Key: true } });
  await db.$transaction([
    db.upload.deleteMany({ where: { visitId: visit.id, kind: { in: kinds } } }),
    // Cached narratives may cite the removed data. Regenerate them from the remaining sources.
    db.summary.deleteMany({ where: { visitId: visit.id } }),
  ]);
  // Best effort, after the rows: a storage error must not leave the patient looking at data they deleted.
  // deleteObjects logs any key it could not remove; the retention sweep (§10.4) is the backstop.
  await deleteObjects(doomed.map((u) => u.s3Key).filter((k): k is string => !!k));
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
  if (visit.isSandbox) return NextResponse.json({ error: "This demo patient accepts only Dexcom sandbox imports. Use a separate patient for real uploads." }, { status: 403 });

  // §9.1 gate 1: the declared size, so an oversized export is refused without being read into memory.
  const tooBig = checkSize(file.size);
  if (tooBig && !tooBig.ok) {
    log.warn("upload_rejected", { patientId: visit.patientId, visitId: visit.id, kind, bytes: file.size, code: "size" });
    return NextResponse.json({ error: tooBig.reason }, { status: file.size > MAX_UPLOAD_BYTES ? 413 : 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // A multipart part can declare one size and send another, so the real length is checked too.
  const realSize = checkSize(bytes.byteLength);
  if (realSize && !realSize.ok) {
    log.warn("upload_rejected", { patientId: visit.patientId, visitId: visit.id, kind, bytes: bytes.byteLength, code: "size" });
    return NextResponse.json({ error: realSize.reason }, { status: bytes.byteLength > MAX_UPLOAD_BYTES ? 413 : 400 });
  }

  // §9.1 gate 2 and 3: a zip, a PDF or a CSV sent as a Timeline export is named for what it is, before parsing.
  const sniffed = sniffUpload(kind, bytes);
  if (!sniffed.ok) {
    log.warn("upload_rejected", { patientId: visit.patientId, visitId: visit.id, kind, bytes: bytes.byteLength, code: "type" });
    return NextResponse.json({ error: sniffed.reason }, { status: 415 });
  }

  const raw = new TextDecoder("utf-8").decode(bytes);
  let parsed: unknown[];
  try {
    parsed =
      kind === "dexcom" ? parseClarityCsv(raw)
      : kind === "timeline" ? parseTimeline(raw)
      : kind === "whoop" ? parseWhoopCsv(raw)
      : parseVisitsCsv(raw);
  } catch (e) {
    // Where the parser gave up goes in the log; what the patient gets is the step that fixes it (§9.1).
    log.warn("upload_unparsable", { patientId: visit.patientId, visitId: visit.id, kind, bytes: bytes.byteLength, error: e });
    return NextResponse.json({ error: unreadableReason(kind) }, { status: 422 });
  }
  if (parsed.length === 0) {
    // The filename is the patient's own words and stays out of the log; the byte count says as much.
    log.warn("upload_empty", { patientId: visit.patientId, visitId: visit.id, kind, bytes: bytes.byteLength });
    return NextResponse.json({ error: noRowsReason(kind) }, { status: 422 });
  }

  // §3.3: the bytes go to storage, never into the database. Stored before the row is written, so a key in
  // the database always points at something; a failure here leaves the patient able to try again.
  const s3Key = newUploadKey(visit.id, kind, sniffed.format);
  try {
    await putObject(s3Key, bytes, contentTypeFor(sniffed.format));
  } catch (e) {
    log.error("upload_store_failed", { patientId: visit.patientId, visitId: visit.id, kind, bytes: bytes.byteLength, provider: storageBackend(), error: e });
    return NextResponse.json({ error: "we could not save that file just now — please try again in a moment" }, { status: 503 });
  }

  const upload = await db.upload.create({
    data: {
      visitId: visit.id,
      kind,
      filename: file.name,
      s3Key,
      bytes: bytes.byteLength,
      parsedRows: parsed.length,
      data: { create: { parsed: JSON.stringify(parsed) } },
    },
  });
  log.info("upload_stored", { patientId: visit.patientId, visitId: visit.id, uploadId: upload.id, kind, rows: parsed.length, bytes: bytes.byteLength, provider: storageBackend() });
  const bundle = await loadBundle(visit.id);
  // Day span for glucose uploads, so Sweetie can say "about 7 days" when she thanks the patient.
  const days = kind === "dexcom" && parsed.length > 1
    ? Math.max(1, Math.round((Date.parse((parsed[parsed.length - 1] as { t: string }).t) - Date.parse((parsed[0] as { t: string }).t)) / 86400000))
    : undefined;
  return NextResponse.json({ kind, count: parsed.length, days, status: bundle?.status });
}

export const DELETE = withRoute("DELETE /api/upload", deleteHandler);
export const POST = withRoute("POST /api/upload", postHandler);
