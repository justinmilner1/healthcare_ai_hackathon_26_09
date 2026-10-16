// Unit tests for the guards every provider route starts with (T42, design §5.2, §5.3, §2.3).
//
// §5.2 is one sentence — "a user never sees another practice's data" — and the guards are where it is either
// true or not. The claim worth pinning is the status code: another practice's visit is a 404 with the same
// body as a visit that never existed, because a 403 would confirm the visit exists, and told apart the two
// answers turn a visit id into an oracle for "is this patient seen at that clinic". The same for a colleague
// named by id.
//
// `requireProvider` and `requireCapability` are not here: `currentProvider` reads the Auth.js session through
// `next/headers`, which throws outside a request scope, so they are exercised by the e2e suite instead
// (e2e/auth.ts signs in for real). What they decide with once they have a provider is lib/access.ts, and
// lib/access.test.ts covers the role table.
//
// lib/guard.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the module is
// pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it statically.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { HttpError } from "./httpError";
import { setLogSink } from "./log";

/** A request carrying nothing but the cookie header a patient route reads (lib/patientSession.ts). */
const request = (cookie?: string) => new Request("http://localhost/api/sweetie", { headers: cookie ? { cookie } : {} });

describe("lib/guard.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let fx: FixtureSchema;
  let guard: typeof import("./guard");
  let patientSession: typeof import("./patientSession");

  /** Two practices, because every claim here is about the boundary between them. */
  const mine = { practiceId: "", provider: { id: "", email: "", name: null as string | null, role: "clinician", practiceId: "" }, visitId: "", colleagueId: "" };
  const theirs = { practiceId: "", visitId: "", userId: "" };

  before(async () => {
    fx = await fixtureSchema("guardtest", { useAsDefault: true });
    guard = await import("./guard");
    patientSession = await import("./patientSession");
    setLogSink(() => {});
    const db = fx.db;

    const a = await db.practice.create({ data: { name: "Mine Endocrinology" } });
    const me = await db.user.create({ data: { practiceId: a.id, email: "me@mine.local", name: "Dr. Mine", role: "clinician" } });
    const colleague = await db.user.create({ data: { practiceId: a.id, email: "colleague@mine.local", name: "Dr. Colleague", role: "staff" } });
    const myPatient = await db.patient.create({ data: { practiceId: a.id, name: "My Patient" } });
    const myVisit = await db.visit.create({ data: { patientId: myPatient.id, token: randomBytes(16).toString("base64url") } });
    mine.practiceId = a.id;
    mine.provider = { id: me.id, email: me.email, name: me.name, role: me.role, practiceId: me.practiceId };
    mine.visitId = myVisit.id;
    mine.colleagueId = colleague.id;

    const b = await db.practice.create({ data: { name: "Theirs Endocrinology" } });
    const them = await db.user.create({ data: { practiceId: b.id, email: "them@theirs.local", name: "Dr. Theirs", role: "admin" } });
    const theirPatient = await db.patient.create({ data: { practiceId: b.id, name: "Their Patient" } });
    const theirVisit = await db.visit.create({ data: { patientId: theirPatient.id, token: randomBytes(16).toString("base64url") } });
    theirs.practiceId = b.id;
    theirs.userId = them.id;
    theirs.visitId = theirVisit.id;
  });

  after(async () => {
    setLogSink();
    await fx?.drop();
  });

  /** The refusal a guard throws, checked as the caller and the log line see it (lib/httpError.ts). */
  const refusal = async (p: Promise<unknown>, status: number, message: string, event: string) => {
    let thrown: unknown;
    await assert.rejects(p, (e: unknown) => ((thrown = e), true));
    assert.ok(thrown instanceof HttpError, `expected an HttpError, got ${String(thrown)}`);
    assert.equal(thrown.status, status);
    assert.equal(thrown.message, message);
    assert.equal(thrown.event, event);
    return thrown;
  };

  describe("requireVisitInPractice", () => {
    it("returns this practice's visit, with the context a route needs", async () => {
      const visit = await guard.requireVisitInPractice(mine.visitId, mine.provider);
      assert.equal(visit.id, mine.visitId);
      assert.equal(visit.patient.practice.name, "Mine Endocrinology");
    });

    it("gives another practice's visit the same 404 as one that never existed (§5.2)", async () => {
      // Told apart, these two answers are an oracle for "is this patient seen at that clinic".
      const other = await refusal(guard.requireVisitInPractice(theirs.visitId, mine.provider), 404, "visit not found", "visit_not_in_practice");
      const absent = await refusal(guard.requireVisitInPractice("cl000000000000000000000000", mine.provider), 404, "visit not found", "visit_not_in_practice");
      assert.equal(other.message, absent.message, "the body cannot tell the two apart");
      assert.equal(other.fields.visitId, theirs.visitId, "which visit it was goes to the log, not to the caller");
      assert.equal(absent.fields.visitId, undefined);
    });

    it("refuses a missing id, and a patient id, the same way", async () => {
      for (const given of [undefined, null, ""]) {
        await refusal(guard.requireVisitInPractice(given, mine.provider), 404, "visit not found", "visit_not_in_practice");
      }
      await refusal(guard.requireVisitInPractice(mine.practiceId, mine.provider), 404, "visit not found", "visit_not_in_practice");
    });

    it("accepts the invite token as well, because findVisit does (§4.4)", async () => {
      const visit = await fx.db.visit.findUniqueOrThrow({ where: { id: mine.visitId } });
      assert.equal((await guard.requireVisitInPractice(visit.token, mine.provider)).id, mine.visitId);
    });
  });

  describe("requireMemberInPractice", () => {
    it("returns a colleague in the caller's practice", async () => {
      assert.equal((await guard.requireMemberInPractice(mine.colleagueId, mine.provider)).email, "colleague@mine.local");
      assert.equal((await guard.requireMemberInPractice(mine.provider.id, mine.provider)).id, mine.provider.id, "the caller is a member too");
    });

    it("gives another practice's user the same 404 as one that never existed", async () => {
      await refusal(guard.requireMemberInPractice(theirs.userId, mine.provider), 404, "user not found", "user_not_in_practice");
      await refusal(guard.requireMemberInPractice("cl000000000000000000000000", mine.provider), 404, "user not found", "user_not_in_practice");
      for (const given of [undefined, null, ""]) {
        await refusal(guard.requireMemberInPractice(given, mine.provider), 404, "user not found", "user_not_in_practice");
      }
    });

    it("says who was turned away in the log and nothing in the body", async () => {
      const e = await refusal(guard.requireMemberInPractice(theirs.userId, mine.provider), 404, "user not found", "user_not_in_practice");
      assert.equal(e.fields.practiceId, mine.practiceId);
      assert.equal(e.fields.userId, mine.provider.id, "the caller, not the user they asked about");
      assert.deepEqual(JSON.parse(await e.response().text()), { error: "user not found" });
    });
  });

  describe("requireVerifiedPatient", () => {
    let sessionId = "";

    beforeEach(async () => {
      await fx.db.patientSession.deleteMany({});
      const row = await fx.db.patientSession.create({
        data: {
          visitId: mine.visitId,
          codeHash: "spent",
          codeExpiresAt: new Date(Date.now() - 60_000),
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + patientSession.SESSION_TTL_MS),
        },
      });
      sessionId = row.id;
    });

    const visit = () => ({ id: mine.visitId, isSandbox: false });

    it("lets a browser that has verified this visit's link through (§2.3)", async () => {
      const cookie = `${patientSession.PATIENT_SESSION_COOKIE}=${patientSession.signSessionId(sessionId)}`;
      await assert.doesNotReject(guard.requireVerifiedPatient(request(cookie), visit()));
    });

    it("refuses a forwarded link: the token names the visit, the code opens it (§5.3)", async () => {
      // A 401 and not a 404, because the caller already holds the token — what is being kept from them is the
      // visit behind it — and the message has to say what to do about that.
      const e = await refusal(guard.requireVerifiedPatient(request(), visit()), 401, "Verify your link before continuing: open it again and type the code we text or email you.", "patient_unverified");
      assert.equal(e.fields.visitId, mine.visitId);
    });

    it("refuses an unsigned, a mis-signed, and another visit's session", async () => {
      const name = patientSession.PATIENT_SESSION_COOKIE;
      const otherRow = await fx.db.patientSession.create({
        data: { visitId: theirs.visitId, codeHash: "x", codeExpiresAt: new Date(), verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
      });
      const cookies = [
        `${name}=${sessionId}`,
        `${name}=${sessionId}.deadbeef`,
        `${name}=${patientSession.signSessionId(otherRow.id)}`,
      ];
      for (const cookie of cookies) {
        await refusal(guard.requireVerifiedPatient(request(cookie), visit()), 401, "Verify your link before continuing: open it again and type the code we text or email you.", "patient_unverified");
      }
    });

    it("refuses a session that has run out", async () => {
      await fx.db.patientSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const cookie = `${patientSession.PATIENT_SESSION_COOKIE}=${patientSession.signSessionId(sessionId)}`;
      await refusal(guard.requireVerifiedPatient(request(cookie), visit()), 401, "Verify your link before continuing: open it again and type the code we text or email you.", "patient_unverified");
    });

    it("needs no session for the sandbox demonstration, which has nobody to text a code to (§9.2)", async () => {
      await assert.doesNotReject(guard.requireVerifiedPatient(request(), { id: mine.visitId, isSandbox: true }));
    });
  });
});
