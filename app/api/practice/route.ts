// The practice an admin runs (design §2.1, §4.1, §5.2). Owner: identity.
// GET   /api/practice                          -> { practice: { name, retentionDays }, users: [...] }
// PATCH /api/practice { name?, retentionDays? } -> the same, after the change
//
// Admin only, both of them: §5.2 gives "practice settings" and "users" to admin alone, and the users list is
// every colleague's address, which is not a clinician's or a receptionist's business. The practice is always
// the caller's own — there is no id in the path to point somewhere else, which is the cheapest way to honour
// "a user never sees another practice's data".

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { practiceTeam, updatePracticeSettings } from "@/lib/team";

async function getHandler() {
  const me = await requireCapability("practice:manage");
  return NextResponse.json(await practiceTeam(me.practiceId));
}

async function patchHandler(req: Request) {
  const me = await requireCapability("practice:manage");
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; retentionDays?: unknown };
  // Only the keys that were sent are touched, so the retention form cannot blank the name (lib/team.ts).
  const patch: { name?: unknown; retentionDays?: unknown } = {};
  if ("name" in body) patch.name = body.name;
  if ("retentionDays" in body) patch.retentionDays = body.retentionDays;
  return NextResponse.json(await updatePracticeSettings(me.practiceId, patch));
}

export const GET = withRoute("GET /api/practice", getHandler);
export const PATCH = withRoute("PATCH /api/practice", patchHandler);
