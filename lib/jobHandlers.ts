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
import { sendIntakeInvite, sendSummaryEmails, sendVerificationCode, type CodeResult, type SummaryNotifyResult, type InviteResult } from "./notify";
import { CODE_TTL_MS, mintCode } from "./patientSession";
import { runSour } from "./sourRun";
import { db } from "./db";
import type { Summary } from "./types";
import { findVisit, providerName } from "./visit";

/** The one field every payload has. Anything else is a bug in the enqueue site, so it fails loudly. */
function visitIdOf(payload: JobPayload): string {
  const visitId = payload.visitId;
  if (typeof visitId !== "string" || !visitId) throw new Error("job payload needs a visitId");
  return visitId;
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

  // §8.2 The invite: the presigned link by SMS and email, no clinical content.
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
    });
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
    });
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
      patient: { id: visit.patientId, name: visit.patient.name, email: visit.patient.email },
      provider: { id: visit.providerUserId ?? "", name: providerName(visit), email: visit.providerUser?.email ?? null, practice: visit.patient.practice.name },
      providerSummary,
      patientSummary,
    });
    // Keyed by audience rather than by channel: both of these are email, and which of the two people got
    // their link is the thing worth being able to ask about afterwards (§8.2).
    await recordSends("summary.sent", visit, { provider: result.provider, patient: result.patient }, "audience");
    assertSendable("summary", visit.id, { provider: result.provider, patient: result.patient });
  },
};
