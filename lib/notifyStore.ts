// Writing down what a notification provider told us (design §8.1, §8.3). Owner: Justin.
//
// The database half of lib/snsEvents.ts, which turns a request body into events, and of lib/suppression.ts,
// which is the rule the sends then read — the same split as lib/retention.ts / lib/retentionStore.ts.
//
// Two kinds of write per event, for two different readers:
//
//   the `Patient` row     a closed channel, so the next send does not spend a message on it (§8.1). This is
//                         the one that changes behaviour.
//   the `VisitDelivery`   the row for the message the provider is reporting on, found by the provider's own
//                         message id, moved from `sent` to `bounced` or `complained` (§8.3). This is the one
//                         staff read on the dashboard: "we sent it and it came back" is a different story
//                         from "we sent it".
//
// Nothing here throws at the caller. The route is answering AWS, and AWS's answer to a 500 is to post the
// same notification again for an hour: a patient we cannot match, a payload we do not read and a delivery row
// that has already been deleted are all ordinary, and each is counted in the report rather than retried.

import type { PrismaClient } from "@prisma/client";
import { recordAudit, type AuditWrite } from "./auditStore";
import { db } from "./db";
import { log } from "./log";
import type { NotificationEvent } from "./snsEvents";

/** Just the delegates this needs, so a unit test can hand it a stub (the pattern lib/retentionStore.ts uses). */
export type NotifyClient = Pick<PrismaClient, "patient" | "visitDelivery">;

export type NotifyStoreDeps = {
  client?: NotifyClient;
  audit?: (entry: AuditWrite) => Promise<void>;
  now?: Date;
};

type Resolved = { client: NotifyClient; audit: (entry: AuditWrite) => Promise<void>; now: Date };

const resolve = (deps: NotifyStoreDeps): Resolved => ({
  client: deps.client ?? (db as unknown as NotifyClient),
  audit: deps.audit ?? recordAudit,
  now: deps.now ?? new Date(),
});

export type ApplyReport = {
  /** How many events were understood and written. */
  applied: number;
  /** Patients whose channel this closed or reopened. */
  patients: number;
  /** Delivery rows restated (§8.3). Zero is normal: the visit may have been deleted since the send. */
  deliveries: number;
  /** Events naming somebody this practice does not have on file. Counted, never logged with the address. */
  unmatched: number;
};

const EMPTY: ApplyReport = { applied: 0, patients: 0, deliveries: 0, unmatched: 0 };

const add = (a: ApplyReport, b: Partial<ApplyReport>): ApplyReport => ({
  applied: a.applied + (b.applied ?? 0),
  patients: a.patients + (b.patients ?? 0),
  deliveries: a.deliveries + (b.deliveries ?? 0),
  unmatched: a.unmatched + (b.unmatched ?? 0),
});

/**
 * Every event from one notification, applied. One at a time rather than in a transaction: they are
 * independent facts about different people, and a second notification about the same address is a no-op
 * (`updateMany` with a `null` guard below), so there is nothing a half-applied batch can corrupt.
 */
export async function applyNotificationEvents(events: readonly NotificationEvent[], deps: NotifyStoreDeps = {}): Promise<ApplyReport> {
  const resolved = resolve(deps);
  let report = EMPTY;
  for (const event of events) {
    report = add(report, await applyOne(event, resolved));
  }
  return report;
}

async function applyOne(event: NotificationEvent, deps: Resolved): Promise<Partial<ApplyReport>> {
  switch (event.kind) {
    case "email.bounce":
    case "email.complaint": {
      const reason = event.kind === "email.bounce" ? "bounce" : "complaint";
      const patients = await closeEmail(event.emails, reason, deps);
      const deliveries = await restateDelivery(event.providerMessageId, reason === "bounce" ? "bounced" : "complained", event.code, deps);
      log.info("notification_email_undeliverable", { code: reason, channel: "email", count: patients.matched, rows: deliveries });
      return { applied: 1, patients: patients.changed, deliveries, unmatched: event.emails.length - patients.matched };
    }
    case "email.delivered": {
      // Nothing is suppressed and nothing is reopened: SES confirming a delivery says the message arrived at
      // the mail server, which is what the send already claimed. The delivery row is restated anyway, because
      // `sent` on our side means "SES accepted it" and this is the stronger statement (§8.3).
      const deliveries = await restateDelivery(event.providerMessageId, "sent", null, deps);
      return { applied: 1, deliveries };
    }
    case "sms.optout":
    case "sms.optin": {
      const stop = event.kind === "sms.optout";
      const matched = await setSmsOptOut(event.phone, stop, deps);
      log.info(stop ? "notification_sms_optout" : "notification_sms_optin", { channel: "sms", count: matched.matched });
      return { applied: 1, patients: matched.changed, unmatched: matched.matched === 0 ? 1 : 0 };
    }
    case "sms.failed": {
      // Not suppression: a carrier failure is about one message, not about the number. It is still worth
      // saying on the dashboard, but SNS gives us no message id for an SMS we can key a row from, so the log
      // line is the whole of it until T28's delivery dashboard asks for more.
      log.info("notification_sms_failed", { channel: "sms", code: event.code });
      return { applied: 1 };
    }
  }
}

