// GET /demo -> redirects to the seeded demo provider's page (ids differ per machine, email does not).

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const provider = await db.provider.findUnique({ where: { email: "demo@sweetspot.local" } });
  const url = new URL(provider ? `/provider/${provider.id}` : "/provider/signup", req.url);
  return NextResponse.redirect(url);
}
