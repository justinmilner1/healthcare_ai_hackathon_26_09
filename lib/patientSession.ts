// Patient link verification (design §2.3, §5.3, §5.5). Owner: identity.
//
// The token in an invite identifies the visit, and on its own that is all it does: it opens a code screen and
// nothing else, so a forwarded link reveals nothing (§2.3). Opening the link mints a six-digit code, sends it
// to the phone or email already on file, and the patient types it back. A correct code turns the pending
// `PatientSession` row (§4.5) into a verified one for 24 hours, and the browser gets that row's id in a
// signed, httpOnly cookie. The binding is the row's `visitId`, so one cookie opens one visit and no other.
//
// What is stored and what is not: only the HMAC of the code, never the code. The plaintext exists for the
// length of one job — `notify.code` mints it, sends it, and keeps no copy (lib/jobHandlers.ts) — which is why
// nothing durable, a job payload included, ever carries it (§10.3). The same goes for the log: a code and a
// cookie are both bearer credentials, so neither is ever a field.
//
// Three wrong tries kill the code, and so do ten minutes. Both are decided by checkCode(), which is pure, so
// the two clocks are tested without a database (lib/patientSession.test.ts).
//
// Nothing here imports next/headers: the cookie arrives as a string, from `req.headers.get("cookie")` in a
// route or from `cookies()` in a layout. That keeps the module loadable by `node --test`.

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { db } from "./db";

/** The verified patient session (§5.3). Signed and httpOnly; set by POST /api/verify. */
export const PATIENT_SESSION_COOKIE = "ss_patient";

/** A code is good for ten minutes (§5.3). */
export const CODE_TTL_MS = 10 * 60_000;

/** A verified session lasts 24 hours (§5.3). */
export const SESSION_TTL_MS = 24 * 60 * 60_000;

/** Three wrong attempts invalidate the code (§5.3). */
export const MAX_CODE_ATTEMPTS = 3;

/**
 * How long a row may sit waiting for `notify.code` to mint its code. The pending row is created by the route
 * and filled in by the job, and until then `codeHash` is empty and can match nothing. Its `codeExpiresAt`
 * stands in as the deadline for that hand-off, so one rule — "not past codeExpiresAt" — covers both a code
 * that was never minted and a code that has gone stale, and a send that failed for good does not leave a
 * reload reusing a row no code will ever arrive for.
 */
export const CODE_MINT_WINDOW_MS = 60_000;

/** Only the parts of the client this module uses, so a test can pass one pointed at a fixture schema. */
export type SessionClient = Pick<PrismaClient, "patientSession">;

/** One `PatientSession` row, as much of it as the two clocks need. */
export type CodeRow = { codeHash: string; codeExpiresAt: Date; verifiedAt: Date | null; attempts: number };

export type CodeFailure = "no_code" | "expired" | "locked" | "wrong";
export type CodeVerdict = { ok: true } | { ok: false; reason: CodeFailure; remaining: number };

// AUTH_SECRET already signs the provider session cookie (lib/auth.ts) and is `required` in production
// (lib/config.ts), so it signs this cookie and hashes the codes too, under its own label. Deliberately not
// imported from lib/auth.ts: that module pulls in next-auth, and this one has to stay loadable by the unit
// tests. The development fallback is the same constant for the same reason it is there — `npm run dev` and
// the e2e suite work with no setup — and in production a missing secret is a thrown error, because a cookie
// signed with a known constant is not signed.
const DEV_SECRET = "sweet-spot-development-secret-not-for-deployment";

function sessionSecret(): string {
  const given = process.env.AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET?.trim();
  if (given) return given;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is required to sign patient sessions (design §5.3)");
  return DEV_SECRET;
}

const mac = (label: string, value: string) => createHmac("sha256", sessionSecret()).update(`${label}:${value}`).digest("base64url");

/** Six digits, uniformly drawn. `randomInt` is rejection-sampled, so 000000 is as likely as any other. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The stored form of a code. Bound to the visit, so a code for one visit cannot be replayed against another. */
export function hashCode(visitId: string, code: string): string {
  return mac("patient-code.v1", `${visitId}:${code}`);
}

/** `<session id>.<signature>`: what goes in the cookie. */
export function signSessionId(id: string): string {
  return `${id}.${mac("patient-session.v1", id)}`;
}

/** The session id inside a cookie value, or null if the signature does not hold. */
export function readSessionId(cookieValue: string | null | undefined): string | null {
  if (!cookieValue) return null;
  const cut = cookieValue.lastIndexOf(".");
  if (cut <= 0) return null;
  const id = cookieValue.slice(0, cut);
  return sameString(cookieValue.slice(cut + 1), mac("patient-session.v1", id)) ? id : null;
}