/**
 * Mark every patient at these addresses undeliverable, and say how many were already marked.
 *
 * `emailUndeliverableAt: null` in the filter is what makes a repeated notification silent: AWS posts the same
 * bounce more than once, and the date on the row is when the address first broke, not when we last heard
 * about it. A complaint over a bounce *does* overwrite, because "they reported us as spam" is the stronger
 * fact and the one that must not be lost.
 */
async function closeEmail(addresses: readonly string[], reason: "bounce" | "complaint", deps: Resolved): Promise<{ matched: number; changed: number }> {
  if (!addresses.length) return { matched: 0, changed: 0 };
  const patients = await deps.client.patient.findMany({
    where: { email: { in: [...addresses] }, deletedAt: null },
    select: { id: true, practiceId: true, emailUndeliverableAt: true, emailUndeliverableReason: true },
  });
  let changed = 0;
  for (const patient of patients) {
    const already = patient.emailUndeliverableAt !== null;
    if (already && (patient.emailUndeliverableReason === "complaint" || reason === "bounce")) continue;
    await deps.client.patient.update({
      where: { id: patient.id },
      data: { emailUndeliverableAt: patient.emailUndeliverableAt ?? deps.now, emailUndeliverableReason: reason },
    });
    changed += 1;
    // §10.2 does not list this among its categories, and it is recorded anyway: an admin asked why a patient
    // stopped getting their invites deserves an answer that is not a log search. The row carries the channel
    // and the provider's word for it, never the address (§4.8).
    await deps.audit({
      practiceId: patient.practiceId,
      actorType: "system",
      action: "contact.suppressed",
      entityType: "patient",
      entityId: patient.id,
      detail: { channel: "email", code: reason },
    });
  }
  return { matched: patients.length, changed };
}

/** The same for a number texting STOP, and for one texting START again. */
async function setSmsOptOut(phone: string, stop: boolean, deps: Resolved): Promise<{ matched: number; changed: number }> {
  const patients = await deps.client.patient.findMany({
    where: { phone, deletedAt: null },
    select: { id: true, practiceId: true, smsOptOutAt: true },
  });
  let changed = 0;
  for (const patient of patients) {
    if (stop === Boolean(patient.smsOptOutAt)) continue;
    await deps.client.patient.update({ where: { id: patient.id }, data: { smsOptOutAt: stop ? deps.now : null } });
    changed += 1;
    await deps.audit({
      practiceId: patient.practiceId,
      actorType: "patient",
      action: stop ? "contact.suppressed" : "contact.resumed",
      entityType: "patient",
      entityId: patient.id,
      detail: { channel: "sms", code: stop ? "stop" : "start" },
    });
  }
  return { matched: patients.length, changed };
}

/**
 * Restate the delivery row the provider is reporting on, found by the message id it handed us at send time
 * (§8.3). Zero rows is the ordinary case for an old message: the visit may have been swept (§10.4) or the
 * patient deleted (§10.5), and a bounce for a visit that no longer exists has nothing to say.
 *
 * `code` becomes the row's `error`, which is operational text staff see in a tooltip: "Permanent/General" is
 * SES's own phrase for it and names no one.
 */
async function restateDelivery(providerMessageId: string | null, status: string, code: string | null, deps: Resolved): Promise<number> {
  if (!providerMessageId) return 0;
  const { count } = await deps.client.visitDelivery.updateMany({
    // A delivery notification is the weakest of the three statements and AWS posts each of them more than
    // once, in no guaranteed order: a repeat of "SES accepted it" arriving after the bounce must not put the
    // row back to `sent` and drop SES's subtype with it, or the dashboard would say the invite landed for an
    // address the patient row has already closed. The same guard as closeEmail's, one table along.
    where: status === "sent" ? { providerMessageId, status: { notIn: ["bounced", "complained"] } } : { providerMessageId },
    data: { status, error: code, at: deps.now },
  });
  return count;
}
