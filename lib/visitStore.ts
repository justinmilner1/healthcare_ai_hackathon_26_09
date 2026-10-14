// Creating visits, one at a time or a day at a time, and recording what happened to each invite
// (design §2.2, §4.3, §4.4, §8.3). Owner: identity.
//
// The database half of lib/visitIntake.ts, which holds every rule these writers apply — the same split as
// lib/team.ts / lib/teamStore.ts. Each writer throws HttpError, so the routes in app/api stay thin and a
// refusal is logged with its reason by withRoute (lib/log.ts).
//
// Two things here are §5.2 and not negotiable by a payload:
//   * the practice is always the caller's, so an import can only ever create patients in the caller's clinic;
//   * `consentRecordedBy` is always the caller's user id, so the audit answer to "who said this patient
//     agreed to be messaged" is a person with a session, not a column in an uploaded file.

import { db } from "./db";
import { HttpError } from "./httpError";
import { log } from "./log";
import type { ProviderUser } from "./auth";
import { channelsFor } from "./patientSession";
import { channelsOf, type VisitDraft } from "./visitIntake";
import { knownVisitType } from "./visits";
import { newVisitToken } from "./migrateVisits";

/** One created visit, as the routes hand it back. No name, phone or email: the dashboard re-reads those. */
export type CreatedVisit = {
  visitId: string;
  patientId: string;
  token: string;
  /** True when the row joined a patient the practice already had, matched on phone or email (§2.2). */
  patientReused: boolean;
};

/**
 * The patient a draft is for: an existing one in this practice matched on phone or email, else a new row.
 *
 * §2.2 says "patient (new or existing by phone/email)", and the match has to be inside the practice — a
 * number shared with another clinic's patient is not this clinic's patient. Phone is tried before email
 * because a household shares an address far more often than a mobile. A soft-deleted patient (§10.5) is not
 * a match: their data was deleted on request, and silently reattaching a new visit to that row would quietly
 * undo it.
 */
async function patientFor(practiceId: string, draft: VisitDraft): Promise<{ id: string; reused: boolean }> {
  const byPhone = draft.phone ? await db.patient.findFirst({ where: { practiceId, phone: draft.phone, deletedAt: null } }) : null;
  const existing = byPhone ?? (draft.email ? await db.patient.findFirst({ where: { practiceId, email: draft.email, deletedAt: null } }) : null);
  if (existing) {
    // The contact details on the row are refreshed from what the scheduler just typed, so a patient who
    // changed their email does not keep an invite going to the old one. Nothing else about them is touched.
    const data: { phone?: string; email?: string } = {};
    if (draft.phone && draft.phone !== existing.phone) data.phone = draft.phone;
    if (draft.email && draft.email !== existing.email) data.email = draft.email;
    if (Object.keys(data).length) await db.patient.update({ where: { id: existing.id }, data });
    return { id: existing.id, reused: true };
  }
  const created = await db.patient.create({
    data: { practiceId, name: draft.name, phone: draft.phone, email: draft.email },
  });
  return { id: created.id, reused: false };
}

/**
 * One visit for one draft, consent recorded against the caller (§2.2). `providerUserId` is the clinician the
 * visit is for and has already been checked to be a colleague by the route (lib/guard.ts).
 *
 * `optIn` stays on the row as the one boolean the rest of the app reads ("may we message this patient"), and
 * is now derived rather than posted: it is true exactly when a channel was chosen and a consent method was
 * recorded for it. Nothing can post `optIn: true` with no consent behind it any more.
 */
export async function createVisit(me: ProviderUser, providerUserId: string, draft: VisitDraft): Promise<CreatedVisit> {
  const patient = await patientFor(me.practiceId, draft);
  const consented = draft.channel !== "none" && Boolean(draft.consentMethod);
  const visit = await db.visit.create({
    data: {
      patientId: patient.id,
      providerUserId,
      scheduledAt: draft.scheduledAt ? new Date(draft.scheduledAt) : null,
      visitType: draft.visitType,
      reason: draft.reason,
      token: newVisitToken(),
      contactChannel: draft.channel,
      consentRecordedBy: draft.consentMethod ? me.id : null,
      consentRecordedAt: draft.consentMethod ? new Date(draft.consentAt ?? Date.now()) : null,
      consentChannel: draft.consentMethod,
      optIn: consented,
      status: "invited",
    },
  });
  // §10.3: ids, the recognised visit type and the channel. No name, no number, no address, no reason text.
  log.info("visit_created", {
    visitId: visit.id,
    patientId: patient.id,
    practiceId: me.practiceId,
    userId: me.id,
    providerId: providerUserId,
    visitType: knownVisitType(visit.visitType),
    channel: draft.channel,
    consent: draft.consentMethod ?? "none",
    reused: patient.reused,
  });
  return { visitId: visit.id, patientId: patient.id, token: visit.token, patientReused: patient.reused };
}