/** One cookie out of a `Cookie:` header. Routes here get a plain `Request`, not a NextRequest. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const cut = part.indexOf("=");
    if (cut < 0) continue;
    if (part.slice(0, cut).trim() !== name) continue;
    return decodeURIComponent(part.slice(cut + 1).trim());
  }
  return null;
}

/** Constant-time string compare that does not leak the length either. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(mac("compare.v1", a));
  const right = Buffer.from(mac("compare.v1", b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether this code may still be typed in: not used, not out of tries, not out of time. A row whose
 * `codeHash` is empty is a code the job has not minted yet, and `codeExpiresAt` is then the mint deadline
 * (see CODE_MINT_WINDOW_MS), so the same comparison answers for both.
 */
export function codeLive(row: CodeRow | null | undefined, now: Date = new Date()): boolean {
  return Boolean(row) && !row!.verifiedAt && row!.attempts < MAX_CODE_ATTEMPTS && row!.codeExpiresAt.getTime() > now.getTime();
}

/** Whether a verified session is still a session. */
export function sessionLive(row: { verifiedAt: Date | null; expiresAt: Date } | null | undefined, now: Date = new Date()): boolean {
  return Boolean(row?.verifiedAt) && row!.expiresAt.getTime() > now.getTime();
}

/**
 * The verdict on one typed code, with no database and no clock of its own.
 *
 *   no_code   nothing is waiting to be verified, or the code was never minted
 *   expired   past the ten minutes (§5.3)
 *   locked    three wrong tries already (§5.3); the code is dead whatever is typed next
 *   wrong     a live code, the wrong digits; `remaining` is how many tries are left after this one
 */
export function checkCode(row: CodeRow | null | undefined, visitId: string, code: string, now: Date = new Date()): CodeVerdict {
  if (!row || row.verifiedAt) return { ok: false, reason: "no_code", remaining: 0 };
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "locked", remaining: 0 };
  // An empty hash is a code that never arrived, not an expired one: say so, so the screen offers a resend
  // rather than claiming time ran out.
  if (!row.codeHash) return { ok: false, reason: "no_code", remaining: 0 };
  if (row.codeExpiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired", remaining: 0 };
  const typed = code.trim();
  // A malformed code is simply the wrong code and costs an attempt, so guessing at the format is not free.
  if (/^\d{6}$/.test(typed) && sameString(hashCode(visitId, typed), row.codeHash)) return { ok: true };
  return { ok: false, reason: "wrong", remaining: Math.max(0, MAX_CODE_ATTEMPTS - (row.attempts + 1)) };
}

/** Which ways there are to reach this patient. No code can be sent without one of them (§2.3). */
export function channelsFor(contact: { phone?: string | null; email?: string | null }): ("sms" | "email")[] {
  const channels: ("sms" | "email")[] = [];
  if (contact.phone?.trim()) channels.push("sms");
  if (contact.email?.trim()) channels.push("email");
  return channels;
}

/** "your phone", "your email", "your phone and your email". Never the number or the address (§2.3). */
export function channelPhrase(channels: readonly ("sms" | "email")[]): string {
  const words = channels.map((c) => (c === "sms" ? "your phone" : "your email"));
  if (words.length === 0) return "your contact details";
  return words.length === 1 ? words[0] : `${words[0]} and ${words[1]}`;
}

// ---------------------------------------------------------------------------------------------
// The database side. One pending row per visit at a time, so "the code" is never ambiguous.

const pending = (client: SessionClient, visitId: string) =>
  client.patientSession.findFirst({ where: { visitId, verifiedAt: null }, orderBy: { codeExpiresAt: "desc" } });

/**
 * Ask for a code. Returns `reused: true` when one is already live — a reload must not invalidate the code the
 * patient is in the middle of typing — and otherwise leaves a fresh pending row for `notify.code` to fill in.
 * `resend: true` is the patient saying the first one never arrived, and replaces whatever is there.
 */
export async function startVerification(
  visitId: string,
  opts: { resend?: boolean } = {},
  now: Date = new Date(),
  client: SessionClient = db,
): Promise<{ sessionId: string; reused: boolean }> {
  const live = await pending(client, visitId);
  if (!opts.resend && codeLive(live, now)) return { sessionId: live!.id, reused: true };
  await client.patientSession.deleteMany({ where: { visitId, verifiedAt: null } });
  const row = await client.patientSession.create({
    data: {
      visitId,
      codeHash: "",
      // The mint deadline until the job has run; mintCode replaces it with the real ten minutes.
      codeExpiresAt: new Date(now.getTime() + CODE_MINT_WINDOW_MS),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    },
  });
  return { sessionId: row.id, reused: false };
}

