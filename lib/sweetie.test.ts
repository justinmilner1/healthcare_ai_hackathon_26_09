import assert from "node:assert/strict";
import test from "node:test";
import { answeredCount, emptyIntake, fieldsFor, nextTarget, parseIntake, renderNotes, skipQuestions } from "./sweetie";

const visit = { visitType: "follow_up", reason: null };
const defs = fieldsFor(visit.visitType, visit.reason);
const noUploads = { hasDexcom: false, hasLocation: false, hasWhoop: false };

test("skipping questions preserves unanswered fields and persists across reloads", () => {
  const initial = emptyIntake(defs);
  const skipped = skipQuestions(initial);
  assert.equal(skipped.wrapped, true);
  assert.equal(skipped.questionsSkipped, true);
  assert.equal(answeredCount(skipped, defs), 0);
  assert.deepEqual(skipped.fields, initial.fields);
  assert.equal(initial.questionsSkipped, undefined);
  const restored = parseIntake(JSON.stringify(skipped), defs);
  assert.deepEqual(nextTarget(restored, defs, noUploads), { kind: "wrap" });
  assert.match(renderNotes(restored, defs, visit), /Unanswered items were not assessed/);
});

test("skipping preserves existing answers, declined uploads, and safety flags", () => {
  const state = emptyIntake(defs);
  state.fields.meals = { value: "Breakfast at home", confidence: "high" };
  state.skipped = ["whoop"];
  state.flagged = "severe_hypo";
  state.turns = 3;
  const skipped = skipQuestions(state);
  assert.equal(answeredCount(skipped, defs), 1);
  assert.equal(skipped.flagged, "severe_hypo");
  assert.equal(skipped.turns, 3);
  assert.deepEqual(skipped.skipped, ["whoop"]);
  assert.deepEqual(skipQuestions(skipped), skipped);
  const notes = renderNotes(skipped, defs, visit);
  assert.match(notes, /Safety flag/);
  assert.match(notes, /Breakfast at home/);
});

test("legacy intake still follows the normal question flow", () => {
  const state = parseIntake(null, defs);
  assert.deepEqual(nextTarget(state, defs, noUploads), { kind: "upload", which: "dexcom" });
  assert.equal(nextTarget(state, defs, { ...noUploads, hasDexcom: true, hasLocation: true }).kind, "field");
  assert.doesNotMatch(renderNotes(state, defs, visit), /skip remaining/);
});
