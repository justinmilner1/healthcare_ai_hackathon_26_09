// GET /demo -> the sign-in page with the seeded demo provider's address already filled in (design §5.1).
//
// It used to set a cookie and open the dashboard, which was the hackathon's "a hardcoded provider beats a
// broken login". There is a login now, so the shortcut is one click less rather than a way around it: the
// link still has to arrive and be clicked. Locally that means `npm run mail`.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withRoute } from "@/lib/log";
import { DEMO_PROVIDER_EMAIL } from "@/lib/practice";

async function getHandler(req: Request) {
  const provider = await db.user.findUnique({ where: { email: DEMO_PROVIDER_EMAIL } });
  const target = provider ? `/provider/signin?email=${encodeURIComponent(DEMO_PROVIDER_EMAIL)}` : "/provider/signup";
  return NextResponse.redirect(new URL(target, req.url));
}

export const GET = withRoute("GET /demo", getHandler);
