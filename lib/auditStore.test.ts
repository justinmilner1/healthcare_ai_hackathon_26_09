// Unit tests for the audit writers (T220, design §10.2, §10.7).
//
// lib/auditLog.ts holds the vocabulary, the PHI gate and the words the page prints, and
// lib/auditLog.test.ts covers them. This is the database half, and the claim here is the one only rows and
// a real clock can settle: **how long one row is allowed to stand for.**
//
// §10.2 asks "who read this visit and when", and read coalescing answers it with one row per group of
// identical reads (lib/auditStore.ts says why: §7.2's poll would otherwise write twenty). That answer is
// only as good as the bound on the group. `absorbed` used to find the row to count on by `at >= now -
// coalesceMs` and then move `at` to now, so the window was re-dated by every read it absorbed: a read
// arriving just inside the window absorbed for ever, and the row stood for a span of any length while the
// page called it a one-minute window. T220 bounds the lookup on `firstAt`, which no absorb rewrites.
//
// Two things about how these tests are written, both of them the ticket's own findings:
//
//   1. **Real waits, scaled.** `coalesceMs` is a parameter of the write, so the tests pass a window of a
//      few hundred milliseconds and sleep real fractions of it. Faking the clock does not reproduce the
//      bug at all — it is a bug about the relationship between two stored times — and a suite that advanced
//      a fake `Date.now()` would write N rows and read as proof of the opposite.
//   2. **Assertions on the bound, not on a row count.** A sleep can only overrun, never undershoot, so a
//      slow box turns reads that should coalesce into reads that do not: more rows, never fewer, and never
//      a longer span. Every assertion below is therefore either a ceiling (no row covers more than the
//      window) or a floor (at least this many rows, at least this many reads accounted for) in the
//      direction slowness cannot break. That is deliberate — docs/ROUTINES.md, "When the box is the
//      problem".
//
// lib/auditStore.ts reads the `db` singleton, so the fixture schema is adopted as DATABASE_URL and the
// module is pulled in afterwards with `await import` (lib/fixtures.ts says why); nothing here imports it
// statically.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { READ_COALESCE_MS } from "./auditLog";
import { fixtureSchema, SKIP_WITHOUT_DB, type FixtureSchema } from "./fixtures";
import { setLogSink } from "./log";

/** One scaled window for the sliding tests: long enough that a sleep of half of it is not noise, short
 *  enough that the whole suite is seconds rather than minutes. */
