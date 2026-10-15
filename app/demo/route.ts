// GET /demo -> into the seeded demo practice (design §13.4, §5.1).
//
// Two behaviours, and which one you get is a deployment's decision:
//
//   DEMO_SIGN_IN is off (the default, and every production deployment)
//       the sign-in page with the demo provider's address already filled in. One click less than typing it;
//       the link still has to arrive and be clicked, which locally means `npm run mail`.
//
//   DEMO_SIGN_IN is on (staging, and a local demo)
//       signed in. §13.4 wants `/demo` to open the demo practice on staging, and on staging there is no
//       inbox to read the link out of: SES is configured, the demo provider's address is `@sweetspot.local`,
//       and a demo practice may not message anything else (lib/demo.ts). So the link is minted rather than
//       emailed (lib/auth.ts mintSignInUrl) and this route redirects to it — Auth.js does the signing in.
//
// Three things have to hold before it does, and all three are checked here rather than trusted: the flag is
// on, the seeded provider exists, and the practice they are admin of is marked `isDemo`. The last one is the
// one that matters if the flag is ever set by mistake on a real deployment — the only door it opens is into
// a practice whose every row is synthetic, and a practice does not become a demo one by accident (the flag
// is set by `npm run seed`, lib/practice.ts).

import { NextResponse } from "next/server";
import { mintSignInUrl } from "@/lib/auth";
import { db } from "@/lib/db";
import { demoSignInEnabled } from "@/lib/config";
import { log, markDemoPractice, withRoute } from "@/lib/log";
import { DEMO_PROVIDER_EMAIL } from "@/lib/practice";

async function getHandler(req: Request) {
  const provider = await db.user.findUnique({ where: { email: DEMO_PROVIDER_EMAIL }, include: { practice: true } });
  // Nothing seeded here yet: §2.1's sign-up is the honest answer, not an error page.
  if (!provider) return NextResponse.redirect(new URL("/provider/signup", req.url));
  markDemoPractice(provider.practice);

  const prefilled = new URL(`/provider/signin?email=${encodeURIComponent(DEMO_PROVIDER_EMAIL)}`, req.url);
  if (!demoSignInEnabled()) return NextResponse.redirect(prefilled);
  if (!provider.practice.isDemo) {
    // The address is seeded but its practice is not marked synthetic — somebody renamed or reused the row.
    // Refusing to shortcut into it is the point of checking: a session is not handed out for a practice that
    // may hold real patients. The ordinary sign-in page is still right there.
    log.warn("demo_signin_refused", { practiceId: provider.practiceId, userId: provider.id, ok: false });
    return NextResponse.redirect(prefilled);
  }

  const url = await mintSignInUrl(DEMO_PROVIDER_EMAIL, new URL(req.url));
  // The token is in the URL, so this line says that a link was minted and for whom, never the link itself
  // (§10.3 keeps link tokens out of the logs).
  log.info("demo_signin_link_minted", { practiceId: provider.practiceId, userId: provider.id, demo: true });
  return NextResponse.redirect(url);
}

export const GET = withRoute("GET /demo", getHandler);
