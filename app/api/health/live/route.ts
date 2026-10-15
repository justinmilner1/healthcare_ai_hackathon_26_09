// GET /api/health/live -> `{ ok: true }` while this process can answer. Owner: ops.
//
// Liveness, the companion to the dependency report next door (design §11.2). It touches nothing: no database,
// no bucket, no gateway. Answering at all is the whole signal.
//
// It exists because the two questions have different right answers. "Should this task stay in service?" must
// not be answered no because Bedrock is slow — §11.3 has Sweetie degrade to its scripted path and Sour defer,
// and a load balancer that drains the fleet over that turns a degraded feature into an outage. "Should this
// release be promoted?" must be answered no, which is what /api/health is for.
//
// So the load balancer's target check and Playwright's webServer wait (playwright.config.ts) use this path,
// and the deploy gate uses /api/health.

import { NextResponse } from "next/server";
import { withRoute } from "@/lib/log";

async function getHandler() {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

export const GET = withRoute("GET /api/health/live", getHandler);
