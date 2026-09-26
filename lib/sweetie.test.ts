import assert from "node:assert/strict";
import test from "node:test";
import { answeredCount, emptyIntake, fieldsFor, greeting, nextTarget, parseIntake, renderNotes, SANDBOX_CONNECT_HELP, scripted, skipQuestions } from "./sweetie";

const visit = { visitType: "follow_up", reason: null };
const defs = fieldsFor(visit.visitType, visit.reason);
test("skipping questions preserves unanswered fields and persists across reloads", () => {
  const initial = emptyIntake(defs);
  const skipped = skipQuestions(initial);
  assert.equal(skipped.wrapped, true);
  assert.equal(skipped.questionsSkipped, true);
  assert.equal(answeredCount(skipped, defs), 0);
  assert.deepEqual(skipped.fields, initial.fields);
  assert.equal(initial.questionsSkipped, undefined);
  const restored = parseIntake(JSON.stringify(skipped), defs);
  assert.deepEqual(nextTarget(restored, defs), { kind: "wrap" });
  assert.match(renderNotes(restored, defs, visit), /Unanswered items were not assessed/);
});

test("skipping preserves existing answers, declined uploads, and safety flags", () => {
  const state = emptyIntake(defs);
  state.fields.purpose = { value: "Breakfast at home", confidence: "high" };
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

test("sandbox greeting preserves optional upload and first-question flow", () => {
  const demo = { ...visit, isSandbox: true };
  assert.match(greeting("Demo", "James", demo, defs, true), /readings are ready/);
  assert.match(greeting("Demo", "James", demo, defs, false), /optionally.*Connect Dexcom sandbox/);
  assert.match(greeting("Demo", "James", demo, defs, false), /fictional answers/);
});

test("sandbox fallback suppresses unavailable export instructions", () => {
  assert.equal(scripted({ firstName: "Demo", target: { kind: "field", def: defs[0] }, isSandbox: true, exportHelp: "timeline" }), defs[0].fallbackQuestion);
  assert.equal(scripted({ firstName: "Demo", target: { kind: "upload", which: "dexcom" }, isSandbox: true, exportHelp: null }), SANDBOX_CONNECT_HELP);
});

test("legacy intake still follows the normal question flow", () => {
  const state = parseIntake(null, defs);
  assert.deepEqual(nextTarget(state, defs), { kind: "field", def: defs[0] });
  assert.doesNotMatch(renderNotes(state, defs, visit), /skip remaining/);
});
