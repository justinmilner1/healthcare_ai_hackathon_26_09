import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dexcomConfig, DEXCOM_COOKIE, encryptTokens, exchangeCode, fetchSnapshot, hash, SANDBOX_FILENAME } from "@/lib/dexcom";
import { withRoute } from "@/lib/log";

async function getHandler(req: NextRequest) {
  let config;
  try { config = dexcomConfig(); } catch {
    return NextResponse.json({ error: "Dexcom sandbox is not configured." }, { status: 503 });
  }
  const state = req.nextUrl.searchParams.get("state");
  const browser = req.cookies.get(DEXCOM_COOKIE)?.value;
  // The OAuth state is per patient (§4.10); the import lands on that patient's newest visit (§4.4).
  const row = state && state.length <= 128
    ? await db.dexcomOAuthState.findUnique({
        where: { stateHash: hash(state) },
        include: { patient: { include: { visits: { orderBy: { createdAt: "desc" }, take: 1 } } } },
      })
    : null;
  const visit = row?.patient.visits[0];
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
  if (!visit.isSandbox) return back("failed");
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
      const fresh = await tx.visit.findUnique({ where: { id: visit.id } });
      if (!fresh?.isSandbox) throw new Error("Not a sandbox visit.");
      await tx.upload.create({ data: {
        visitId: fresh.id,
        kind: "dexcom",
        filename: SANDBOX_FILENAME,
        bytes: snapshot.raw.length,
        parsedRows: snapshot.readings.length,
        data: { create: { parsed: JSON.stringify(snapshot.readings), raw: snapshot.raw } },
      } });
      // Never serve an older narrative against newly imported sandbox readings.
      await tx.summary.deleteMany({ where: { visitId: fresh.id } });
      await tx.dexcomConnection.update({ where: { patientId: row.patientId }, data: { importedAt: new Date() } });
    });
    return back("connected");
  } catch (e) {
    // Avoid logging the exception: upstream errors can contain authorization details.
    return back(e instanceof Error && e.message === "no_data" ? "no_data" : "failed");
  }
}

export const GET = withRoute("GET /api/dexcom/callback", getHandler);
