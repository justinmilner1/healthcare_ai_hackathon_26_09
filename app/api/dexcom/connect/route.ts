import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizationUrl, dexcomConfig, DEXCOM_COOKIE, hash } from "@/lib/dexcom";
import { withRoute } from "@/lib/log";
import { visitByToken } from "@/lib/visit";

async function postHandler(req: Request) {
  let config;
  try { config = dexcomConfig(); } catch {
    return NextResponse.json({ error: "Dexcom sandbox is not configured." }, { status: 503 });
  }
  // Require a form submitted from the exact configured app origin, not another site.
  if (req.headers.get("origin") !== config.origin) {
    return NextResponse.json({ error: "Open intake on the configured Dexcom callback host before connecting." }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  const token = form?.get("token");
  if (typeof token !== "string") return NextResponse.json({ error: "Patient token required." }, { status: 400 });
  const visit = await visitByToken(token);
  if (!visit) return NextResponse.json({ error: "Invalid patient link." }, { status: 404 });
  if (!visit.isSandbox) return NextResponse.json({ error: "Use a dedicated sandbox patient; real patient data cannot be replaced." }, { status: 403 });

  const state = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  // Keyed by the visit the patient pressed Connect on (§4.4), so the callback knows where the import goes.
  await db.dexcomOAuthState.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { visitId: visit.id }] } });
  await db.dexcomOAuthState.create({ data: { stateHash: hash(state), browserHash: hash(browser), visitId: visit.id, expiresAt: new Date(Date.now() + 10 * 60000) } });
  const response = NextResponse.redirect(authorizationUrl(state), 303);
  response.cookies.set(DEXCOM_COOKIE, browser, { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/api/dexcom", maxAge: 600 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const POST = withRoute("POST /api/dexcom/connect", postHandler);
