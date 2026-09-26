// GET /api/patient/[id]  -> PatientBundle (everything the provider and patient summary pages need)

import { NextResponse } from "next/server";
import { loadBundle } from "@/lib/bundle";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bundle = await loadBundle(id);
  if (!bundle) return NextResponse.json({ error: "patient not found" }, { status: 404 });
  return NextResponse.json(bundle);
}
