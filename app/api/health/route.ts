// GET /api/health -> the §11.2 dependency report. Owner: ops.
//
// `{ ok, status, checks: { db, storage, model } }`, each check with the milliseconds it took and one word of
// detail; 503 as soon as any configured dependency is down. lib/health.ts holds the rules and says why a
// dependency that is not configured is `skipped` rather than down.
//
// Who asks, and which of the two health paths they use:
//
//   The deploy gate (§13.3, `npm run health:check`) asks for *this* path and demands 200. A release that
//   cannot see its database, its bucket or Bedrock does not get promoted, which is the point of checking
//   three things instead of one.
//
//   A load balancer's target check, and Playwright's webServer wait, ask for `/api/health/live` instead.
//   They decide whether to keep a running task in service, and §11.3 is explicit that a model outage is
//   something this app serves through rather than dies of: Sweetie falls back to the scripted path and Sour
//   defers. Pointing the fleet's liveness probe at a check that 503s on a Bedrock blip would turn a degraded
//   feature into an outage of the whole practice.
//
// Public, like both halves: it names no patient and no practice (lib/access.test.ts).

import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/health";
import { withRoute } from "@/lib/log";

async function getHandler() {
  const report = await checkHealth();
  // no-store: a cached health report is worse than none. The access line withRoute writes carries the status,
  // and each failing check has already logged itself in lib/health.ts.
  return NextResponse.json(report, { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}

export const GET = withRoute("GET /api/health", getHandler);
