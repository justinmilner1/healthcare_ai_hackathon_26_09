// Unit tests for patient link verification (T08, design §2.3, §5.3, §5.5).
//
// Two halves, the same split as lib/jobs.test.ts. The pure half — the two clocks, the attempt limit, the
// cookie signature — runs anywhere, and it is the half the acceptance criteria name: expiry and attempts are
// decided by checkCode() alone, with the clock passed in, so neither needs a database or a wait. The second
// half drives the real rows through a throwaway schema in whatever server DATABASE_URL points at, and skips
// when there is none, so `npm test` still works on a laptop with no Postgres up.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  channelPhrase,
  channelsFor,
  checkCode,
  CODE_MINT_WINDOW_MS,
  CODE_TTL_MS,
  codeLive,
  hashCode,
  MAX_CODE_ATTEMPTS,
  mintCode,
  needsVerification,
  newCode,
  readCookie,
  readSessionId,
  revokeSessions,
  SESSION_TTL_MS,
  sessionForRequest,
  sessionLive,
  signSessionId,
  startVerification,
  verifiedSession,
  verifyCode,
  type CodeRow,
} from "./patientSession";

const VISIT = "cvisit00000000000000000a";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** A pending row with a live code, as mintCode leaves one. */
const row = (over: Partial<CodeRow> = {}): CodeRow => ({
  codeHash: hashCode(VISIT, "123456"),
  codeExpiresAt: at(CODE_TTL_MS),
  verifiedAt: null,
  attempts: 0,
  ...over,
});

// ---------------------------------------------------------------------------------------------
// No database needed

describe("newCode", () => {
  it("is always six digits, and spreads over the whole range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = newCode();
      assert.match(code, /^\d{6}$/, `${code} is not six digits`);
      seen.add(code);
    }
    // 400 uniform draws from a million: a repeat is possible, a handful of distinct values is not.
    assert.ok(seen.size > 380, `only ${seen.size} distinct codes in 400 draws`);
  });
});

describe("hashCode", () => {
  it("is stable, and bound to the visit so a code cannot be replayed against another one", () => {
    assert.equal(hashCode(VISIT, "123456"), hashCode(VISIT, "123456"));
    assert.notEqual(hashCode(VISIT, "123456"), hashCode(VISIT, "123457"));
    assert.notEqual(hashCode(VISIT, "123456"), hashCode("cvisit00000000000000000b", "123456"));
  });

  it("never contains the code it hashes", () => {
    assert.ok(!hashCode(VISIT, "123456").includes("123456"));
  });
});

describe("checkCode: the ten-minute clock (§5.3)", () => {
  it("accepts the right code inside the window", () => {
    assert.deepEqual(checkCode(row(), VISIT, "123456", at(CODE_TTL_MS - 1)), { ok: true });
  });

  it("refuses it one millisecond after the window closes", () => {
    assert.deepEqual(checkCode(row(), VISIT, "123456", at(CODE_TTL_MS)), { ok: false, reason: "expired", remaining: 0 });
    assert.deepEqual(checkCode(row(), VISIT, "123456", at(CODE_TTL_MS + 60_000)), { ok: false, reason: "expired", remaining: 0 });
  });

  it("calls a row whose code was never minted no_code, not expired, so the screen offers a resend", () => {
    const pendingMint = row({ codeHash: "", codeExpiresAt: at(CODE_MINT_WINDOW_MS) });
    assert.deepEqual(checkCode(pendingMint, VISIT, "123456", NOW), { ok: false, reason: "no_code", remaining: 0 });
  });

  it("has nothing to check when nothing is pending, or when the session is already verified", () => {
    assert.deepEqual(checkCode(null, VISIT, "123456", NOW), { ok: false, reason: "no_code", remaining: 0 });
    assert.deepEqual(checkCode(row({ verifiedAt: NOW }), VISIT, "123456", NOW), { ok: false, reason: "no_code", remaining: 0 });
  });
});

