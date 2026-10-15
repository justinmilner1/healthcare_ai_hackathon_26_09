// Unit tests for the follow-up log (T18, design §7.5, §12.1).
//
// Two halves, the same split as lib/review.test.ts. The pure half checks what the next question is answered
// with. The second drives the real writes through a throwaway schema on whatever server DATABASE_URL points
// at, and skips when there is none — because every claim §7.5 makes is a claim about what the database holds
// afterwards (the clinician id is on the row, the answer lands on the question that asked for it, an outage
// leaves the question), and none of them can be asserted against a stub.
//
// The third describe block is §7.5's last three words, "never emailed": the templates §8.2 allows are
// rendered with a visit that has follow-ups on it, and neither message contains a word of them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { FORMER_COLLEAGUE } from "./review";
import {
  followUpsFor,
  historyFrom,
  HISTORY_TURNS,
  MAX_ANSWER_CHARS,
  MAX_FOLLOW_UPS,
  MAX_QUESTION_CHARS,
  recordAnswer,
  recordQuestion,
  renderHistory,
} from "./followUps";
import { summaryTemplates } from "./notify";
import type { FollowUp } from "./types";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const LATER = new Date("2026-10-15T12:00:30.000Z");

const entry = (n: number, answer: string | null): FollowUp => ({
  id: `f${n}`,
  at: new Date(NOW.getTime() + n * 1000).toISOString(),
  by: "u1",
  byName: "Dr. Rivera",
  question: `question ${n}`,
  answer,
});

describe("historyFrom: what the next question is answered with", () => {
  it("is the answered pairs, oldest first", () => {
    const history = historyFrom([entry(1, "answer 1"), entry(2, "answer 2")]);
    assert.deepEqual(history, [
      { q: "question 1", a: "answer 1" },
      { q: "question 2", a: "answer 2" },
    ]);
  });

  it("leaves out a question the gateway never answered: it has nothing to tell the model", () => {
    const history = historyFrom([entry(1, "answer 1"), entry(2, null), entry(3, "   ")]);
    assert.deepEqual(history, [{ q: "question 1", a: "answer 1" }]);
  });

  it("keeps the most recent turns and no more", () => {
    const many = Array.from({ length: HISTORY_TURNS + 4 }, (_, i) => entry(i + 1, `answer ${i + 1}`));
    const history = historyFrom(many);
    assert.equal(history.length, HISTORY_TURNS);
    assert.equal(history[0].q, `question ${5}`, "the oldest turns drop off the front");
    assert.equal(history.at(-1)?.q, `question ${HISTORY_TURNS + 4}`);
  });

  it("renders an empty history as something the model can read rather than a blank block", () => {
    assert.equal(renderHistory([]), "(none)");
    assert.equal(renderHistory([{ q: "why Tuesday?", a: "dinner out" }]), "Q: why Tuesday?\nA: dinner out");
  });
});

// ---------------------------------------------------------------------------------------------
// §7.5 "never emailed"

