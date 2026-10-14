// Patient link verification (design §2.3, §5.3). Owner: identity.
//
// POST /api/verify { token }                  -> 202 { sent, reused, channels }   ask for a code
// POST /api/verify { token, resend: true }    -> 202 { sent: true, channels }     the first one never arrived
// POST /api/verify { token, code }            -> 200 { verified: true } + cookie, or 401 { reason, remaining }
//
// The token says which visit (§4.4) and nothing more: until a code from this visit's own phone or email comes
// back, every patient route refuses, so a forwarded link reveals nothing (§2.3). The sending is a
// `notify.code` job (§3.4), nudged immediately, for the same reason the invite is one: a throttled SES or SNS
// call must not be what the patient is waiting on, and three attempts with the error recorded beats one
// silent failure.
//
// Nothing in a response says who the code went to — the channel ("your phone"), never the number (§2.3).

import { after, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import {
  channelsFor,
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  PATIENT_SESSION_COOKIE,
  SESSION_TTL_MS,
  signSessionId,
  startVerification,
  verifyCode,
} from "@/lib/patientSession";
import { visitByToken } from "@/lib/visit";

/** What the screen says for each way a code can fail. Vague on purpose about which visit exists. */
const REFUSALS: Record<string, string> = {
  no_code: "That code has expired or was already used. Ask for a new one.",
  expired: `That code has expired. Codes last ${Math.round(CODE_TTL_MS / 60_000)} minutes — ask for a new one.`,
  locked: `That is ${MAX_CODE_ATTEMPTS} wrong tries, so the code no longer works. Ask for a new one.`,
  wrong: "That code is not right.",
};

/** Over TLS the cookie is Secure. Not NODE_ENV: `next start` over plain HTTP would set a cookie the browser
 *  drops, and the patient would verify in a loop. Same rule as the CSRF cookie in middleware.ts. */
function overTls(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { token?: string; code?: string; resend?: boolean };
  const visit = await visitByToken(body.token ?? null);
  // One answer for a token that was never ours and one for a token that has been regenerated (§5.5): there
  // is nothing to tell apart, and nothing here confirms that a visit exists.
  if (!visit) return NextResponse.json({ error: "That link is not valid. Check the text or email from your doctor's office." }, { status: 404 });

  if (typeof body.code === "string" && body.code.trim()) return verify(req, visit, body.code);
  return send(visit, Boolean(body.resend));
}

/** Ask for a code. A live code is not replaced unless the patient says it never arrived. */
async function send(visit: { id: string; patientId: string; patient: { phone: string | null; email: string | null } }, resend: boolean) {
  const channels = channelsFor(visit.patient);
  if (channels.length === 0) {
    // Nothing to send to, so there is no way in from here. §2.2 has staff record a phone or an email with the
    // visit; until one is there, the office is the only route.
    log.warn("verify_no_channel", { visitId: visit.id, patientId: visit.patientId });
    return NextResponse.json(
      { error: "This link has no phone number or email address on file, so we cannot send you a code. Please call your doctor's office.", channels },
      { status: 422 },
    );
  }

  const { reused } = await startVerification(visit.id, { resend });
  if (reused) {
    log.info("verify_code_reused", { visitId: visit.id });
    return NextResponse.json({ sent: false, reused: true, channels }, { status: 202 });
  }

  const { job } = await enqueue({ kind: "notify.code", payload: { visitId: visit.id }, idempotencyKey: `notify.code:${visit.id}` });
  nudge(after);
  log.info("verify_code_queued", { visitId: visit.id, jobId: job.id, count: channels.length });
  return NextResponse.json({ sent: true, reused: false, channels }, { status: 202 });
}

/** Check the typed code. A right one is a 24-hour cookie bound to this visit and nothing else. */
async function verify(req: Request, visit: { id: string; patientId: string; status: string; patient: { practiceId: string } }, code: string) {
  const outcome = await verifyCode(visit.id, code);
  if (!outcome.ok) {
    // `code` here is the allow-listed failure-code field ("wrong", "expired", "locked"), never the digits.
    log.info("verify_failed", { visitId: visit.id, code: outcome.reason, attempts: MAX_CODE_ATTEMPTS - outcome.remaining });
    return NextResponse.json({ error: REFUSALS[outcome.reason] ?? REFUSALS.wrong, reason: outcome.reason, remaining: outcome.remaining }, { status: 401 });
  }

  // Forwards only (§4.4): a patient who verifies again after intake must not walk the visit back.
  await db.visit.updateMany({ where: { id: visit.id, status: "invited" }, data: { status: "verified" } });
  // §10.2 asks for every patient-link verification in the audit log. The detail carries no PHI: how the
  // person proved it and how long the session lasts, not who they are. The admin page over these rows is T12.
  await db.auditLog.create({
    data: {
      practiceId: visit.patient.practiceId,
      actorType: "patient",
      actorId: visit.id,
      action: "patient.verified",
      entityType: "Visit",
      entityId: visit.id,
      detail: JSON.stringify({ method: "one_time_code", sessionHours: Math.round(SESSION_TTL_MS / 3_600_000) }),
    },
  });
  log.info("verify_succeeded", { visitId: visit.id, patientId: visit.patientId });

  const res = NextResponse.json({ verified: true });
  res.cookies.set(PATIENT_SESSION_COOKIE, signSessionId(outcome.sessionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: overTls(req),
    path: "/",
    // The cookie and the row expire together; the row is what actually decides (lib/patientSession.ts), so a
    // regenerated link kills the session even in a browser that still holds the cookie.
    expires: outcome.expiresAt,
  });
  return res;
}

export const POST = withRoute("POST /api/verify", postHandler);
