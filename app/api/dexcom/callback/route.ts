import { after, NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dexcomConfig, DEXCOM_COOKIE, encryptTokens, exchangeCode, fetchSnapshot, hash, importFilename, visitMatchesEnv } from "@/lib/dexcom";
import { nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { queueSourAfterImport } from "@/lib/sourQueue";
import { newUploadKey, putObject } from "@/lib/storage";
import { contentTypeFor } from "@/lib/uploads";

async function getHandler(req: NextRequest) {
  let config;
  try { config = dexcomConfig(); } catch {
    return NextResponse.json({ error: "Dexcom is not configured." }, { status: 503 });
  }
  const state = req.nextUrl.searchParams.get("state");
  const browser = req.cookies.get(DEXCOM_COOKIE)?.value;
  // The OAuth state names the visit the patient started from (§4.4), so the import lands on that visit
  // rather than on a guess; the connection it creates is still per patient (§4.10).
  const row = state && state.length <= 128
    ? await db.dexcomOAuthState.findUnique({ where: { stateHash: hash(state) }, include: { visit: true } })
    : null;
  const visit = row?.visit;
  if (!row || !visit || !browser || row.browserHash !== hash(browser)) {
    return NextResponse.json({ error: "Invalid Dexcom session. Return to your intake link and connect again." }, { status: 400, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  const back = (result: string) => {
    const url = new URL(`/s/${visit.token}/intake`, config.origin);
    url.searchParams.set("dexcom", result);
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(DEXCOM_COOKIE, "", { path: "/api/dexcom", maxAge: 0, httpOnly: true, sameSite: "lax", secure: config.secure });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };
  // Atomic consumption rejects concurrent callbacks and replayed authorization codes.
  const consumed = await db.dexcomOAuthState.deleteMany({ where: { stateHash: row.stateHash } });
  if (!consumed.count || row.expiresAt.getTime() < Date.now()) return back("expired");
  // The same rule the connect route applied, re-checked here because the environment may have changed
  // between the two requests (§9.2).
  if (!visitMatchesEnv(visit, config.env)) return back("failed");
  if (req.nextUrl.searchParams.has("error")) return back("cancelled");
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return back("failed");

  try {
    const tokens = await exchangeCode(code);
    // §4.10, §10.1: KMS where a key is configured, and bound to this patient either way (lib/dexcom.ts).
    const encryptedTokens = await encryptTokens(tokens, visit.patientId);
    await db.dexcomConnection.upsert({
      where: { patientId: visit.patientId },
      create: { patientId: visit.patientId, encryptedTokens, expiresAt: new Date(Date.now() + tokens.expires_in * 1000) },
      update: { encryptedTokens, expiresAt: new Date(Date.now() + tokens.expires_in * 1000) },
    });
    const snapshot = await fetchSnapshot(tokens.access_token);
    // An import is an upload like any other (§4.6): the API response is the raw file, so it goes to storage
    // and the row keeps the key (§3.3). Dexcom answers in JSON, where a Clarity upload would be a CSV.
    const s3Key = newUploadKey(visit.id, "dexcom", "json");
    const rawBytes = new TextEncoder().encode(snapshot.raw);
    await putObject(s3Key, rawBytes, contentTypeFor("json"));
    const imported = await db.$transaction(async (tx) => {
      const fresh = await tx.visit.findUnique({ where: { id: visit.id } });
      if (!fresh || !visitMatchesEnv(fresh, config.env)) throw new Error("Visit no longer matches the Dexcom environment.");
      await tx.upload.create({ data: {
        visitId: fresh.id,
        kind: "dexcom",
        filename: importFilename(config.env),
        s3Key,
        bytes: rawBytes.byteLength,
        parsedRows: snapshot.readings.length,
        data: { create: { parsed: JSON.stringify(snapshot.readings) } },
      } });
      // Never serve an older narrative against newly imported readings.
      await tx.summary.deleteMany({ where: { visitId: fresh.id } });
      await tx.dexcomConnection.update({ where: { patientId: visit.patientId }, data: { importedAt: new Date() } });
      return fresh;
    });
    // §7.1's third trigger, after the transaction and not inside it: the job is a row in the same database,
    // and a run that was queued by a transaction that then rolled back would summarize readings nobody
    // imported. Deleting the summaries above keeps a stale narrative off the clinician's screen; this is
    // what puts a current one back there without anybody waiting for it (lib/sourQueue.ts).
    await queueSourAfterImport(imported);
    nudge(after);
    return back("connected");
  } catch (e) {
    // Avoid logging the exception: upstream errors can contain authorization details.
    return back(e instanceof Error && e.message === "no_data" ? "no_data" : "failed");
  }
}

export const GET = withRoute("GET /api/dexcom/callback", getHandler);
