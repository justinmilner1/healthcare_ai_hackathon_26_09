// POST /api/notifications/sns -> { ok: true, ... }
//
// §8.1's other half: "a bounce/complaint topic that marks addresses undeliverable" and "`STOP` is honored and
// recorded on the patient". SES publishes bounces and complaints to an SNS topic, AWS End User Messaging
// publishes inbound texts and SMS delivery status to one, and this is the HTTPS endpoint those topics are
// subscribed to. docs/NOTIFICATIONS.md is how an operator sets that up.
//
// Transport only, like every other route here: lib/snsEvents.ts parses, lib/snsSignature.ts proves it came
// from SNS, lib/notifyStore.ts writes it down, and lib/suppression.ts is what the sends then read.
//
// The authority is the signature and nothing else. There is no session and no shared secret — SNS sends
// neither — so three things are checked before a single row is written:
//
//   1. the topic ARN is one the operator configured (`SNS_TOPIC_ARNS`). Without this, any AWS account in the
//      world can post a correctly signed message about any address;
//   2. the signature verifies against a certificate fetched from an `sns.<region>.amazonaws.com` URL, which
//      is what stops the `SigningCertURL` inside the request being an SSRF (lib/snsSignature.ts);
//   3. the envelope's timestamp is recent, so a captured notification cannot be replayed next week.
//
// Status codes are chosen for the caller, which is AWS, not a browser: SNS retries a 5xx for an hour and
// gives up on a 4xx. So a message we refuse (bad signature, wrong topic) is a 403 and never comes back, and a
// message we understood is a 200 even when it changed nothing — an address belonging to no patient here is
// not a failure, and asking AWS to send it fifty more times would not make it one.
//
// Not in middleware's CSRF check: the route derives nothing from a cookie, which is the bar in lib/csrf.ts.

import { NextResponse } from "next/server";
import { log, withRoute } from "@/lib/log";
import { applyNotificationEvents } from "@/lib/notifyStore";
import { isAllowedTopic, isSnsSubscribeUrl, notificationEvents, parseSnsEnvelope, parseTopicArns } from "@/lib/snsEvents";
import { verifySnsSignature } from "@/lib/snsSignature";

/** A refusal that names what was wrong in one constant and quotes nothing back. */
const refuse = (code: string, status: number) => NextResponse.json({ error: "refused", code }, { status });

async function postHandler(req: Request) {
  const topics = parseTopicArns(process.env.SNS_TOPIC_ARNS);
  if (topics.length === 0) {
    // Nothing is configured, so nothing can be trusted: a 503 rather than a 403, because the problem is on
    // this side and an operator half way through the setup in docs/NOTIFICATIONS.md should see it said plainly.
    log.warn("sns_webhook_unconfigured", { code: "no_topics_configured" });
    return refuse("no_topics_configured", 503);
  }

  const body = (await req.json().catch(() => null)) as unknown;
  const envelope = parseSnsEnvelope(body);
  if (!envelope) return refuse("not_an_sns_envelope", 400);

  if (!isAllowedTopic(envelope.topicArn, topics)) {
    log.warn("sns_webhook_wrong_topic", { code: "topic_not_allowed" });
    return refuse("topic_not_allowed", 403);
  }

  const verdict = await verifySnsSignature(envelope);
  if (!verdict.ok) {
    log.warn("sns_webhook_unverified", { code: verdict.code });
    return refuse(verdict.code, 403);
  }

  // One subscription confirmation per subscription, and it is completed by fetching the URL in the message.
  // The URL is checked against the same host rule as the certificate: it arrives inside the request, and a
  // GET to wherever a stranger points is the same hole whether it is a certificate or a confirmation.
  if (envelope.type === "SubscriptionConfirmation") {
    if (!envelope.subscribeUrl || !isSnsSubscribeUrl(envelope.subscribeUrl)) return refuse("untrusted_subscribe_url", 400);
    const res = await fetch(envelope.subscribeUrl, { redirect: "error" }).catch(() => null);
    const confirmed = Boolean(res?.ok);
    log.info("sns_subscription_confirmed", { ok: confirmed, status: res?.status });
    return NextResponse.json({ ok: confirmed, confirmed });
  }

  if (envelope.type === "UnsubscribeConfirmation") {
    // Somebody detached the topic from this endpoint. Nothing to do here — but it means bounces have stopped
    // arriving, so it is said out loud rather than swallowed.
    log.warn("sns_unsubscribed", { code: "unsubscribe_confirmation" });
    return NextResponse.json({ ok: true });
  }

  // The payload is a string inside the envelope, and it is the signed text: parsing it is the first thing
  // done with the message *after* the signature held, never before.
  let payload: unknown;
  try {
    payload = JSON.parse(envelope.message);
  } catch {
    return refuse("message_not_json", 400);
  }
  const events = notificationEvents(payload);
  if (events.length === 0) {
    // The topic may carry more than this app reads (delivery delays, subscription events, an actual reply to
    // Sweetie). Understood and ignored is a 200: a retry would ignore it again.
    log.info("sns_notification_ignored", { count: 0 });
    return NextResponse.json({ ok: true, applied: 0 });
  }

  const report = await applyNotificationEvents(events);
  // `count` is the events applied and `rows` the delivery rows restated; the patients are not a log field
  // and do not need to be — the audit rows lib/notifyStore.ts writes are where a person is named by id.
  log.info("sns_notification_applied", { count: report.applied, rows: report.deliveries });
  return NextResponse.json({ ok: true, ...report });
}

export const POST = withRoute("POST /api/notifications/sns", postHandler);
