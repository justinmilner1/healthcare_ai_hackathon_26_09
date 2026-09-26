import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dexcomConfig, DEXCOM_COOKIE, encryptTokens, exchangeCode, fetchSnapshot, hash, SANDBOX_FILENAME } from "@/lib/dexcom";

export async function GET(req: NextRequest) {
  let config;
  try { config = dexcomConfig(); } catch {
    return NextResponse.json({ error: "Dexcom sandbox is not configured." }, { status: 503 });
  }
  const state = req.nextUrl.searchParams.get("state");
  const browser = req.cookies.get(DEXCOM_COOKIE)?.value;
  const row = state && state.length <= 128 ? await db.dexcomOAuthState.findUnique({ where: { stateHash: hash(state) }, include: { patient: true } }) : null;
  if (!row || !browser || row.browserHash !== hash(browser)) {
    return NextResponse.json({ error: "Invalid Dexcom session. Return to your intake link and connect again." }, { status: 400, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  const back = (result: string) => {
    const url = new URL(`/s/${row.patient.token}/intake`, config.origin);
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
  if (!row.patient.isSandbox) return back("failed");
  if (req.nextUrl.searchParams.has("error")) return back("cancelled");
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return back("failed");

  try {
    const tokens = await exchangeCode(code);
    const encryptedTokens = encryptTokens(tokens);
    await db.dexcomConnection.upsert({
      where: { patientId: row.patientId },
      create: { patientId: row.patientId, encryptedTokens, expiresAt: new Date(Date.now() + tokens.expires_in * 1000) },
      update: { encryptedTokens, expiresAt: new Date(Date.now() + tokens.expires_in * 1000) },
    });
    const snapshot = await fetchSnapshot(tokens.access_token);
    await db.$transaction(async (tx) => {
      const patient = await tx.patient.findUnique({ where: { id: row.patientId } });
      if (!patient?.isSandbox) throw new Error("Not a sandbox patient.");
      await tx.upload.create({ data: { patientId: patient.id, kind: "dexcom", filename: SANDBOX_FILENAME, raw: snapshot.raw, parsed: JSON.stringify(snapshot.readings) } });
      // Never serve an older narrative against newly imported sandbox readings.
      await tx.summary.deleteMany({ where: { patientId: patient.id } });
      await tx.dexcomConnection.update({ where: { patientId: patient.id }, data: { importedAt: new Date() } });
    });
    return back("connected");
  } catch (e) {
    // Avoid logging the exception: upstream errors can contain authorization details.
    return back(e instanceof Error && e.message === "no_data" ? "no_data" : "failed");
  }
}
