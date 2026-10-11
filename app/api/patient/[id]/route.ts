// GET /api/patient/[id]  -> PatientBundle for one visit (design §4.4). `id` is a visit id or the presigned
// token from the invite, which is how /patient/<token> loads straight from the link (§5.3).

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";
import { withRoute } from "@/lib/log";

async function getHandler(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bundle = await loadBundle(id);
  if (!bundle) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  return NextResponse.json(bundle);
}

export const GET = withRoute("GET /api/patient/[id]", getHandler);
