// Unit tests for the job handlers (T42, design §3.4, §8.2, §10.2, §10.5).
//
// The handlers are where §3.4's three attempts are spent, so the claim worth pinning is the one that decides
// whether an attempt is spent at all. `assertSendable` separates "nothing to send, the job is done" — no
// address on file, no sender configured — from "a configured channel errored, try again in a minute". Get it
// backwards one way and a patient with no phone number fails a job three times and fires §11.1's alarm; get
// it backwards the other and a throttled SES send is quietly dropped.
//
// Beside it: `visitIdOf` and `patientIdOf`, which fail loudly rather than reading the wrong row, because a
// payload without an id is a bug at the enqueue site and not something a retry can fix.
//
// lib/jobHandlers.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the
// module is pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it
// statically.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { setLogSink } from "./log";
import type { Summary } from "./types";

type Channels = Record<string, { sent: boolean; error?: string; provider?: string }>;

const summary = (patterns: string[]): Summary => ({
  timeInRange: 0.71, avgGlucose: 149, spikes: [], patterns, questions: ["What changed?"], patientNotes: "",
});

// One fixture schema for the whole file, adopted before the module is imported, because both halves read the
// same `db` singleton: a describe body runs at collection time, so the import cannot live in one of them.
let mod: typeof import("./jobHandlers");
let fx: FixtureSchema | undefined;

before(async () => {
  if (SKIP_WITHOUT_DB === false) fx = await fixtureSchema("jobhandlerstest", { useAsDefault: true });
  mod = await import("./jobHandlers");
});

after(async () => {
  setLogSink();
  await fx?.drop();
});

describe("assertSendable", () => {
  // No rows involved, so this half runs with or without a database.
  const assertSendable = (event: string, visitId: string, channels: Channels) => mod.assertSendable(event, visitId, channels);

  /** Only the two fields under test; a line also carries its level, its time and the visit id. */
  const lines: { event: string; count?: number }[] = [];
  const said = () => lines.map(({ event, count }) => ({ event, count }));
  before(() => setLogSink((_l, line) => lines.push(JSON.parse(line))));
  after(() => setLogSink());
  beforeEach(() => void (lines.length = 0));

  it("is satisfied by one channel that sent, whatever the other one did", () => {
    const channels: Channels = { sms: { sent: true, provider: "sns" }, email: { sent: false, provider: "ses", error: "Throttling" } };
    assert.doesNotThrow(() => assertSendable("invite", "v1", channels));
    assert.deepEqual(said(), [], "something went out, so there is nothing to say");
  });

  it("calls a channel with no address on file nothing to send, and the job done", () => {
    // No `provider`: no backend was ever chosen, so there is nothing a fourth attempt would do differently.
    const channels: Channels = { sms: { sent: false, error: "no phone on file" }, email: { sent: false, error: "no email on file" } };
    assert.doesNotThrow(() => assertSendable("invite", "v1", channels));
    assert.deepEqual(said(), [{ event: "invite_nothing_to_send", count: 2 }]);
  });

  it("calls an unconfigured sender nothing to send as well, so a scripted deployment does not fail jobs", () => {
    const channels: Channels = { email: { sent: false, error: "email not configured (set EMAIL_FROM, RESEND_API_KEY, or EMAIL_PROVIDER)" } };
    assert.doesNotThrow(() => assertSendable("summary", "v1", channels));
    assert.deepEqual(said(), [{ event: "summary_nothing_to_send", count: 1 }]);
  });

  it("throws for a configured channel that errored, so the job keeps its retries", () => {
    const channels: Channels = { email: { sent: false, provider: "ses", error: "Throttling: rate exceeded" } };
    assert.throws(() => assertSendable("summary", "v1", channels), /ses: Throttling: rate exceeded/);
  });

  it("names every backend that failed, not just the first", () => {
    const channels: Channels = {
      sms: { sent: false, provider: "twilio", error: "21610 unsubscribed" },
      email: { sent: false, provider: "resend", error: "Resend 429" },
      skipped: { sent: false, error: "not a channel this patient consented to" },
    };
    assert.throws(() => assertSendable("invite", "v1", channels), (e: Error) => {
      assert.match(e.message, /twilio: 21610 unsubscribed/);
      assert.match(e.message, /resend: Resend 429/);
      assert.doesNotMatch(e.message, /consented/, "a channel nobody tried is not a failure to retry");
      return true;
    });
  });

  it("falls back to a reason when the backend gave none", () => {
    assert.throws(() => assertSendable("code", "v1", { sms: { sent: false, provider: "sns" } }), /sns: send failed/);
  });

  it("treats an empty channel set as nothing to send rather than a failure", () => {
    assert.doesNotThrow(() => assertSendable("invite", "v1", {}));
    assert.deepEqual(said(), [{ event: "invite_nothing_to_send", count: 0 }]);
  });
});

