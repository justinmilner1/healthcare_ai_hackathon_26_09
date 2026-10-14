// Inviting someone into the practice (design §2.1, §5.2). Owner: identity.
// POST /api/practice/users { email, name?, role? } -> { member, sent, error?, team }
//
// Admin only. The invite is the User row (lib/team.ts), so this creates a colleague who can sign in with their
// own magic link and lands in this practice with the role chosen here — not a new practice of their own, which
// is what an uninvited address gets (lib/authAdapter.ts).
//
// `sent: false` with an `error` means the row exists but the email did not go out (no backend configured, SES
// refused). That is not a failure of the invite: the person can still be told to sign in, so the response is
// 201 either way and the settings page says which happened.

import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { inviteMember, practiceTeam } from "@/lib/team";

async function postHandler(req: Request) {
  const me = await requireCapability("users:manage");
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; name?: unknown; role?: unknown };
  const invited = await inviteMember({
    practiceId: me.practiceId,
    email: body.email,
    name: body.name,
    role: body.role,
    invitedBy: { id: me.id, name: me.name, email: me.email },
  });
  return NextResponse.json({ ...invited, team: await practiceTeam(me.practiceId) }, { status: 201 });
}

export const POST = withRoute("POST /api/practice/users", postHandler);
