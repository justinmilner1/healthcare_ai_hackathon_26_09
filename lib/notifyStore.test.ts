// Unit tests for writing down what SES and SNS told us (T19, design §8.1, §8.3), against a real fixture
// database — the same throwaway-schema pattern as lib/retentionStore.test.ts, skipped when there is no
// DATABASE_URL so `npm test` still works on a laptop with no server up.
//
// A real database rather than a stub, for the reasons a stub would get wrong: that a repeated notification is
// a no-op (AWS posts the same bounce more than once), that a complaint can overwrite a bounce but not the
// other way round, and that the delivery row is found by the provider's own message id and nothing else.
//
// The audit writer is injected, because the rows written are part of what §8.1 promises and with the live
// module they would go to a schema this test cannot read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import type { AuditWrite } from "./auditStore";
import { setLogSink } from "./log";
import { applyNotificationEvents } from "./notifyStore";
import type { NotificationEvent } from "./snsEvents";

const SERVER_URL = process.env.DATABASE_URL;
const schema = `notifytest_${randomBytes(4).toString("hex")}`;

const fixtureUrl = (base: string) => {
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  return url.toString();
};

const NOW = new Date("2026-10-15T09:00:00.000Z");
const EARLIER = new Date("2026-10-08T09:00:00.000Z");

const bounce = (email: string, messageId: string | null = null): NotificationEvent => ({
  kind: "email.bounce",
  emails: [email],
  providerMessageId: messageId,
  code: "Permanent/General",
});

