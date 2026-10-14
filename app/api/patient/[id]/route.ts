// GET /api/patient/[id]  -> PatientBundle for one visit (design §4.4). `id` is a visit id or the presigned
// token from the invite, which is how /patient/<token> loads straight from the link (§5.3).
//
// Two audiences, two credentials, which is why the branch below exists:
//
//   a token    the patient's own way in, and the only thing they are given (§2.7, §5.3). Nothing more is
//              asked for here; binding the token to a verified six-digit code is T08.
//   a visit id a provider's way in, and it is guessable in a way a token is not — so it needs a session, a
//              role that may read a summary, and the visit has to belong to the caller's practice (§5.2).
//
// Both orders of that check matter. The token is tried first, so the patient flow never touches the session;
// and a visit id from another practice answers exactly as a visit id that was never issued does, because a
// 403 here would confirm the visit exists (lib/guard.ts).
//
// This is the read §10.2 is about: the bundle is a visit's intake, its transcript as Sour reads it, its
// uploads and its summary in one response. A provider's read of it writes one audit row per part that was
// actually in the response (lib/auditStore.ts). The patient's own read of their own visit is not that: the
// row for them is the link verification, written where the token is accepted (lib/visit.ts).

import { NextResponse } from "next/server";
import { visitPartsRead } from "@/lib/auditLog";
import { recordVisitRead } from "@/lib/auditStore";
import { loadBundle } from "@/lib/bundle";
import { requireCapability, requireVisitInPractice } from "@/lib/guard";
import { withRoute } from "@/lib/log";
import { visitByToken } from "@/lib/visit";

async function getHandler(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asPatient = Boolean(await visitByToken(id));
  const me = asPatient ? null : await requireCapability("summaries:read");
  if (me) await requireVisitInPractice(id, me);
  const bundle = await loadBundle(id);
  if (!bundle) return NextResponse.json({ error: "visit not found" }, { status: 404 });
  // After the bundle, so the row records what was handed over, and not before in case it was nothing.
  if (me) await recordVisitRead({ practiceId: me.practiceId, visitId: bundle.visitId, actor: me, parts: visitPartsRead(bundle) });
  return NextResponse.json(bundle);
}

export const GET = withRoute("GET /api/patient/[id]", getHandler);
