// GET /demo -> remembers the seeded demo provider (ids differ per machine, email does not) and opens the dashboard.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRoute } from "@/lib/log";

async function getHandler(req: Request) {
  const provider = await db.provider.findUnique({ where: { email: "demo@sweetspot.local" } });
  const res = NextResponse.redirect(new URL(provider ? "/provider" : "/provider/signup", req.url));
  if (provider) res.cookies.set("ss_provider", provider.id, { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax" });
  return res;
}

export const GET = withRoute("GET /demo", getHandler);