/**
 * A day of visits, one row at a time (§2.2). Rows are created in file order and independently: a row that
 * fails at the database — two rows for the same new patient racing each other, a constraint nobody predicted —
 * is reported as that row's error and the rest of the day still lands. Which is the whole point of importing
 * a day: a receptionist should not have to find out which of 25 appointments the file got as far as.
 */
export type ImportOutcome = { line: number; created: CreatedVisit | null; error: string | null };

export async function importVisits(me: ProviderUser, providerUserId: string, rows: { line: number; draft: VisitDraft }[]): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push({ line: row.line, created: await createVisit(me, providerUserId, row.draft), error: null });
    } catch (e) {
      const error = e instanceof HttpError ? e.message : "That row could not be saved. Try it on its own.";
      log.warn("visit_import_row_failed", { practiceId: me.practiceId, userId: me.id, line: row.line, error: e });
      outcomes.push({ line: row.line, created: null, error });
    }
  }
  log.info("visit_import_finished", {
    practiceId: me.practiceId,
    userId: me.id,
    count: outcomes.length,
    created: outcomes.filter((o) => o.created).length,
  });
  return outcomes;
}

// ---------------------------------------------------------------------------------------------
// §8.3 Delivery results, per channel, recorded on the visit and shown to staff.

export type DeliveryStatus = "sent" | "failed" | "skipped";

/** What one channel did with one message. `providerMessageId` is SES's or SNS's own id (§8.3), the handle a
 *  bounce notification arrives under; it is null for a send that never left. */
export type DeliveryResult = { sent: boolean; provider?: string; messageId?: string; error?: string };

const statusOf = (r: DeliveryResult): DeliveryStatus => (r.sent ? "sent" : r.provider ? "failed" : "skipped");

/**
 * Record what each channel did, keyed by visit and channel so the newest result replaces the last one: staff
 * looking at the dashboard want "did the invite reach them", not a log of every attempt (the log has that).
 *
 * Never throws. A send that worked must not be reported as a failure because the bookkeeping row did not
 * save, and the invite job's retry would then send the message a second time.
 */
export async function recordDeliveries(visitId: string, kind: string, channels: Record<string, DeliveryResult>): Promise<void> {
  for (const [channel, result] of Object.entries(channels)) {
    const status = statusOf(result);
    try {
      const data = {
        kind,
        status,
        providerName: result.provider ?? null,
        providerMessageId: result.messageId ?? null,
        // The reason a channel did nothing is operational text from SES, SNS or our own "no phone on file":
        // never the address and never the body, so it is safe to show staff and to keep (§10.3).
        error: result.error ?? null,
        at: new Date(),
      };
      await db.visitDelivery.upsert({ where: { visitId_channel: { visitId, channel } }, create: { visitId, channel, ...data }, update: data });
    } catch (e) {
      log.warn("delivery_not_recorded", { visitId, channel, status, error: e });
    }
  }
}

/** The per-channel delivery state the dashboard prints, for a list of visits in one query (§8.3). */
export type DeliveryRow = { channel: string; kind: string; status: string; providerMessageId: string | null; error: string | null; at: string };

export async function deliveriesByVisit(visitIds: string[]): Promise<Record<string, DeliveryRow[]>> {
  if (!visitIds.length) return {};
  const rows = await db.visitDelivery.findMany({ where: { visitId: { in: visitIds } }, orderBy: { channel: "asc" } });
  const byVisit: Record<string, DeliveryRow[]> = {};
  for (const r of rows) {
    (byVisit[r.visitId] ??= []).push({
      channel: r.channel,
      kind: r.kind,
      status: r.status,
      providerMessageId: r.providerMessageId,
      error: r.error,
      at: r.at.toISOString(),
    });
  }
  return byVisit;
}

/** The channels an invite for this visit should go out on: what staff chose (§2.2), narrowed to the ways
 *  there are to reach the patient at all (`channelsFor`, §2.3). A visit with no opt-in sends nothing,
 *  whatever channel is stored — the invite is the one message consent governs; the verification code that
 *  T08 sends when the patient opens the link is not an invite and is not sent from here. */
export function invitableChannels(visit: { optIn: boolean; contactChannel: string | null; patient: { phone: string | null; email: string | null } }): ("sms" | "email")[] {
  if (!visit.optIn) return [];
  const reachable = channelsFor(visit.patient);
  return channelsOf(visit.contactChannel).filter((c) => reachable.includes(c));
}