describe("checkCode: three wrong attempts (§5.3)", () => {
  it("counts down the tries left, and never below zero", () => {
    assert.deepEqual(checkCode(row({ attempts: 0 }), VISIT, "000000", NOW), { ok: false, reason: "wrong", remaining: 2 });
    assert.deepEqual(checkCode(row({ attempts: 1 }), VISIT, "000000", NOW), { ok: false, reason: "wrong", remaining: 1 });
    assert.deepEqual(checkCode(row({ attempts: 2 }), VISIT, "000000", NOW), { ok: false, reason: "wrong", remaining: 0 });
  });

  it("is locked at the limit, whatever is typed next — the right code included", () => {
    const locked = row({ attempts: MAX_CODE_ATTEMPTS });
    assert.deepEqual(checkCode(locked, VISIT, "000000", NOW), { ok: false, reason: "locked", remaining: 0 });
    assert.deepEqual(checkCode(locked, VISIT, "123456", NOW), { ok: false, reason: "locked", remaining: 0 });
  });

  it("treats a malformed code as simply wrong, so guessing at the format costs an attempt", () => {
    for (const typed of ["", "12345", "1234567", "12 34 56", "abcdef", "０１２３４５"]) {
      assert.deepEqual(checkCode(row(), VISIT, typed, NOW), { ok: false, reason: "wrong", remaining: 2 }, `"${typed}"`);
    }
  });

  it("ignores whitespace around a code the patient pasted", () => {
    assert.deepEqual(checkCode(row(), VISIT, "  123456 ", NOW), { ok: true });
  });

  it("checks the attempt limit before the clock: a locked code does not become an expired one", () => {
    const both = row({ attempts: MAX_CODE_ATTEMPTS, codeExpiresAt: at(-1) });
    assert.equal((checkCode(both, VISIT, "123456", NOW) as { reason: string }).reason, "locked");
  });
});

describe("codeLive and sessionLive", () => {
  it("a code is live while it has time and tries and has not been used", () => {
    assert.equal(codeLive(row(), NOW), true);
    assert.equal(codeLive(row({ codeExpiresAt: at(-1) }), NOW), false);
    assert.equal(codeLive(row({ attempts: MAX_CODE_ATTEMPTS }), NOW), false);
    assert.equal(codeLive(row({ verifiedAt: NOW }), NOW), false);
    assert.equal(codeLive(null, NOW), false);
  });

  it("a session is a session for twenty-four hours after it is verified (§5.3)", () => {
    const verified = { verifiedAt: NOW, expiresAt: at(SESSION_TTL_MS) };
    assert.equal(sessionLive(verified, at(SESSION_TTL_MS - 1)), true);
    assert.equal(sessionLive(verified, at(SESSION_TTL_MS)), false);
    assert.equal(sessionLive({ verifiedAt: null, expiresAt: at(SESSION_TTL_MS) }, NOW), false, "a pending row is not a session");
    assert.equal(SESSION_TTL_MS, 24 * 60 * 60 * 1000);
  });
});

describe("the session cookie", () => {
  it("round-trips the session id it signs", () => {
    assert.equal(readSessionId(signSessionId("csession0000000000000001")), "csession0000000000000001");
  });

  it("refuses an id with no signature, a wrong signature, or someone else's", () => {
    assert.equal(readSessionId("csession0000000000000001"), null);
    assert.equal(readSessionId("csession0000000000000001.deadbeef"), null);
    assert.equal(readSessionId(""), null);
    assert.equal(readSessionId(null), null);
    // The signature covers the id, so swapping the id for another one invalidates it.
    const signed = signSessionId("csession0000000000000001");
    assert.equal(readSessionId(`csession0000000000000002.${signed.split(".")[1]}`), null);
  });

  it("reads one cookie out of a header without matching the others", () => {
    const header = "ss_csrf=abc; ss_patient=id.sig; authjs.session-token=zzz";
    assert.equal(readCookie(header, "ss_patient"), "id.sig");
    assert.equal(readCookie(header, "ss_csrf"), "abc");
    assert.equal(readCookie(header, "patient"), null, "a cookie name is not a substring match");
    assert.equal(readCookie(null, "ss_patient"), null);
  });
});