describe("follow-ups are never emailed (§7.5, §8.2)", () => {
  it("is not something the summary templates can carry: they take no follow-ups and send links only", () => {
    const templates = summaryTemplates({
      visit: { id: "v1", token: "tok_followups", apptAt: NOW },
      patient: { name: "Fixture Patient" },
      provider: { id: "u1", name: "Dr. Rivera" },
    });
    const secret = "why was Tuesday so high";
    for (const [audience, message] of Object.entries({ provider: templates.provider, patient: templates.patient })) {
      const text = `${message.subject}\n${message.text}`;
      assert.ok(!text.includes(secret), `${audience} email must not carry a follow-up question`);
      assert.ok(!/\bQ:|\bA:/.test(text), `${audience} email must not carry a follow-up exchange`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The writes themselves, against Postgres

const SERVER_URL = process.env.DATABASE_URL;
const schema = `futest_${randomBytes(4).toString("hex")}`;

describe("the follow-up log against the database", { skip: SERVER_URL ? false : "DATABASE_URL is not set" }, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let visitId: string;
  let otherVisitId: string;
  let clinician: { id: string; name: string | null; email: string };
  let colleague: { id: string; name: string | null; email: string };

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
    await db.followUp.deleteMany({});
    await db.visit.deleteMany({});
    await db.patient.deleteMany({});
    await db.user.deleteMany({});
    await db.practice.deleteMany({});
    const practice = await db.practice.create({ data: { name: "Fixture Endocrinology" } });
    clinician = await db.user.create({ data: { practiceId: practice.id, email: "rivera@example-endo.com", name: "Dr. Rivera", role: "clinician" } });
    colleague = await db.user.create({ data: { practiceId: practice.id, email: "okafor@example-endo.com", role: "clinician" } });
    const patient = await db.patient.create({ data: { practiceId: practice.id, name: "Fixture Patient", email: "fixture@example.test" } });
    const visit = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(8).toString("base64url"), status: "summary_ready" } });
    const other = await db.visit.create({ data: { patientId: patient.id, token: randomBytes(8).toString("base64url"), status: "summary_ready" } });
    visitId = visit.id;
    otherVisitId = other.id;
  });

  it("writes the question with the clinician id and the time, before any answer (§7.5)", async () => {
    const asked = await recordQuestion(visitId, clinician, "  why was Tuesday so high?  ", NOW, db);
    assert.equal(asked.question, "why was Tuesday so high?", "trimmed, because it is printed back");
    assert.equal(asked.by, clinician.id);
    assert.equal(asked.byName, "Dr. Rivera");
    assert.equal(asked.at, NOW.toISOString());
    assert.equal(asked.answer, null);

    const row = await db.followUp.findUniqueOrThrow({ where: { id: asked.id } });
    assert.equal(row.visitId, visitId);
    assert.equal(row.askedBy, clinician.id);
    assert.deepEqual(row.createdAt, NOW);
    assert.equal(row.answer, null, "the question is on the record before the model is asked (§6.2's rule)");
    assert.equal(row.answeredAt, null);
  });

  it("puts the answer on the row that asked for it", async () => {
    const first = await recordQuestion(visitId, clinician, "why was Tuesday so high?", NOW, db);
    const second = await recordQuestion(visitId, colleague, "and the overnight lows?", NOW, db);
    const answered = await recordAnswer(second.id, "  Two nights under 70 after late dinners.  ", colleague, LATER, db);

    assert.equal(answered?.id, second.id);
    assert.equal(answered?.answer, "Two nights under 70 after late dinners.");
    assert.equal(answered?.question, "and the overnight lows?");
    assert.equal(answered?.byName, "okafor@example-endo.com", "a clinician with no name is their address (§5.1)");

    const untouched = await db.followUp.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(untouched.answer, null, "two clinicians asking at once must not cross answers");
    const row = await db.followUp.findUniqueOrThrow({ where: { id: second.id } });
    assert.deepEqual(row.answeredAt, LATER);
  });

  it("answers nothing when the row is gone, rather than failing the reply (§10.5 mid-answer)", async () => {
    const asked = await recordQuestion(visitId, clinician, "why was Tuesday so high?", NOW, db);
    await db.followUp.delete({ where: { id: asked.id } });
    assert.equal(await recordAnswer(asked.id, "too late", clinician, LATER, db), null);
  });

  it("caps what it stores, so one question cannot be a payload", async () => {
    const asked = await recordQuestion(visitId, clinician, "q".repeat(MAX_QUESTION_CHARS + 500), NOW, db);
    assert.equal(asked.question.length, MAX_QUESTION_CHARS);
    const answered = await recordAnswer(asked.id, "a".repeat(MAX_ANSWER_CHARS + 500), clinician, LATER, db);
    assert.equal(answered?.answer?.length, MAX_ANSWER_CHARS);
  });

  it("reads one visit's log back oldest first, with the asker named (§7.5 'visible on the page')", async () => {
    const first = await recordQuestion(visitId, clinician, "first question", NOW, db);
    await recordAnswer(first.id, "first answer", clinician, LATER, db);
    await recordQuestion(visitId, colleague, "second question", LATER, db);
    await recordQuestion(otherVisitId, clinician, "another visit's question", NOW, db);

    const log = await followUpsFor(visitId, db);
    assert.deepEqual(
      log.map((f) => [f.question, f.answer, f.byName]),
      [
        ["first question", "first answer", "Dr. Rivera"],
        ["second question", null, "okafor@example-endo.com"],
      ],
      "this visit's questions only, in the order they were asked",
    );
  });

  it("names an asker whose account has since gone, rather than printing a blank", async () => {
    const asked = await recordQuestion(visitId, clinician, "who asked this?", NOW, db);
    await db.user.delete({ where: { id: clinician.id } });
    const log = await followUpsFor(visitId, db);
    assert.equal(log.length, 1);
    assert.equal(log[0].id, asked.id);
    assert.equal(log[0].by, clinician.id, "the id stays on the row: the record outlives the account");
    assert.equal(log[0].byName, FORMER_COLLEAGUE);
  });

  it("keeps the newest questions when a visit has more than the page shows", async () => {
    for (let i = 0; i < MAX_FOLLOW_UPS + 3; i++) {
      await recordQuestion(visitId, clinician, `question ${i}`, new Date(NOW.getTime() + i * 1000), db);
    }
    const log = await followUpsFor(visitId, db);
    assert.equal(log.length, MAX_FOLLOW_UPS);
    assert.equal(log[0].question, "question 3", "the oldest drop off, not the newest");
    assert.equal(log.at(-1)?.question, `question ${MAX_FOLLOW_UPS + 2}`);
  });

  it("goes with the visit: nothing survives the deletion §10.5 performs", async () => {
    await recordQuestion(visitId, clinician, "why was Tuesday so high?", NOW, db);
    await db.visit.delete({ where: { id: visitId } });
    assert.equal(await db.followUp.count({ where: { visitId } }), 0);
  });
});
