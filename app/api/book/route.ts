// POST /api/book  { name, phone?, email?, providerId?, apptAt?, visitType?, reason?, channel?, consentMethod?, consentAt? }
// Creates (or reuses) the patient and adds one visit (design §2.2, §4.4) whose presigned token is the intake
// link, and, when there is consent to message them, queues a `notify.invite` job to send that link (§3.4).
// Returns { visitId, patientId, token, link, patientReused, queued, channel?, reason?, jobId? }. Owner: Justin.
// `visitId` is what every other route and page speaks in from here on (design §4.4).
//
// Booking is staff's job (§5.2, `visits:create`), so this needs a session: the patient and the visit land in
// the caller's practice and nowhere else. `providerId` names the clinician the visit is for and has to be a
// colleague — another practice's user id is a 404 (lib/guard.ts) — defaulting to the person booking it.
//
// Thin on purpose (AGENTS.md): every rule is lib/visitIntake.ts, every write is lib/visitStore.ts, and the two
// of them are also what the CSV import uses, so the day-at-a-time path cannot drift from this one. What used
// to be an `optIn` boolean on the payload is now derived from the channel and the recorded consent: §2.2 wants
// a consent with a who, a when and a how behind it, and a checkbox is none of those.
//
// `queued` is a claim about whether this invite is going out, and not about the queue (T111). It used to mean
// only that a row had gone into `Job`, and the wizard read it as "the invite is on its way by email" in an
// environment with no email backend at all — the one `scripts/agent-check.sh` and a fresh `.env` are both in.
// `channel` names the channels that really can send, which is a subset of what staff chose, and `reason` is
// what staff read when it is empty. The fallback itself is the senders' own contract — "Unconfigured ->
// { sent: false, error } with no `provider`, and the UI shows the link instead" (lib/email.ts, lib/sms.ts) —
// which is what §8.1's two backends amount to for a deployment that has not set them up. The link is already
// here.
//
// T145 then found the two thirds of that claim the deployment does not decide: §13.4's demo rule and §8.1's
// bounce or STOP are facts on the rows this request writes, both known before the answer, and neither was
// asked. `inviteReach` (lib/notify.ts) is the whole question, and the rows go first.

import { after, NextResponse } from "next/server";
import { NO_CONSENT_TO_MESSAGE } from "@/lib/delivery";
import { requireCapability, requireMemberInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { inviteReach } from "@/lib/notify";
import { intakeLink } from "@/lib/sms";
import { channelOf, parseVisitDraft } from "@/lib/visitIntake";
import { createVisit } from "@/lib/visitStore";

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { providerId?: string; apptAt?: unknown; scheduledAt?: unknown } & Record<string, unknown>;
  const me = await requireCapability("visits:create");

  // `apptAt` is what the wizard has always called it; `scheduledAt` is the column's own name and what the CSV
  // import speaks. Both are accepted so neither caller has to translate.
  const parsed = parseVisitDraft({ ...body, scheduledAt: body.scheduledAt ?? body.apptAt ?? null });
  if (!parsed.ok) return NextResponse.json({ error: parsed.errors[0], errors: parsed.errors }, { status: 400 });

  // The patient's own credential is the token this hands back (§5.3); the practice is the caller's (§5.2).
  const provider = body.providerId && body.providerId !== me.id ? await requireMemberInPractice(body.providerId, me) : me;
  // `rows` is destructured off rather than spread into the answer below: it carries the patient's own phone
  // and address, and this response is ids and a link (§10.3, lib/visitStore.ts `InviteReachRows`).
  const { reach: rows, ...created } = await createVisit(me, provider.id, parsed.draft);

  const booked = { ...created, link: intakeLink(created.token) };
  if (parsed.draft.channel === "none") return NextResponse.json({ ...booked, queued: false, reason: NO_CONSENT_TO_MESSAGE });

  // The send is a job, so adding a patient returns as fast as the insert and a throttled SES call cannot cost
  // the clinic the patient row it just created (§3.4, §8).
  const { job } = await enqueue({ kind: "notify.invite", payload: { visitId: created.visitId }, idempotencyKey: `notify.invite:${created.visitId}` });
  nudge(after);

  // Queued either way, deliberately: the job is what writes this visit's delivery rows (`skipped`, T110), so
  // §8.3's dashboard cell still says what happened to the channel instead of falling silent about it. What
  // changes is only what staff are promised.
  //
  // `inviteReach` and not `inviteSendability` since T145: the latter asks only whether this deployment has a
  // sender behind the channel, and two of the three things that close one live on the rows this request has
  // just written. §13.4's demo rule is the one that mattered — a demo practice booking a prospect's real
  // mobile number was answered `queued: true`, so the card said "<name> is on the way." and only the
  // delivery row, minutes later, said that nothing had gone out. §8.1's bounce and STOP ride along with it
  // because §2.2 reuses a patient matched on phone or email, so a new visit can inherit either. The rows are
  // asked before the environment, so the sentence staff read names what no amount of configuration will fix.
  const reach = inviteReach({ channel: parsed.draft.channel, ...rows });
  if (!reach.channels.length) return NextResponse.json({ ...booked, queued: false, reason: reach.reason, jobId: job.id });
  return NextResponse.json({ ...booked, queued: true, channel: channelOf(reach.channels), jobId: job.id });
}

export const POST = withRoute("POST /api/book", postHandler);