const WINDOW = 600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("lib/auditStore.ts", { skip: SKIP_WITHOUT_DB }, () => {
  let fx: FixtureSchema;
  let store: typeof import("./auditStore");
  let practiceId = "";

  before(async () => {
    fx = await fixtureSchema("auditstoretest", { useAsDefault: true });
    store = await import("./auditStore");
    // recordAudit swallows a write failure into a log line, so a broken write would otherwise be silent
    // here as well; the sink is captured in the one test that is about that.
    setLogSink(() => {});
  });

  after(async () => {
    setLogSink();
    await fx?.drop();
  });

  beforeEach(async () => {
    await fx.db.auditLog.deleteMany({});
    await fx.db.practice.deleteMany({});
    const practice = await fx.db.practice.create({ data: { name: "Fixture Endocrinology" } });
    practiceId = practice.id;
  });

  /** The write every test here repeats: one clinician reading one visit's summary. */
  const read = (over: Partial<Parameters<typeof store.recordAudit>[0]> = {}) =>
    store.recordAudit({
      practiceId,
      actorType: "user",
      actorId: "c0clinicianaaaaaaaaaaaaaa",
      action: "summary.read",
      entityType: "visit",
      entityId: "c0visitaaaaaaaaaaaaaaaaaa",
      detail: { part: "summary", role: "clinician" },
      coalesceMs: WINDOW,
      ...over,
    });

  const rows = () => fx.db.auditLog.findMany({ orderBy: { firstAt: "asc" } });
  const span = (row: { at: Date; firstAt: Date }) => row.at.getTime() - row.firstAt.getTime();
  const countOf = (row: { detail: string | null }) => {
    const parsed = row.detail ? (JSON.parse(row.detail) as { count?: number }) : {};
    return typeof parsed.count === "number" ? parsed.count : 1;
  };

  it("writes one row per read when nothing is coalesced, each standing for its own moment", async () => {
    await read({ coalesceMs: undefined });
    await read({ coalesceMs: undefined });
    const written = await rows();
    assert.equal(written.length, 2, "a write with no window is its own row");
    for (const row of written) {
      assert.equal(span(row), 0, "a row that stands for one event spans nothing");
      assert.equal(row.at.getTime(), row.firstAt.getTime(), "both ends of the span come from one clock reading");
      assert.equal(countOf(row), 1, "a row outside the coalescing rule carries no running count");
    }
  });

  it("counts identical reads inside the window on one row, keeping the time it began", async () => {
    await read();
    const [first] = await rows();
    await sleep(WINDOW / 4);
    await read();
    await read();

    const written = await rows();
    assert.equal(written.length, 1, `three reads inside ${WINDOW}ms are one row`);
    assert.equal(countOf(written[0]), 3);
    assert.equal(written[0].id, first.id, "the same row, not a replacement");
    // The point of `firstAt`: an absorb moves `at` and leaves the row's own beginning alone.
    assert.equal(written[0].firstAt.getTime(), first.firstAt.getTime(), "firstAt was rewritten by an absorb");
    assert.ok(written[0].at.getTime() > first.at.getTime(), "at did not move forward");
    assert.ok(span(written[0]) >= WINDOW / 4, "the row does not cover the gap between its first read and its last");
  });

  it("does not let the window slide, so no row stands for longer than it (T220 AC2, AC4)", async () => {
    // The ticket's reproduction, scaled: identical reads spaced at just under the window, for longer than
    // the window. Under the old rule every one of them absorbed into the first row — the cursor moved to
    // each read in turn — and that single row ended up standing for the whole elapsed span.
    const gap = Math.round(WINDOW * 0.6);
    const reads = 5;
    const began = Date.now();
    await read();
    for (let i = 1; i < reads; i++) {
      await sleep(gap);
      await read();
    }
    const elapsed = Date.now() - began;

    const written = await rows();
    assert.ok(elapsed > WINDOW, `the probe has to outlast the window to say anything: ${elapsed}ms over ${WINDOW}ms`);

    // The ceiling, which is the bound the audit page promises and the whole of this ticket.
    for (const row of written) {
      assert.ok(
        span(row) <= WINDOW,
        `a row covers ${span(row)}ms, more than the ${WINDOW}ms window the page calls it — the window slid`,
      );
    }
    // The floor: the old rule produced exactly one row here however long the probe ran. More than one row
    // is the only way the reads can be covered once the span of each is capped.
    assert.ok(written.length >= 2, `${reads} reads over ${elapsed}ms became ${written.length} row(s)`);
    // And nothing was lost in the splitting: every read is counted on exactly one row.
    assert.equal(
      written.reduce((sum, row) => sum + countOf(row), 0),
      reads,
      "the counts across the rows do not add up to the reads that happened",
    );
    // Each row begins after the one before it ends, so the rows are a partition of the reads in time and
    // not two overlapping accounts of the same ones.
    for (let i = 1; i < written.length; i++) {
      assert.ok(written[i].firstAt.getTime() >= written[i - 1].firstAt.getTime(), "rows are not in time order");
    }
  });

  it("a read arriving after the window gets its own row rather than reopening the last one", async () => {
    await read();
    await sleep(WINDOW + 150);
    await read();
    const written = await rows();
    assert.equal(written.length, 2, "a read outside the window is a new row");
    for (const row of written) assert.ok(span(row) <= WINDOW, `${span(row)}ms`);
    assert.equal(countOf(written[1]), 1, "the second row starts its own count at one");
  });

  it("a read whose circumstances differ is a second event, not a count on the first", async () => {
    await read();
    await read({ detail: { part: "intake", role: "clinician" } });
    const written = await rows();
    assert.equal(written.length, 2, "a different part of the visit is its own row");
    for (const row of written) assert.equal(countOf(row), 1);
  });

  it("the request id does not split a group, but a different actor does", async () => {
    // `requestId` is stripped before two details are compared (stripCount): every poll carries a new one,
    // and §7.2's twenty polls would otherwise be twenty rows — the thing coalescing exists to prevent.
    await read({ detail: { part: "summary", role: "clinician", requestId: "req_one" } });
    await read({ detail: { part: "summary", role: "clinician", requestId: "req_two" } });
    assert.equal((await rows()).length, 1);

    await read({ actorId: "c0otherclinicianaaaaaaaaa" });
    const written = await rows();
    assert.equal(written.length, 2, "a second colleague reading the same visit is a second row");
  });

  it("recordVisitRead writes one row per part, inside the store's own window", async () => {
    await store.recordVisitRead({
      practiceId,
      visitId: "c0visitaaaaaaaaaaaaaaaaaa",
      actor: { id: "c0clinicianaaaaaaaaaaaaaa", role: "clinician" },
      parts: ["intake", "summary"],
    });
    await store.recordVisitRead({
      practiceId,
      visitId: "c0visitaaaaaaaaaaaaaaaaaa",
      actor: { id: "c0clinicianaaaaaaaaaaaaaa", role: "clinician" },
      parts: ["intake", "summary"],
    });
    const written = await rows();
    assert.deepEqual(
      written.map((row) => row.action).sort(),
      ["intake.read", "summary.read"],
      "one row per part, and the second pass counted on them",
    );
    for (const row of written) {
      assert.equal(countOf(row), 2);
      // The real window, not the scaled one: this is the path the app actually takes.
      assert.ok(span(row) <= READ_COALESCE_MS, `${span(row)}ms over the store's own ${READ_COALESCE_MS}ms`);
    }
  });

  it("a verification is never coalesced, however fast two of them arrive", async () => {
    const visit = { id: "c0visitaaaaaaaaaaaaaaaaaa", patientId: "c0patientaaaaaaaaaaaaaaaa", patient: { practiceId } };
    await store.recordPatientVerified(visit);
    await store.recordPatientVerified(visit);
    const written = await rows();
    assert.equal(written.length, 2, "a second verification is a second browser and an admin wants to see it");
    for (const row of written) assert.equal(span(row), 0);
  });

  it("a failed write is a log line, not a failed request", async () => {
    // The file's first promise to its callers: the thing being recorded has already happened, so the record
    // going missing may not turn it into a 500. `practiceId` has a foreign key, so an unknown one is the
    // cheapest real write failure there is.
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    await store.recordAudit({
      practiceId: "c0nosuchpracticeaaaaaaaaa",
      actorType: "user",
      action: "summary.read",
      entityType: "visit",
    });
    setLogSink(() => {});
    assert.equal((await rows()).length, 0);
    assert.ok(
      lines.some((line) => (JSON.parse(line) as { event?: string }).event === "audit_write_failed"),
      JSON.stringify(lines),
    );
  });

  it("the listing carries both ends of the span to the page and the export", async () => {
    await read();
    await sleep(WINDOW / 4);
    await read();
    const listing = await store.auditListing(practiceId, { limit: 50 });
    assert.equal(listing.entries.length, 1);
    const [row] = listing.entries;
    // ISO strings, because this shape crosses JSON to the audit screen and into the CSV (§10.2).
    assert.match(row.firstAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.parse(row.at) > Date.parse(row.firstAt), "the listing flattened the span back to one time");
    assert.ok(Date.parse(row.at) - Date.parse(row.firstAt) <= WINDOW);
  });
});
