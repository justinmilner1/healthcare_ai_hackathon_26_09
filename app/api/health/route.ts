// GET /api/health -> { ok, db } . Used by Playwright's webServer wait and, later, by load balancers (design §11.2).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: "ok" });
  } catch (e) {
    return NextResponse.json({ ok: false, db: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
