// One colleague's role (design §2.1, §5.2). Owner: identity.
// PATCH /api/practice/users/[id] { role } -> { member, team }
//
// Admin only, and only inside the caller's own practice: a user id from somewhere else is the same 404 as a
// visit id from somewhere else (lib/guard.ts). A practice cannot be left without an admin, including by an
// admin demoting themselves — lib/team.ts refuses the last one.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { practiceTeam, setMemberRole } from "@/lib/team";

async function patchHandler(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireCapability("users:manage");
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  const member = await setMemberRole({ practiceId: me.practiceId, userId: id, role: body.role, actorId: me.id });
  return NextResponse.json({ member, team: await practiceTeam(me.practiceId) });
}

export const PATCH = withRoute("PATCH /api/practice/users/[id]", patchHandler);
