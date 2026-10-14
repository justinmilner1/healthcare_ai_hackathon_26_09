import assert from "node:assert/strict";
import test from "node:test";
import {
  addCounts,
  confirmsDeletion,
  DEFAULT_RETENTION_DAYS,
  DELETED_PATIENT_NAME,
  EMPTY_PURGE,
  isVisitExpired,
  removedSomething,
  retentionCutoff,
  visitRetentionAnchor,
  visitStoragePrefix,
} from "./retention";

// Design §2.8, §10.4 and §10.5: how long data is kept, which date decides that, and what a staff member has
// to type before any of it goes. The deleting itself is lib/retentionStore.test.ts, against a real database.

const NOW = new Date("2026-10-14T09:00:00.000Z");
const day = (iso: string) => new Date(iso);

test("the window is the practice's own, measured back from now", () => {
  assert.equal(retentionCutoff(365, NOW).toISOString(), "2025-10-14T09:00:00.000Z");
  assert.equal(retentionCutoff(30, NOW).toISOString(), "2026-09-14T09:00:00.000Z");
  assert.equal(retentionCutoff(3650, NOW).toISOString(), "2016-10-16T09:00:00.000Z", "ten years of days, which is two days short of ten calendar years");
});

test("a window that is not a whole positive number keeps data longer, never shorter", () => {
  // The settings form bounds this (lib/team.ts) and the column has a default, so a bad value means a row
  // somebody edited by hand. Deleting too early is the unrecoverable mistake, so the default is the fallback.
  const expected = retentionCutoff(DEFAULT_RETENTION_DAYS, NOW).toISOString();
  for (const bad of [null, undefined, 0, -30, 12.5, Number.NaN] as (number | null | undefined)[]) {
    assert.equal(retentionCutoff(bad, NOW).toISOString(), expected, `${bad} should fall back to the default`);
  }
  assert.equal(DEFAULT_RETENTION_DAYS, 365, "§10.4's default");
});

test("a visit's age is counted from the appointment, and only from createdAt when there is none", () => {
  // The data is about the week around the appointment, whenever the row happened to be made.
  assert.equal(
    visitRetentionAnchor({ scheduledAt: day("2026-03-02T10:00:00.000Z"), createdAt: day("2026-02-01T10:00:00.000Z") }).toISOString(),
    "2026-03-02T10:00:00.000Z",
  );
  assert.equal(
    visitRetentionAnchor({ scheduledAt: null, createdAt: day("2026-02-01T10:00:00.000Z") }).toISOString(),
    "2026-02-01T10:00:00.000Z",
  );
});

test("a visit is expired once its appointment is past the window", () => {
  const cutoff = retentionCutoff(365, NOW); // 2025-10-14
  const expired = { scheduledAt: day("2025-09-30T10:00:00.000Z"), createdAt: day("2025-09-01T10:00:00.000Z"), retentionSweptAt: null };
  const inside = { scheduledAt: day("2025-10-20T10:00:00.000Z"), createdAt: day("2025-09-01T10:00:00.000Z"), retentionSweptAt: null };
  assert.equal(isVisitExpired(expired, cutoff), true);
  assert.equal(isVisitExpired(inside, cutoff), false);
});

test("a visit booked far ahead is never expired, whatever its row's age says", () => {
  // The trap in using createdAt alone: a visit entered two years ago for an appointment next month would
  // have its data deleted before the clinician ever saw it.
  const cutoff = retentionCutoff(365, NOW);
  const booked = { scheduledAt: day("2026-11-20T10:00:00.000Z"), createdAt: day("2024-01-05T10:00:00.000Z"), retentionSweptAt: null };
  assert.equal(isVisitExpired(booked, cutoff), false);
});

test("an already-swept visit is never expired again, which is what keeps the sweep idempotent", () => {
  const cutoff = retentionCutoff(365, NOW);
  const swept = { scheduledAt: day("2020-01-01T10:00:00.000Z"), createdAt: day("2020-01-01T10:00:00.000Z"), retentionSweptAt: day("2026-10-13T03:00:00.000Z") };
  assert.equal(isVisitExpired(swept, cutoff), false);
});

test("a visit's stored bytes live under one prefix, which is what a deletion removes", () => {
  // The same shape lib/storage.ts newUploadKey writes: visits/<visitId>/<kind>/<uuid>.<ext>.
  assert.equal(visitStoragePrefix("cm2visitid0000000000000000"), "visits/cm2visitid0000000000000000/");
  assert.match(visitStoragePrefix("v1"), /\/$/, "it has to end at a path boundary or it matches a sibling visit");
});

// ---------------------------------------------------------------------------------------------
// §10.5 "with confirmation"

test("a deletion is confirmed by the patient's own name, loosely typed", () => {
  assert.equal(confirmsDeletion("Sam Sample", "Sam Sample"), true);
  assert.equal(confirmsDeletion("sam sample", "Sam Sample"), true, "case is not the point");
  assert.equal(confirmsDeletion("  Sam   Sample ", "Sam Sample"), true, "nor is whitespace");
});

test("nothing else confirms it: the mistake being guarded against is the wrong row", () => {
  for (const typed of ["", "   ", "Sam", "Sample", "Sam Samples", "yes", "DELETE", true, 1, null, undefined] as unknown[]) {
    assert.equal(confirmsDeletion(typed, "Sam Sample"), false, `${JSON.stringify(typed)} must not confirm`);
  }
});

test("the name a deleted patient's row keeps is nobody's name", () => {
  assert.equal(DELETED_PATIENT_NAME, "Deleted patient");
  // §4.3 keeps the row for the audit trail, so the row must not still confirm the deletion by matching it.
  assert.equal(confirmsDeletion("Sam Sample", DELETED_PATIENT_NAME), false);
});

// ---------------------------------------------------------------------------------------------
// What a purge reports

test("a purge that removed nothing is not a deletion and writes no row", () => {
  assert.equal(removedSomething(EMPTY_PURGE), false);
  assert.equal(removedSomething({ ...EMPTY_PURGE, orphans: 3 }), false, "bytes left behind are a failure, not a deletion");
  for (const field of ["visits", "uploads", "turns", "summaries", "objects"] as const) {
    assert.equal(removedSomething({ ...EMPTY_PURGE, [field]: 1 }), true, `${field} going is a deletion`);
  }
});

test("counts add up across the visits of one purge", () => {
  const a = { visits: 1, uploads: 2, turns: 3, summaries: 4, objects: 5, orphans: 6 };
  assert.deepEqual(addCounts(a, a), { visits: 2, uploads: 4, turns: 6, summaries: 8, objects: 10, orphans: 12 });
  assert.deepEqual(addCounts(a, EMPTY_PURGE), a);
});