describe("notification events", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let practiceId: string;
  let rows: AuditWrite[];

  const deps = () => ({ client: db, now: NOW, audit: async (entry: AuditWrite) => void rows.push(entry) });

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: SERVER_URL });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const url = fixtureUrl(SERVER_URL!);
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    } catch (e) {
      const out = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`prisma migrate deploy failed for the fixture schema:\n${out.stdout ?? ""}${out.stderr ?? ""}`);
    }
    db = new PrismaClient({ datasourceUrl: url });
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    rows = [];
    await db.patient.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    practiceId = practice.id;
  });

  /** A patient with a visit and one `sent` delivery row for their invite, as a real send leaves behind. */
  async function seedPatient(opts: { email?: string | null; phone?: string | null; messageId?: string } = {}) {
    const patient = await db.patient.create({
      data: { practiceId, name: "Sam Sample", email: opts.email ?? "sam@example.com", phone: opts.phone ?? "+14155550100" },
    });
    const visit = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(8).toString("hex") } });
    await db.visitDelivery.create({
      data: {
        visitId: visit.id,
        kind: "notify.invite",
        channel: "email",
        audience: "patient",
        status: "sent",
        providerName: "ses",
        providerMessageId: opts.messageId ?? "0100018b-ses",
        at: EARLIER,
      },
    });
    return { patient, visit };
  }

  it("marks a bounced address undeliverable and restates the delivery row", async () => {
    const { patient, visit } = await seedPatient();
    const report = await applyNotificationEvents([bounce("sam@example.com", "0100018b-ses")], deps());

    assert.deepEqual(report, { applied: 1, patients: 1, deliveries: 1, unmatched: 0 });
    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    assert.deepEqual(after.emailUndeliverableAt, NOW);
    assert.equal(after.emailUndeliverableReason, "bounce");
    assert.equal(after.smsOptOutAt, null, "a bounced address says nothing about their phone");

    const delivery = await db.visitDelivery.findFirstOrThrow({ where: { visitId: visit.id } });
    assert.equal(delivery.status, "bounced");
    assert.equal(delivery.error, "Permanent/General");

    assert.deepEqual(rows, [
      { practiceId, actorType: "system", action: "contact.suppressed", entityType: "patient", entityId: patient.id, detail: { channel: "email", code: "bounce" } },
    ]);
  });

  it("is silent the second time AWS posts the same bounce", async () => {
    const { patient } = await seedPatient();
    await applyNotificationEvents([bounce("sam@example.com", "0100018b-ses")], deps());
    rows = [];
    const again = await applyNotificationEvents([bounce("sam@example.com", "0100018b-ses")], { ...deps(), now: new Date("2026-10-16T09:00:00.000Z") });

    assert.equal(again.patients, 0, "nothing changed, so nothing is reported as changed");
    assert.deepEqual(rows, [], "and no second audit row");
    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    assert.deepEqual(after.emailUndeliverableAt, NOW, "the date is when the address broke, not when we last heard");
  });

  it("lets a complaint overwrite a bounce, because it is the stronger fact", async () => {
    const { patient } = await seedPatient();
    await applyNotificationEvents([bounce("sam@example.com")], deps());
    await applyNotificationEvents(
      [{ kind: "email.complaint", emails: ["sam@example.com"], providerMessageId: null, code: "abuse" }],
      deps(),
    );
    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    assert.equal(after.emailUndeliverableReason, "complaint");
  });

  it("does not let a later bounce downgrade a complaint", async () => {
    const { patient } = await seedPatient();
    await applyNotificationEvents([{ kind: "email.complaint", emails: ["sam@example.com"], providerMessageId: null, code: "abuse" }], deps());
    await applyNotificationEvents([bounce("sam@example.com")], deps());
    const after = await db.patient.findUniqueOrThrow({ where: { id: patient.id } });
    assert.equal(after.emailUndeliverableReason, "complaint", "they asked us to stop; a bounce does not unask it");
  });

  it("counts an address belonging to nobody here as unmatched, and writes nothing", async () => {
    await seedPatient();
    const report = await applyNotificationEvents([bounce("stranger@example.com", "0100018b-ses")], deps());
    assert.deepEqual(report, { applied: 1, patients: 0, deliveries: 1, unmatched: 1 });
    assert.deepEqual(rows, []);
  });

  it("leaves a deleted patient alone", async () => {
    // §10.5 scrubbed the row and kept it for the audit record. A bounce for the address it used to have must
    // not write anything back onto it.
    const { patient } = await seedPatient();
    await db.patient.update({ where: { id: patient.id }, data: { deletedAt: NOW } });
    const report = await applyNotificationEvents([bounce("sam@example.com")], deps());
    assert.equal(report.patients, 0);
    assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).emailUndeliverableAt, null);
  });

  it("records a STOP against the number that sent it, as the patient's own action", async () => {
    const { patient } = await seedPatient();
    const report = await applyNotificationEvents([{ kind: "sms.optout", phone: "+14155550100" }], deps());
    assert.equal(report.patients, 1);
    assert.deepEqual((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).smsOptOutAt, NOW);
    // actorType `patient`, not `system`: a person did this, and §4.8's audit page should say so.
    assert.equal(rows[0].actorType, "patient");
    assert.deepEqual(rows[0].detail, { channel: "sms", code: "stop" });
  });

  it("clears the opt-out when they text START, and records that too", async () => {
    const { patient } = await seedPatient();
    await applyNotificationEvents([{ kind: "sms.optout", phone: "+14155550100" }], deps());
    rows = [];
    const report = await applyNotificationEvents([{ kind: "sms.optin", phone: "+14155550100" }], deps());
    assert.equal(report.patients, 1);
    assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).smsOptOutAt, null);
    assert.equal(rows[0].action, "contact.resumed");
  });

  it("is silent when START arrives from a number that never stopped", async () => {
    await seedPatient();
    const report = await applyNotificationEvents([{ kind: "sms.optin", phone: "+14155550100" }], deps());
    assert.equal(report.patients, 0);
    assert.deepEqual(rows, []);
  });

  it("restates a delivery row SES later confirms, and ignores one it cannot key", async () => {
    const { visit } = await seedPatient({ messageId: "0100018b-ses" });
    await applyNotificationEvents([{ kind: "email.delivered", emails: ["sam@example.com"], providerMessageId: "0100018b-ses" }], deps());
    const delivery = await db.visitDelivery.findFirstOrThrow({ where: { visitId: visit.id } });
    assert.equal(delivery.status, "sent");
    assert.equal(delivery.error, null);
    // A bounce for a visit that has since been deleted (§10.4, §10.5) has nothing to restate, and that is
    // not a failure: AWS would only post it again.
    const report = await applyNotificationEvents([bounce("sam@example.com", "a-message-nobody-has")], deps());
    assert.equal(report.deliveries, 0);
  });

  it("applies every event in one notification, including one about several recipients", async () => {
    const first = await seedPatient({ email: "one@example.com" });
    const second = await seedPatient({ email: "two@example.com", phone: "+14155550199" });
    const report = await applyNotificationEvents(
      [{ kind: "email.bounce", emails: ["one@example.com", "two@example.com"], providerMessageId: null, code: "Permanent/NoEmail" }],
      deps(),
    );
    assert.equal(report.patients, 2);
    for (const { patient } of [first, second]) {
      assert.deepEqual((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).emailUndeliverableAt, NOW);
    }
  });

  it("says nothing about a carrier failure beyond the log, because a number is not an address", async () => {
    const { patient } = await seedPatient();
    const report = await applyNotificationEvents([{ kind: "sms.failed", phone: "+14155550100", code: "carrier_failure" }], deps());
    assert.deepEqual(report, { applied: 1, patients: 0, deliveries: 0, unmatched: 0 });
    assert.equal((await db.patient.findUniqueOrThrow({ where: { id: patient.id } })).smsOptOutAt, null);
  });
});