describe("channels", () => {
  it("is what there is to send to, and says so without saying the number (§2.3)", () => {
    assert.deepEqual(channelsFor({ phone: "+14155550100", email: "sam@example.test" }), ["sms", "email"]);
    assert.deepEqual(channelsFor({ phone: "+14155550100", email: null }), ["sms"]);
    assert.deepEqual(channelsFor({ phone: "  ", email: "sam@example.test" }), ["email"]);
    assert.deepEqual(channelsFor({}), []);
    assert.equal(channelPhrase(["sms"]), "your phone");
    assert.equal(channelPhrase(["sms", "email"]), "your phone and your email");
    assert.equal(channelPhrase([]), "your contact details");
    for (const phrase of [channelPhrase(["sms"]), channelPhrase(["sms", "email"])]) {
      assert.ok(!/\d/.test(phrase), `"${phrase}" should carry no digits`);
    }
  });
});

describe("needsVerification", () => {
  it("is every visit but the synthetic Dexcom sandbox one (§9.2)", () => {
    assert.equal(needsVerification({ isSandbox: false }), true);
    assert.equal(needsVerification({ isSandbox: true }), false);
  });
});

// ---------------------------------------------------------------------------------------------
// The rows themselves, against Postgres

const SERVER_URL = process.env.DATABASE_URL;
const schema = `pstest_${randomBytes(4).toString("hex")}`;

