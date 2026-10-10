import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dexcomConfig } from "@/lib/dexcom";
import { withRoute } from "@/lib/log";

// Create an isolated demonstration record, never convert or overwrite the source patient.
async function postHandler(req: Request) {
  let config;
  try { config = dexcomConfig(); } catch {
    return NextResponse.json({ error: "Dexcom sandbox is not configured yet." }, { status: 503 });
  }
  if (req.headers.get("origin") !== config.origin) {
    return NextResponse.json({ error: "Open intake on the configured Dexcom callback host to try the sandbox." }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  if (typeof body?.token !== "string") return NextResponse.json({ error: "Patient link required." }, { status: 400 });
  const source = await db.patient.findUnique({ where: { token: body.token }, select: { id: true, providerId: true, isSandbox: true } });
  if (!source || source.isSandbox) return NextResponse.json({ error: "Open this demo from a regular patient's intake." }, { status: 400 });
  try {
    const demo = await db.patient.create({ data: {
      providerId: source.providerId,
      name: "Dexcom Sandbox Demo",
      token: randomBytes(24).toString("base64url"),
      isSandbox: true,
      optIn: false,
      reason: "Synthetic Dexcom demonstration — not a clinical visit",
    }, select: { token: true } });
    return NextResponse.json({ token: demo.token, link: `/s/${demo.token}/intake?demo=1` }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not start the demo. Please try again." }, { status: 500 });
  }
}

export const POST = withRoute("POST /api/dexcom/demo", postHandler);