/**
 * Mint the code for the pending row and hand the plaintext back exactly once, to the caller that is about to
 * send it. Null means there is nothing waiting — already verified, or the row was replaced — and the job then
 * has nothing to do. A retry mints a new code, which is right: the previous one never reached anybody.
 */
export async function mintCode(visitId: string, now: Date = new Date(), client: SessionClient = db): Promise<string | null> {
  const row = await pending(client, visitId);
  if (!row) return null;
  const code = newCode();
  await client.patientSession.update({
    where: { id: row.id },
    data: { codeHash: hashCode(visitId, code), codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), attempts: 0 },
  });
  return code;
}

export type VerifyOutcome = { ok: true; sessionId: string; expiresAt: Date } | { ok: false; reason: CodeFailure; remaining: number };

/** Check a typed code and, when it is right, turn the pending row into a 24-hour session. */
export async function verifyCode(visitId: string, code: string, now: Date = new Date(), client: SessionClient = db): Promise<VerifyOutcome> {
  const row = await pending(client, visitId);
  const verdict = checkCode(row, visitId, code, now);
  if (verdict.ok) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await client.patientSession.update({ where: { id: row!.id }, data: { verifiedAt: now, expiresAt } });
    return { ok: true, sessionId: row!.id, expiresAt };
  }
  if (row && verdict.reason === "wrong") {
    const attempts = row.attempts + 1;
    const spent = attempts >= MAX_CODE_ATTEMPTS;
    // The third wrong try invalidates the code (§5.3), and dropping the hash is what makes that final:
    // nothing can match it again, so the only way on is a new code.
    await client.patientSession.update({ where: { id: row.id }, data: { attempts, ...(spent ? { codeHash: "" } : {}) } });
    // checkCode judged the row as it was *before* this attempt, so on the last one it says "wrong, none
    // left". What actually happened is that this attempt killed the code, and the screen should say that
    // rather than invite a fourth try that can only fail.
    if (spent) return { ok: false, reason: "locked", remaining: 0 };
  }
  return verdict;
}

/** The session this cookie proves, for this visit, right now — or null, which means "show the code screen". */
export async function verifiedSession(
  visitId: string,
  cookieValue: string | null | undefined,
  now: Date = new Date(),
  client: SessionClient = db,
) {
  const id = readSessionId(cookieValue);
  if (!id) return null;
  const row = await client.patientSession.findUnique({ where: { id } });
  if (!row || row.visitId !== visitId || !sessionLive(row, now)) return null;
  return row;
}

/**
 * The refusal every patient route gives when the link has not been verified (§5.3). A `code` the page can
 * branch on, and a sentence that says what to do rather than what went wrong.
 */
export const VERIFICATION_REQUIRED = {
  error: "Verify your link before continuing: open it again and type the code we text or email you.",
  code: "verification_required",
} as const;

/**
 * Whether this visit needs a verified session at all. A sandbox visit is the isolated Dexcom demonstration
 * (§9.2, POST /api/dexcom/demo): a synthetic patient with no phone and no email, so there is nobody to send
 * a code to and no real data behind the link. Everything else needs one.
 */
export const needsVerification = (visit: { isSandbox: boolean }) => !visit.isSandbox;

/** Whether this request may act on this visit as the patient. The one check every patient route makes. */
export async function patientAllowed(
  req: { headers: { get(name: string): string | null } },
  visit: { id: string; isSandbox: boolean },
  now: Date = new Date(),
  client: SessionClient = db,
): Promise<boolean> {
  if (!needsVerification(visit)) return true;
  return Boolean(await sessionForRequest(req, visit.id, now, client));
}

/**
 * The verified session behind one request, or null — which every patient route turns into
 * VERIFICATION_REQUIRED. Takes the headers rather than a NextRequest so this module stays free of
 * next/server and the unit tests can load it.
 */
export async function sessionForRequest(
  req: { headers: { get(name: string): string | null } },
  visitId: string,
  now: Date = new Date(),
  client: SessionClient = db,
) {
  return verifiedSession(visitId, readCookie(req.headers.get("cookie"), PATIENT_SESSION_COOKIE), now, client);
}

/** Drop every session and pending code for a visit: what regenerating a link has to do (§5.5). */
export async function revokeSessions(visitId: string, client: SessionClient = db): Promise<number> {
  const { count } = await client.patientSession.deleteMany({ where: { visitId } });
  return count;
}
