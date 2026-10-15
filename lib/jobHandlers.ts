// What each job kind actually does (design §3.4, §7.1, §8). Owner: platform.
//
// Separate from lib/jobs.ts on purpose: these handlers pull in the model client, the AWS SDK and Sour, and the
// queue itself should be testable without any of that. lib/jobs.ts imports this module lazily, the moment a
// job is about to run, so enqueueing from a route costs nothing.
//
// Every payload is a visit id and nothing more. The handler reads the visit back, so a job carries no name,
// phone number, email address or clinical text in a row that outlives the request (§10.3), and a job that
// runs a minute later works from the current state of the visit rather than a stale copy of it.

import { recordAudit } from "./auditStore";
import type { AuditAction } from "./auditLog";
import type { JobHandlers, JobPayload } from "./jobs";
import { log } from "./log";
import { purgePatient, sweepRetention } from "./retentionStore";
import {
  sendDeletionConfirmation,
  sendIntakeInvite,
  sendSummaryEmails,
  sendVerificationCode,
  type CodeResult,
  type DeletionResult,
  type SummaryNotifyResult,
  type InviteResult,
} from "./notify";
import { CODE_TTL_MS, mintCode } from "./patientSession";
import { runSour } from "./sourRun";
import { db } from "./db";
import type { Summary } from "./types";
import { findVisit, providerName } from "./visit";
import { invitableChannels, recordDeliveries } from "./visitStore";

/** The field every visit-shaped payload has. Anything else is a bug in the enqueue site, so it fails loudly. */
function visitIdOf(payload: JobPayload): string {
  const visitId = payload.visitId;
  if (typeof visitId !== "string" || !visitId) throw new Error("job payload needs a visitId");
  return visitId;
}

/** The same for the one job that is about a person rather than an appointment (§10.5). */
function patientIdOf(payload: JobPayload): string {
  const patientId = payload.patientId;
  if (typeof patientId !== "string" || !patientId) throw new Error("job payload needs a patientId");
  return patientId;
}

/** An opaque user id, or nothing. A `patient.delete` queued by the runbook (§13.5) has no person behind it,
 *  and lib/retentionStore.ts writes the audit row against the job in that case. */
function optionalUserId(payload: JobPayload): string | null {
  const id = payload.requestedBy;
  return typeof id === "string" && id ? id : null;
}

async function visitOf(payload: JobPayload) {
  const visitId = visitIdOf(payload);
  const visit = await findVisit(visitId);
  // Not an error worth three attempts, but not silence either: a deleted visit (§10.5) is the honest case and
  // the only way to tell it from a bad payload is the log line.
  if (!visit) throw new Error("visit not found");
  return visit;
}

/**
 * Did a notification fail in a way another attempt could fix? `provider` is set only when a backend was
 * chosen and the message really went out, so "no email on file" and an unconfigured sender come back without
 * one: nothing to retry with, and the job is done having sent what it could. A configured channel that
 * errored keeps its retries.
 */
/**
 * §10.2 records "every send". One row per channel that a backend really tried, whether or not it landed: a
 * channel with no address on file and an unconfigured sender never sent anything (that is what a missing
 * `provider` means, see assertSendable), and a row saying so would be a record of nothing happening.
 *
 * The actor is the job, not a person — a send is queued by a booking or by Sour finishing and goes out
 * minutes later (§3.4). What went out is named by its channel and its backend; the address it went to is the
 * patient's and stays out of `detail` (§4.8).
 */
async function recordSends(
  action: AuditAction,
  visit: { id: string; patient: { practiceId: string } },
  results: Record<string, { sent: boolean; error?: string; provider?: string }>,
  /** What the keys of `results` are: the invite's are channels, the summary's are the two audiences (§8.2). */
  field: "channel" | "audience" = "channel",
): Promise<void> {
  for (const [key, result] of Object.entries(results)) {
    if (!result.provider) continue;
    await recordAudit({
      practiceId: visit.patient.practiceId,
      actorType: "system",
      action,
      entityType: "visit",
      entityId: visit.id,
      detail: { [field]: key, provider: result.provider, sent: result.sent },
    });
  }
}

/** The same, for the one message that is about a person rather than an appointment: §8.2's deletion
 *  confirmation, sent once the patient's visits no longer exist (§10.5). */