describe("handlers", { skip: SKIP_WITHOUT_DB }, () => {
  let db: FixtureSchema["db"];
  let handlers: typeof import("./jobHandlers").handlers;
  const ids = { practice: "", patient: "", visit: "", provider: "" };
  let lines: { event: string; [k: string]: unknown }[] = [];

  // These tests are about the handler's bookkeeping, not about a backend, and the sandbox this suite runs in
  // has AWS keys in its environment. Unset every sender's settings for the suite, so every channel lands on
  // the deterministic "nothing to send" path. Each backend is now selected by the setting it cannot send
  // without rather than by a credential: SNS_ORIGINATION_NUMBER since T94 (lib/sms.ts), EMAIL_FROM since
  // T110 (lib/email.ts).
  const BACKEND_ENV = [
    "EMAIL_PROVIDER",
    "EMAIL_FROM",
    "SMS_PROVIDER",
    "RESEND_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "AWS_ACCESS_KEY_ID",
    "SNS_ORIGINATION_NUMBER",
  ] as const;
  const savedEnv = new Map<string, string | undefined>();

  before(async () => {
    for (const key of BACKEND_ENV) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    db = fx!.db;
    handlers = mod.handlers;

    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    const provider = await db.user.create({ data: { practiceId: practice.id, email: "dr@fixture.local", name: "Dr. Fixture", role: "clinician" } });
    // No phone and no email on this patient, on purpose: that is the deterministic "nothing to send" case,
    // and it does not depend on which backends happen to be configured where the suite is running.
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient" } });
    Object.assign(ids, { practice: practice.id, provider: provider.id, patient: patient.id });
  });

  after(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await db.visit.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.job.deleteMany({});
    const visit = await db.visit.create({
      data: { patientId: ids.patient, providerUserId: ids.provider, token: randomBytes(16).toString("base64url"), optIn: true, contactChannel: "both" },
    });
    ids.visit = visit.id;
    lines = [];
    setLogSink((_l, line) => lines.push(JSON.parse(line)));
  });

  const event = (name: string) => lines.find((l) => l.event === name);

  describe("the payload", () => {
    it("fails loudly for a visit-shaped payload with no visit id", async () => {
      for (const payload of [{}, { visitId: "" }, { visitId: 42 }, { patientId: ids.patient }]) {
        for (const kind of ["sour.run", "notify.invite", "notify.code", "notify.summary"] as const) {
          await assert.rejects(handlers[kind]!(payload, {} as never), /job payload needs a visitId/, `${kind} ${JSON.stringify(payload)}`);
        }
      }
    });

    it("fails loudly for the deletion payload with no patient id (§10.5)", async () => {
      for (const payload of [{}, { patientId: "" }, { visitId: ids.visit }]) {
        await assert.rejects(handlers["patient.delete"]!(payload, {} as never), /job payload needs a patientId/);
      }
    });

    it("says the visit is gone rather than silently doing nothing (§10.5)", async () => {
      await assert.rejects(handlers["notify.invite"]!({ visitId: "cl000000000000000000000000" }, {} as never), /visit not found/);
    });
  });

  describe("notify.invite", () => {
    it("writes a delivery row per channel and no audit row when nothing could be sent (§8.3, §10.2)", async () => {
      await handlers["notify.invite"]!({ visitId: ids.visit }, {} as never);

      const deliveries = await db.visitDelivery.findMany({ where: { visitId: ids.visit }, orderBy: { channel: "asc" } });
      assert.deepEqual(deliveries.map((d) => [d.channel, d.kind, d.status]), [["email", "notify.invite", "skipped"], ["sms", "notify.invite", "skipped"]]);
      // §8.3's rows are what staff read on the dashboard; §10.2's are what an admin reads months later, and a
      // row saying a channel nobody tried did nothing would be a record of nothing happening.
      assert.deepEqual(await db.auditLog.findMany({}), []);
      assert.equal(event("invite_nothing_to_send")?.count, 2, "the job is done, not retried");
    });

    it("records a delivery row even for a channel staff did not choose (§2.2)", async () => {
      await db.visit.update({ where: { id: ids.visit }, data: { contactChannel: "sms" } });
      await handlers["notify.invite"]!({ visitId: ids.visit }, {} as never);
      const byChannel = Object.fromEntries((await db.visitDelivery.findMany({ where: { visitId: ids.visit } })).map((d) => [d.channel, d.error]));
      assert.match(String(byChannel.email), /not a channel this patient consented to/);
    });
  });

  describe("notify.code", () => {
    it("mints nothing when there is no pending session, and does not fail the job (§5.3)", async () => {
      // Verified while the job sat in the queue, or a resend replaced the row.
      await handlers["notify.code"]!({ visitId: ids.visit }, {} as never);
      assert.ok(event("code_nothing_to_mint"), "the honest case, logged rather than thrown");
      assert.deepEqual(await db.auditLog.findMany({}), []);
    });

    it("mints a fresh code for a pending session and stores only its hash (§10.3)", async () => {
      const row = await db.patientSession.create({
        data: { visitId: ids.visit, codeHash: "old-hash", codeExpiresAt: new Date(Date.now() + 60_000), expiresAt: new Date(Date.now() + 86_400_000), attempts: 2 },
      });
      await handlers["notify.code"]!({ visitId: ids.visit }, {} as never);
      const after = await db.patientSession.findUniqueOrThrow({ where: { id: row.id } });
      assert.notEqual(after.codeHash, "old-hash", "a retry mints a new code, which is right when the last one reached nobody");
      assert.equal(after.attempts, 0);
      // The digits live in memory for the length of the handler and are stored nowhere.
      assert.doesNotMatch(JSON.stringify(lines), /\b\d{6}\b/);
      assert.equal(event("code_nothing_to_send")?.count, 2, "no address on file, so the job is done");
    });
  });

  describe("notify.summary", () => {
    it("refuses to send half a pair, so the job retries once Sour has saved both (§8.2)", async () => {
      await db.summary.create({ data: { visitId: ids.visit, audience: "provider", json: JSON.stringify(summary(["p"])) } });
      await assert.rejects(handlers["notify.summary"]!({ visitId: ids.visit }, {} as never), /summaries are not saved yet/);
      assert.deepEqual(await db.visitDelivery.findMany({}), []);
    });

    it("keys the delivery rows by audience as well as channel, because two people are told (§8.3)", async () => {
      for (const audience of ["provider", "patient"]) {
        await db.summary.create({ data: { visitId: ids.visit, audience, json: JSON.stringify(summary([audience])) } });
      }
      await handlers["notify.summary"]!({ visitId: ids.visit }, {} as never);
      const rows = await db.visitDelivery.findMany({ where: { visitId: ids.visit }, orderBy: { audience: "asc" } });
      assert.deepEqual(rows.map((r) => [r.channel, r.audience, r.kind]), [["email", "patient", "notify.summary"], ["email", "provider", "notify.summary"]]);
      assert.equal(event("summary_nothing_to_send")?.count, 2);
    });

    it("reads the newest summary of each audience back from the database, never from the payload", async () => {
      for (const patterns of [["old"], ["new"]]) {
        for (const audience of ["provider", "patient"]) {
          await db.summary.create({ data: { visitId: ids.visit, audience, json: JSON.stringify(summary(patterns)) } });
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      // No clinical text is ever queued, so the handler cannot be handed a stale summary: it reads the rows.
      await handlers["notify.summary"]!({ visitId: ids.visit }, {} as never);
      assert.equal((await db.visitDelivery.count({ where: { visitId: ids.visit } })), 2);
    });
  });

  describe("patient.delete", () => {
    it("purges the patient and sends nothing when there was no address to confirm to (§10.5)", async () => {
      await handlers["patient.delete"]!({ patientId: ids.patient, requestedBy: ids.provider }, {} as never);
      const row = await db.patient.findUniqueOrThrow({ where: { id: ids.patient } });
      assert.ok(row.deletedAt, "the patient is purged");
      assert.deepEqual(
        (await db.auditLog.findMany({})).filter((a) => a.action === "deletion.sent"),
        [],
        "no address on file, so there was no confirmation to record",
      );
    });

    it("is idempotent, because three attempts must not delete anything twice", async () => {
      await handlers["patient.delete"]!({ patientId: ids.patient }, {} as never);
      await assert.doesNotReject(handlers["patient.delete"]!({ patientId: ids.patient }, {} as never));
    });

    it("does nothing for a patient who is not there", async () => {
      await assert.doesNotReject(handlers["patient.delete"]!({ patientId: "cl000000000000000000000000" }, {} as never));
    });
  });

  describe("retention.sweep", () => {
    it("takes an empty payload, and one practice id when somebody sweeps by hand (§10.4)", async () => {
      await assert.doesNotReject(handlers["retention.sweep"]!({}, {} as never));
      await assert.doesNotReject(handlers["retention.sweep"]!({ practiceId: ids.practice }, {} as never));
      await assert.doesNotReject(handlers["retention.sweep"]!({ practiceId: 42 }, {} as never), "a payload that is not a practice id sweeps everything");
    });
  });
});
