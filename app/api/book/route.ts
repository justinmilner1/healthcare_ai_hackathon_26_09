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
// `queued` is a claim about this deployment and not about the queue (T111). It used to mean only that a row
// had gone into `Job`, and the wizard read it as "the invite is on its way by email" in an environment with
// no email backend at all — the one `scripts/agent-check.sh` and a fresh `.env` are both in. `channel` names
// the channels that really can send, which is a subset of what staff chose, and `reason` is what staff read
// when it is empty. The fallback itself is the senders' own contract — "Unconfigured -> { sent: false,
// error } with no `provider`, and the UI shows the link instead" (lib/email.ts, lib/sms.ts) — which is what
// §8.1's two backends amount to for a deployment that has not set them up. The link is already here.

import { after, NextResponse } from "next/server";
import { NO_CONSENT_TO_MESSAGE } from "@/lib/delivery";
import { requireCapability, requireMemberInPractice } from "@/lib/guard";
import { enqueue, nudge } from "@/lib/jobs";
import { withRoute } from "@/lib/log";
import { inviteSendability } from "@/lib/notify";
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
  const created = await createVisit(me, provider.id, parsed.draft);

  const booked = { ...created, link: intakeLink(created.token) };
  if (parsed.draft.channel === "none") return NextResponse.json({ ...booked, queued: false, reason: NO_CONSENT_TO_MESSAGE });

  // The send is a job, so adding a patient returns as fast as the insert and a throttled SES call cannot cost
  // the clinic the patient row it just created (§3.4, §8).
  const { job } = await enqueue({ kind: "notify.invite", payload: { visitId: created.visitId }, idempotencyKey: `notify.invite:${created.visitId}` });
  nudge(after);

  // Queued either way, deliberately: the job is what writes this visit's delivery rows (`skipped`, T110), so
  // §8.3's dashboard cell still says what happened to the channel instead of falling silent about it. What
  // changes is only what staff are promised, and that comes from the senders themselves — `smsConfig` and
  // `emailConfig` answer with no client and no network call (lib/notify.ts `inviteSendability`).
  const sendable = inviteSendability(parsed.draft.channel);
  if (!sendable.channels.length) return NextResponse.json({ ...booked, queued: false, reason: sendable.reason, jobId: job.id });
  return NextResponse.json({ ...booked, queued: true, channel: channelOf(sendable.channels), jobId: job.id });
}

export const POST = withRoute("POST /api/book", postHandler);
