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
import { recordPatientVerified } from "@/lib/auditStore";
import { db } from "@/lib/db";
import { enqueue, nudge } from "@/lib/jobs";
import { log, withRoute } from "@/lib/log";
import { codeChannels } from "@/lib/notify";
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
import { enforceIpLimit, enforceVisitLimit } from "@/lib/ratelimit";
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
  // §5.4 by IP, before the body is read: a sweep over tokens never reaches the database.
  enforceIpLimit("verify", req);
  const body = (await req.json().catch(() => ({}))) as { token?: string; code?: string; resend?: boolean };
  const visit = await visitByToken(body.token ?? null);
  // One answer for a token that was never ours and one for a token that has been regenerated (§5.5): there
  // is nothing to tell apart, and nothing here confirms that a visit exists.
  if (!visit) return NextResponse.json({ error: "That link is not valid. Check the text or email from your doctor's office." }, { status: 404 });
  // §5.4 by visit, before a code is minted or a guess is checked. Deliberately in front of both halves of
  // this route: whoever holds the link should not be able to text the patient forty codes, and the per-code
  // attempt count (§5.3) only ever sees one code at a time.
  enforceVisitLimit("verify", visit.id);

  if (typeof body.code === "string" && body.code.trim()) return verify(req, visit, body.code);
  return send(visit, Boolean(body.resend));
}

/** Ask for a code. A live code is not replaced unless the patient says it never arrived. */
async function send(visit: { id: string; patientId: string; patient: { phone: string | null; email: string | null } }, resend: boolean) {
  const onFile = channelsFor(visit.patient);
  if (onFile.length === 0) {
    // Nothing to send to, so there is no way in from here. §2.2 has staff record a phone or an email with the
    // visit; until one is there, the office is the only route.
    log.warn("verify_no_channel", { visitId: visit.id, patientId: visit.patientId });
    return NextResponse.json(
      { error: "This link has no phone number or email address on file, so we cannot send you a code. Please call your doctor's office.", channels: onFile },
      { status: 422 },
    );
  }

  // Which of those this deployment has a sender behind (T113). Asked before anything is minted or answered,
  // because `sent: true` on the strength of a queued job is a claim about a `Job` row and not about a
  // message: with no backend behind the only channel on file, the code was reported sent, the patient waited
  // for digits that no process could deliver, and the resend minted another of them. `codeChannels` settles
  // it from the environment, with no client built and no network call (lib/notify.ts), so the answer costs
  // nothing and is available while the patient is still on the screen — the shape T111 gave POST /api/book.
  const channels = codeChannels(onFile);
  if (channels.length === 0) {
    log.warn("verify_no_backend", { visitId: visit.id, patientId: visit.patientId, count: onFile.length });
    // 503: the request is right and the deployment cannot serve it yet. Nothing here names the channel that
    // was on file, let alone the address or the number (§2.3) — the patient's next step is the telephone
    // either way, and VerifyGate renders that as a screen rather than an error under a code box.
    return NextResponse.json(
      { error: "Sweet Spot cannot send you a code right now, so there is no way to open this link. Please call your doctor's office.", channels },
      { status: 503 },
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
  // §10.2 asks for every patient-link verification. Through lib/auditStore.ts rather than a create of its
  // own, so this row speaks the same vocabulary as the rest of the trail and its detail goes through §4.8's
  // gate: how the person proved it and how long the session lasts, never who they are (T12).
  await recordPatientVerified(visit, { method: "one_time_code", hours: Math.round(SESSION_TTL_MS / 3_600_000) });
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
