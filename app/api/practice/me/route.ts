// The caller's own row in the practice (design §2.1, §4.2, §5.2). Owner: identity.
// PATCH /api/practice/me { name } -> { member }
//
// Any signed-in provider, not just an admin: this is the one thing on the settings screen that is not the
// admin's to decide for somebody else, and there is nothing here another role could reach that is not
// already their own (§5.2). `requireProvider` rather than `requireCapability` says that in one line.
//
// The reply is the caller's own member row and nothing else. A `team` here, as the sibling routes return,
// would hand every colleague's address to a clinician or a receptionist the moment a non-admin screen posts
// to this — "a user never sees another practice's data" is the rule, but a staff account seeing its own
// practice's user list is not this route's business either. The settings screen swaps the row it already has
// for this one, which is also what makes the "(you)" row pick the name up without a reload (T115).

import { NextResponse } from "next/server";
import { requireProvider } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { setOwnName } from "@/lib/teamStore";

async function patchHandler(req: Request) {
  const me = await requireProvider();
  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const member = await setOwnName({ practiceId: me.practiceId, userId: me.id, name: body.name });
  return NextResponse.json({ member });
}

export const PATCH = withRoute("PATCH /api/practice/me", patchHandler);