describe("verification against the database", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let visitId: string;

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(SERVER_URL!);
    url.searchParams.set("schema", schema);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: "pipe" });
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url.toString() });
  });

  after(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await db.patientSession.deleteMany({});
    await db.visit.deleteMany({});
    await db.patient.deleteMany({});
    await db.user.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const visit = await db.visit.create({
      data: {
        token: randomBytes(8).toString("base64url"),
        patient: { create: { practiceId: practice.id, name: "Fixture Patient", email: "fixture@example.test" } },
      },
    });
    visitId = visit.id;
  });

  /** Ask for a code and mint it, the way POST /api/verify and the notify.code job do between them. */
  async function issue(now = NOW): Promise<string> {
    await startVerification(visitId, {}, now, db);
    const code = await mintCode(visitId, now, db);
    assert.ok(code, "a pending row should have been there to mint for");
    return code!;
  }

  it("mints a code the right digits verify and the wrong ones do not", async () => {
    const code = await issue();
    const wrong = await verifyCode(visitId, code === "000000" ? "111111" : "000000", NOW, db);
    assert.deepEqual(wrong, { ok: false, reason: "wrong", remaining: 2 });
    const right = await verifyCode(visitId, code, NOW, db);
    assert.equal(right.ok, true);
    const stored = await db.patientSession.findFirst({ where: { visitId } });
    assert.ok(stored!.verifiedAt, "the row should be verified");
    assert.equal(stored!.expiresAt.getTime() - NOW.getTime(), SESSION_TTL_MS, "the session clock starts at verification");
  });

  it("stores only the hash, never the digits", async () => {
    const code = await issue();
    const stored = await db.patientSession.findFirst({ where: { visitId } });
    assert.ok(!stored!.codeHash.includes(code));
    assert.equal(stored!.codeHash, hashCode(visitId, code));
  });

  it("invalidates the code after three wrong attempts, so even the right one stops working (§5.3)", async () => {
    const code = await issue();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const outcome = await verifyCode(visitId, wrong, NOW, db);
      assert.deepEqual(outcome, { ok: false, reason: "wrong", remaining: MAX_CODE_ATTEMPTS - attempt }, `attempt ${attempt}`);
    }
    // The attempt that spends the last try is the one that invalidates the code, and says so rather than
    // inviting a fourth try that can only fail.
    assert.deepEqual(await verifyCode(visitId, wrong, NOW, db), { ok: false, reason: "locked", remaining: 0 });

    const after = await verifyCode(visitId, code, NOW, db);
    assert.deepEqual(after, { ok: false, reason: "locked", remaining: 0 });
    const stored = await db.patientSession.findFirst({ where: { visitId } });
    assert.equal(stored!.attempts, MAX_CODE_ATTEMPTS);
    assert.equal(stored!.codeHash, "", "the hash is dropped, so nothing can match it again");
    assert.equal(stored!.verifiedAt, null);
  });

  it("refuses a code that has aged past ten minutes", async () => {
    const code = await issue();
    assert.deepEqual(await verifyCode(visitId, code, at(CODE_TTL_MS + 1), db), { ok: false, reason: "expired", remaining: 0 });
  });

  it("reuses a live code on a reload, and replaces it on a resend", async () => {
    const code = await issue();
    const reload = await startVerification(visitId, {}, at(1000), db);
    assert.equal(reload.reused, true, "a reload must not invalidate the code in the patient's hand");
    assert.equal(await mintCode(visitId, at(1000), db) === code, false, "minting again is a new code");

    const resent = await startVerification(visitId, { resend: true }, at(2000), db);
    assert.equal(resent.reused, false);
    const fresh = await mintCode(visitId, at(2000), db);
    assert.deepEqual(await verifyCode(visitId, fresh!, at(2000), db), { ok: true, sessionId: resent.sessionId, expiresAt: at(2000 + SESSION_TTL_MS) });
    assert.equal(await db.patientSession.count({ where: { visitId } }), 1, "one pending row at a time");
  });

  it("leaves a code nobody can mint for once the hand-off window has passed", async () => {
    await startVerification(visitId, {}, NOW, db);
    // The route created the row and the job never ran. A reload after the window asks for a new one.
    assert.equal((await startVerification(visitId, {}, at(CODE_MINT_WINDOW_MS + 1), db)).reused, false);
    assert.equal((await startVerification(visitId, {}, at(CODE_MINT_WINDOW_MS - 1_000), db)).reused, true);
  });

  it("gives the browser a session for that visit and no other", async () => {
    const code = await issue();
    const outcome = await verifyCode(visitId, code, NOW, db);
    assert.equal(outcome.ok, true);
    const cookie = signSessionId((outcome as { sessionId: string }).sessionId);

    assert.ok(await verifiedSession(visitId, cookie, NOW, db));
    assert.equal(await verifiedSession("cvisit00000000000000000z", cookie, NOW, db), null, "bound to the visit (§4.5)");
    assert.equal(await verifiedSession(visitId, "forged.signature", NOW, db), null);
    assert.equal(await verifiedSession(visitId, null, NOW, db), null);
    assert.equal(await verifiedSession(visitId, cookie, at(SESSION_TTL_MS + 1), db), null, "24 hours and no more");

    // The shape a route sees: a Cookie header with the app's other cookies in it too.
    const req = { headers: { get: () => `ss_csrf=x; ss_patient=${cookie}` } };
    assert.ok(await sessionForRequest(req, visitId, NOW, db));
  });

  it("regenerating a link takes every session and pending code with it (§5.5)", async () => {
    const code = await issue();
    const outcome = await verifyCode(visitId, code, NOW, db);
    const cookie = signSessionId((outcome as { sessionId: string }).sessionId);
    assert.ok(await verifiedSession(visitId, cookie, NOW, db));

    assert.equal(await revokeSessions(visitId, db), 1);
    assert.equal(await verifiedSession(visitId, cookie, NOW, db), null, "the cookie is dead even though the browser still has it");
    assert.equal(await db.patientSession.count({ where: { visitId } }), 0);
  });

  it("has nothing to mint once the session is verified", async () => {
    const code = await issue();
    await verifyCode(visitId, code, NOW, db);
    assert.equal(await mintCode(visitId, NOW, db), null);
  });
});