async function recordPatientSends(
  action: AuditAction,
  patient: { id: string; practiceId: string },
  results: Record<string, { sent: boolean; error?: string; provider?: string }>,
): Promise<void> {
  for (const [channel, result] of Object.entries(results)) {
    if (!result.provider) continue;
    await recordAudit({
      practiceId: patient.practiceId,
      actorType: "system",
      action,
      entityType: "patient",
      entityId: patient.id,
      detail: { channel, provider: result.provider, sent: result.sent },
    });
  }
}

function assertSendable(event: string, visitId: string, channels: Record<string, { sent: boolean; error?: string; provider?: string }>): void {
  const results = Object.values(channels);
  if (results.some((r) => r.sent)) return;
  const attempted = results.filter((r) => !r.sent && r.provider);
  if (attempted.length === 0) {
    log.info(`${event}_nothing_to_send`, { visitId, count: results.length });
    return;
  }
  throw new Error(attempted.map((r) => `${r.provider}: ${r.error ?? "send failed"}`).join("; "));
}

export const handlers: JobHandlers = {
  // §7.1 Enqueued when intake wraps, on demand from the provider page, and (T24) when a Dexcom import lands.
  // runSour saves both summaries, moves the visit to summary_ready, and enqueues notify.summary itself.
  "sour.run": async (payload) => {
    await runSour(visitIdOf(payload));
  },

  // §8.2 The invite: the presigned link, on the channels staff recorded consent for (§2.2), no clinical
  // content. §8.3: what each channel did is written back onto the visit, which is what staff read on the
  // dashboard — it goes in before assertSendable, so a failure that is about to be retried is on screen too.
  "notify.invite": async (payload) => {
    const visit = await visitOf(payload);
    const result: InviteResult = await sendIntakeInvite({
      visitId: visit.id,
      patientId: visit.patientId,
      name: visit.patient.name,
      phone: visit.patient.phone,
      email: visit.patient.email,
      token: visit.token,
      providerName: providerName(visit),
      apptAt: visit.scheduledAt,
      channels: invitableChannels(visit),
      // §8.1 A bounce or a STOP closes the channel whatever staff chose, and is recorded on the patient
      // (lib/notifyStore.ts) rather than on the visit: it is a fact about the address, not the appointment.
      suppression: visit.patient,
    });
    // Two records of one send, for two different readers. §8.3's delivery rows are what staff see on the
    // dashboard — did this patient's invite reach them — and §10.2's audit row is what an admin reads months
    // later. Neither stands in for the other, so both go in.
    await recordDeliveries(visit.id, "notify.invite", [
      { channel: "sms", result: result.sms },
      { channel: "email", result: result.email },
    ]);
    await recordSends("invite.sent", visit, { sms: result.sms, email: result.email });
    assertSendable("invite", visit.id, { sms: result.sms, email: result.email });
  },

  // §2.3, §5.3 The six-digit code for a patient who has just opened their link. The payload is a visit id
  // like every other one: the code does not exist yet when the job is queued. mintCode writes the hash on
  // the pending PatientSession row and hands back the plaintext here, for this one send — so the digits live
  // in memory for the length of this function and are stored nowhere (§10.3). A retry mints a new code,
  // which is the right answer when the previous one reached nobody.
  "notify.code": async (payload) => {
    const visit = await visitOf(payload);
    const code = await mintCode(visit.id);
    if (!code) {
      // Verified while the job sat in the queue, or the row was replaced by a resend that got there first.
      log.info("code_nothing_to_mint", { visitId: visit.id });
      return;
    }
    const result: CodeResult = await sendVerificationCode({
      visitId: visit.id,
      patientId: visit.patientId,
      code,
      phone: visit.patient.phone,
      email: visit.patient.email,
      providerName: providerName(visit),
      minutes: Math.round(CODE_TTL_MS / 60_000),
      suppression: visit.patient,
    });
    // §10.2 records every send, and this is one: a message to the patient's own phone or email. The digits
    // are not in it — `recordSends` writes the channel and the backend, never the body (§4.8).
    await recordSends("code.sent", visit, { sms: result.sms, email: result.email });
    assertSendable("code", visit.id, { sms: result.sms, email: result.email });
  },

  // §8.2 "Your summary is ready": a link each to the clinician and the patient. The summaries are read back
  // from the database rather than carried in the payload, so no clinical text is ever queued.
  "notify.summary": async (payload) => {
    const visit = await visitOf(payload);
    const rows = await db.summary.findMany({ where: { visitId: visit.id }, orderBy: { createdAt: "desc" } });
    const pick = (audience: string) => {
      const row = rows.find((r) => r.audience === audience);
      return row ? (JSON.parse(row.json) as Summary) : null;
    };
    const providerSummary = pick("provider");
    const patientSummary = pick("patient");
    if (!providerSummary || !patientSummary) throw new Error("summaries are not saved yet");
    const result: SummaryNotifyResult = await sendSummaryEmails({
      visit: { id: visit.id, token: visit.token, apptAt: visit.scheduledAt },
      patient: {
        id: visit.patientId,
        name: visit.patient.name,
        email: visit.patient.email,
        emailUndeliverableAt: visit.patient.emailUndeliverableAt,
        emailUndeliverableReason: visit.patient.emailUndeliverableReason,
        smsOptOutAt: visit.patient.smsOptOutAt,
      },
      provider: { id: visit.providerUserId ?? "", name: providerName(visit), email: visit.providerUser?.email ?? null, practice: visit.patient.practice.name },
      providerSummary,
      patientSummary,
    });
    // §8.3 Both of these are email, to two different people, which is why the delivery row is keyed by the
    // audience as well as the channel (T19's migration): the clinician being told and the patient being told
    // are two separate questions on the dashboard, and the second used to overwrite the first.
    await recordDeliveries(visit.id, "notify.summary", [
      { channel: "email", audience: "patient", result: result.patient },
      { channel: "email", audience: "provider", result: result.provider },
    ]);
    // §10.2 counts this as a send like any other. Keyed by audience rather than by channel: which of the two
    // people got their link is the question an admin asks.
    await recordSends("summary.sent", visit, { provider: result.provider, patient: result.patient }, "audience");
    assertSendable("summary", visit.id, { provider: result.provider, patient: result.patient });
  },

  // §10.5 The deletion a staff member asked for (app/api/deletion), carried out here because it touches an
  // object store and a dozen tables and must survive a failure half way through. The payload is a patient id
  // and the id of whoever pressed it — both opaque, neither PHI (§10.3). purgePatient is idempotent, so the
  // three attempts §3.4 allows cannot do any of it twice, and it writes the audit row itself.
  "patient.delete": async (payload) => {
    const patientId = patientIdOf(payload);
    // §8.2's deletion confirmation is sent *after* the purge and addressed from before it: the purge removes
    // the patient's name, phone number and email, which is the very thing being confirmed, so the address to
    // tell is read here while it still exists. Nothing is stored — it lives in this function and goes out in
    // one message (§10.3), and a retry of a job whose purge already finished finds the row scrubbed and sends
    // nothing, which is the right answer: the patient was told the first time.
    const before = await db.patient.findUnique({
      where: { id: patientId },
      select: {
        id: true,
        practiceId: true,
        name: true,
        phone: true,
        email: true,
        emailUndeliverableAt: true,
        emailUndeliverableReason: true,
        smsOptOutAt: true,
        practice: { select: { name: true } },
      },
    });
    const result = await purgePatient({ patientId, requestedBy: optionalUserId(payload) });
    if (!result.found || !before || !(before.phone || before.email)) return;

    const confirmation: DeletionResult = await sendDeletionConfirmation({
      patientId: before.id,
      name: before.name,
      phone: before.phone,
      email: before.email,
      providerName: before.practice.name,
      suppression: before,
    });
    await recordPatientSends("deletion.sent", before, { sms: confirmation.sms, email: confirmation.email });
    // No assertSendable: the deletion has happened and three more attempts cannot undo it or re-run it, so a
    // channel that refused is a logged fact (lib/notify.ts logSend), not a reason to fail the job.
  },

  // §10.4 The nightly sweep. No visit and no patient: the payload is empty, or carries one `practiceId` when
  // somebody is sweeping a single practice by hand. Queued by the runner itself once a day
  // (lib/retentionStore.ts scheduleRetentionSweep), which is the one clock §3.4 gives us.
  "retention.sweep": async (payload) => {
    const practiceId = typeof payload.practiceId === "string" && payload.practiceId ? payload.practiceId : undefined;
    await sweepRetention({ practiceId });
  },
};
