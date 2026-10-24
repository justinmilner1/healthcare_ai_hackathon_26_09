import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { answeredCount, backstop, emptyIntake, fieldsFor, flaggedHoldReply, greeting, knownVisitType, merge, nextTarget, parseIntake, redFlagReply, renderNotes, requiredCount, SANDBOX_CONNECT_HELP, scanRedFlags, scripted, skipQuestions, speakSystem, VISIT_TYPES } from "./sweetie";
import type { Target } from "./sweetie";
import type { IntakeStatus } from "./types";

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

test("the opening nudge names the upload button instead of placing it", () => {
  // §6.5: at 375px the Dexcom, Timeline and WHOOP controls sit above the conversation, so any opener that
  // says "on the left" points a phone patient at nothing.
  const opener = greeting("Ada", "James", visit, defs, false);
  assert.match(opener, /The Dexcom, Timeline and WHOOP buttons are optional/);
  for (const placement of [/on the left/, /to the left/, /on the right/, /below/, /above/]) {
    assert.doesNotMatch(opener, placement);
  }
  // With glucose already in there is nothing to point at, and the opener still carries the first question.
  const withData = greeting("Ada", "James", visit, defs, true);
  assert.match(withData, /glucose data is already in/);
  assert.doesNotMatch(withData, /button/);
  for (const text of [opener, withData]) {
    assert.match(text, /I'm Sweetie/);
    assert.ok(text.endsWith(defs[0].fallbackQuestion));
  }
});

test("the opening message carries everything §2.5 and §6.6 promise, in one bubble", () => {
  // T105: the opener is the whole of what a patient is told before they say anything, so the four things
  // §2.5 and §6.6 rest on are asserted rather than left to whoever next shortens it. The practice's name is
  // here too: nothing else on this screen prints it (app/s/[token]/page.tsx), and it is the one thing in
  // §2.3's invite that says who is asking.
  const opener = greeting("Ada", "James", visit, defs, false);
  for (const promise of [/Dexcom/, /Timeline/, /WHOOP/, /optional/, /Two questions/, /talk or type/, /James/]) {
    assert.match(opener, promise);
  }
  assert.ok(opener.endsWith(defs[0].fallbackQuestion));
});

test("the opening message fits the 251px transcript §6.5 leaves it on a 375px phone", () => {
  // T105, design §6.5. The gate the ticket was filed for lives in e2e/mobile.spec.ts, where the real
  // transcript is measured in a real browser; this is the same budget in characters, so a rewrite that
  // overflows it fails in a second here rather than in twenty minutes there.
  //
  // The arithmetic, all of it from app/globals.css's 375px block and the T105 measurement: the region is
  // 251px with 15px of padding top and bottom, and a bubble is 9px of padding top and bottom, 1px of
  // border, and 20.15px per line (13px at line-height 1.55). So the message has (251 - 30 - 20) / 20.15 =
  // 10.9, say 10, lines. One line holds about 35 characters: the opener this replaced measured 302px, which
  // is 14 lines, for 490 characters.
  const LINES = 10;
  const PER_LINE = 35;
  const cases: [string, string][] = [
    // The three shapes the product ships: the seeded demo's reason (scripts/seed.ts), a booked visit with a
    // short reason (e2e/mobile.spec.ts), and a visit booked without one.
    ["the seeded demo", "my numbers keep going high overnight and I don't know why"],
    ["a short reason", "mornings running high"],
    ["no reason", ""],
  ];
  for (const [name, reason] of cases) {
    const fields = fieldsFor("follow_up", reason);
    for (const hasDexcom of [false, true]) {
      const text = greeting("Sam", "Dr. Demo Endo", { visitType: "follow_up", reason }, fields, hasDexcom);
      const lines = Math.ceil(text.length / PER_LINE);
      assert.ok(
        lines <= LINES,
        `the opener for ${name}${hasDexcom ? " with glucose in" : ""} is about ${lines} lines of a ${LINES}-line transcript (${text.length} characters): ${text}`,
      );
    }
  }

  // And the fourth shape, which is a different sentence and so a different length: the Dexcom sandbox
  // demonstration (app/api/dexcom/demo/route.ts). Its visit has no type and `lib/bundle.ts` hands
  // `fieldsFor` a null reason for it, so the first question is the short one — but the demo is also the
  // screen that carries the sandbox card, which is the 251px this budget is written for.
  const demoFields = fieldsFor(null, null);
  for (const hasDexcom of [false, true]) {
    const text = greeting("Dexcom", "Dr. Demo Endo", { visitType: null, reason: null, isSandbox: true }, demoFields, hasDexcom);
    const lines = Math.ceil(text.length / PER_LINE);
    assert.ok(
      lines <= LINES,
      `the sandbox opener${hasDexcom ? " with readings in" : ""} is about ${lines} lines of a ${LINES}-line transcript (${text.length} characters): ${text}`,
    );
  }
});

test("the sandbox opener says what the demo can and cannot do, and asks the first question", () => {
  const demo = { ...visit, isSandbox: true };
  const ready = greeting("Demo", "James", demo, defs, true);
  const empty = greeting("Demo", "James", demo, defs, false);
  assert.match(ready, /readings are ready/);
  assert.match(empty, /optionally.*Connect Dexcom sandbox/);
  for (const text of [ready, empty]) {
    assert.match(text, /No Timeline or WHOOP uploads are needed/);
    assert.match(text, /fictional answers/);
    assert.ok(text.endsWith(defs[0].fallbackQuestion));
  }
});

test("the scripted upload offer names its button and places nothing", () => {
  const dexcom = scripted({ firstName: "Ada", target: { kind: "upload", which: "dexcom" }, exportHelp: null });
  assert.match(dexcom, /the Dexcom button/);
  const timeline = scripted({ firstName: "Ada", target: { kind: "upload", which: "timeline" }, exportHelp: null });
  assert.match(timeline, /the Timeline button/);
  for (const text of [dexcom, timeline]) assert.doesNotMatch(text, /on the left|to the left|on the right/);
});

const NOTHING_SHARED: IntakeStatus = { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 0, done: false };

/** `speakSystem`'s input for a turn aimed at `target`, with nothing shared and no file just arrived. */
function promptFor(target: Target) {
  return speakSystem({ firstName: "Ada", providerName: "James", visit, state: emptyIntake(defs), defs, status: NOTHING_SHARED, target, exportHelp: null });
}

const UPLOADS: Target[] = [
  { kind: "upload", which: "dexcom" },
  { kind: "upload", which: "timeline" },
  { kind: "upload", which: "whoop" },
];

test("no upload offer promises a span, scripted or in the prompt (T139, §2.5)", () => {
  // The offer runs before a file exists, so nothing on the turn knows the span: `parseClarityCsv` keeps
  // every EGV row it is handed (data/fixtures/clarity_window.csv is 84 readings inside one morning), and
  // `lib/whoop.ts` and `lib/location.ts` clip nothing either. Both halves said "the week in numbers" and a
  // patient who answered yes with one morning got "YOUR DAY WITH SWEETIE" over a HISTORY tile reading
  // "1 day". §6.3 is why the scripted line is held to the same rule rather than treated as a fallback:
  // without `OPENAI_API_KEY` it is what the check script, the demo and every offline deployment say.
  const spans = [/\bweek\b/i, /\b7 days\b/i, /\bseven days\b/i, /\blast \d+ days\b/i, /\bfortnight\b/i];
  for (const target of UPLOADS) {
    const said = scripted({ firstName: "Ada", target, exportHelp: null });
    const prompt = promptFor(target);
    for (const span of spans) {
      assert.doesNotMatch(said, span, `the scripted ${target.kind === "upload" ? target.which : ""} offer names a span: ${said}`);
      assert.doesNotMatch(prompt, span, `the prompt's ${target.kind === "upload" ? target.which : ""} goal names a span`);
    }
  }
  // And the two sentences still say what the upload buys, in the words T123 and T132 settled on, so this
  // passes by naming the readings rather than by saying nothing at all.
  assert.match(scripted({ firstName: "Ada", target: UPLOADS[0], exportHelp: null }), /see your glucose readings/);
  assert.match(promptFor(UPLOADS[0]), /see their glucose readings/);
});

test("the Dexcom offer still reads as optional and still names its control (T139)", () => {
  // The span is the only thing T139 took out. §2.5 makes the upload optional and the system prompt's own
  // rule makes it a name rather than a position, so both have to survive the reword.
  const said = scripted({ firstName: "Ada", target: UPLOADS[0], exportHelp: null });
  const prompt = promptFor(UPLOADS[0]);
  assert.match(said, /optional/i);
  assert.match(said, /fine to skip/i);
  assert.match(said, /the Dexcom button/);
  assert.match(prompt, /optional Dexcom button/);
  assert.match(prompt, /it is optional and a no is completely fine/);
});

test("the wrap-up's Dexcom clause names no span either, and still offers the button (T139)", () => {
  // Out of scope for T139 as a change and in scope as a check: this clause already named none, and the
  // sweep that took the span out of the offer above must not have put one here.
  const wrap = promptFor({ kind: "wrap" });
  assert.match(wrap, /optional Dexcom button on this page, and that it is fine not to/);
  for (const span of [/\bweek\b/i, /\b7 days\b/i, /\bseven days\b/i]) assert.doesNotMatch(wrap, span);
  // With glucose already in there is nothing to offer, so the clause is absent rather than reworded.
  const shared = speakSystem({ firstName: "Ada", providerName: "James", visit, state: emptyIntake(defs), defs, status: { ...NOTHING_SHARED, hasDexcom: true }, target: { kind: "wrap" }, exportHelp: null });
  assert.doesNotMatch(shared, /Dexcom export handy/);
});

test("the prompt's own §6.5 rule reaches the model, not just the module (T139)", () => {
  // lib/sweetie.test.ts's source read below catches a placement written anywhere in the file; this is the
  // same rule on the string the model is actually handed, for every target, which is what makes it a guard
  // on the prompt rather than on the file.
  for (const target of [...UPLOADS, { kind: "wrap" } as Target, { kind: "field", def: defs[0] } as Target]) {
    const prompt = promptFor(target);
    assert.match(prompt, /Call the upload controls by their names/);
    for (const placement of [/on the left/, /to the left/, /on the right/, /to the right/]) assert.doesNotMatch(prompt, placement);
  }
});

test("the sandbox branches T134 settled are untouched by the span sweep (T139)", () => {
  // The synthetic demonstration patient has its own copy, which names no file upload at all. T139 is about
  // the real offer; these two are asserted here so a reword of it cannot reach them.
  assert.equal(scripted({ firstName: "Demo", target: UPLOADS[0], exportHelp: null, isSandbox: true }), SANDBOX_CONNECT_HELP);
  assert.match(SANDBOX_CONNECT_HELP, /Connect Dexcom sandbox link/);
  const sandboxWrap = speakSystem({ firstName: "Demo", providerName: "James", visit: { ...visit, isSandbox: true }, state: emptyIntake(defs), defs, status: NOTHING_SHARED, target: { kind: "wrap" }, exportHelp: null });
  assert.match(sandboxWrap, /optional Connect Dexcom sandbox link for synthetic readings, not a file upload/);
  assert.doesNotMatch(sandboxWrap, /Dexcom export handy/);
});

test("no Sweetie copy, scripted or model prompt, places a control on the screen", () => {
  // speak() hands its prompt straight to the model, so the only way to hold the §6.5 rule is to read the
  // module: nothing Sweetie can say should name a side of a layout that changes at 375px.
  const source = readFileSync(path.join(import.meta.dirname, "sweetie.ts"), "utf8");
  for (const placement of [/on the left/, /to the left/, /on the right/, /to the right/]) {
    assert.doesNotMatch(source, placement);
  }
  assert.match(source, /Call the upload controls by their names/);
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

test("knownVisitType passes our own types through and calls everything else other", () => {
  for (const { id } of VISIT_TYPES) assert.equal(knownVisitType(id), id);
  // Booking takes visitType as free text, so a caller could put a patient's own words in it.
  for (const free of ["Jane Doe", "mornings running high", "", null, undefined, "FOLLOW_UP"]) {
    assert.equal(knownVisitType(free), "other");
  }
});

// ---- Safety scan (design §12.1: deterministic, before any model call) -------------------------------------

test("the safety scan catches each red flag in the patient's own phrasing", () => {
  const cases: [string, string][] = [
    ["I passed out on Tuesday morning", "loss_of_consciousness"],
    ["had a seizure last week", "loss_of_consciousness"],
    ["my ketones were high and my breath smelled fruity", "possible_dka"],
    ["I can't stop throwing up since yesterday", "possible_dka"],
    ["my husband had to give me glucagon", "severe_hypo"],
    ["glucose was 34 before dinner", "severe_hypo"],
    ["woke up with chest pain", "cardiac_or_breathing"],
    ["I get short of breath on the stairs", "cardiac_or_breathing"],
    ["honestly I don't want to be alive some days", "self_harm"],
  ];
  for (const [text, id] of cases) assert.equal(scanRedFlags(text), id, text);
});

test("the safety scan does not fire on ordinary intake answers", () => {
  for (const text of [
    "Tired in the afternoons, worse since August.",
    "My sugars run about 160 in the mornings.",
    "I was in hospital two years ago for my gallbladder.",
    "Breakfast is usually oatmeal, lunch is a sandwich.",
    "I skipped my metformin twice last week.",
    "",
  ]) {
    assert.equal(scanRedFlags(text), null, text);
  }
});

test("the red-flag reply sends the patient to a person, not to the form", () => {
  const reply = redFlagReply("Sam", "Dr. Bell");
  assert.match(reply, /^Sam,/);
  assert.match(reply, /call 911/);
  assert.match(reply, /call Dr\. Bell's office today/);
  assert.match(reply, /flagged this so the team sees it first/);
  // Nothing clinical is interpreted back at them.
  assert.doesNotMatch(reply, /mg\/dL|your (glucose|sugar) (is|was)/i);
});

test("what Sweetie says after the flag repeats the instruction and asks nothing (T97)", () => {
  const reply = flaggedHoldReply("Sam", "Dr. Bell");
  assert.match(reply, /^Sam,/);
  assert.match(reply, /call Dr\. Bell's office today/);
  assert.match(reply, /911/);
  assert.match(reply, /urgent care/);
  // §2.5 stopped the check-in; it did not finish it, and nothing here invites another answer.
  assert.doesNotMatch(reply, /complete/i);
  assert.doesNotMatch(reply, /\?/);
  // Nothing clinical is interpreted back at them, as in redFlagReply above.
  assert.doesNotMatch(reply, /mg\/dL|your (glucose|sugar) (is|was)/i);
});

test("a flagged intake is never aimed at another question (T97, §2.5)", () => {
  // The scan stops the interview, so no caller that recomputes the target from stored state can reopen it —
  // not with the template empty, which is where a flag usually fires, and not with it half filled.
  const empty = { ...emptyIntake(defs), flagged: "cardiac_or_breathing", wrapped: true };
  assert.deepEqual(nextTarget(empty, defs), { kind: "wrap" });
  const partly = { ...backstop(emptyIntake(defs), defs[0].id, "Exhausted for six weeks, worse in the afternoons"), flagged: "severe_hypo", wrapped: true };
  assert.deepEqual(nextTarget(partly, defs), { kind: "wrap" });
});

// ---- State transitions ------------------------------------------------------------------------------------

test("the template is two questions, shaped by the visit type and the stated reason", () => {
  assert.deepEqual(
    fieldsFor("follow_up", null).map((f) => f.id),
    ["purpose", "update"],
  );
  for (const { id } of VISIT_TYPES) assert.equal(fieldsFor(id, null).length, 2);
  // Each visit type asks its own second question.
  const labels = VISIT_TYPES.map(({ id }) => fieldsFor(id, null)[1].label);
  assert.equal(new Set(labels).size, VISIT_TYPES.length);
  assert.equal(fieldsFor("post_hospital", null)[1].label, "The hospital visit");
  assert.equal(fieldsFor("nonsense", null)[1].label, fieldsFor("follow_up", null)[1].label);
  // The reason the office recorded goes into the first question, quoted as theirs.
  const withReason = fieldsFor("follow_up", "  mornings running high  ");
  assert.match(withReason[0].fallbackQuestion, /^You mentioned "mornings running high" when you booked/);
  assert.match(withReason[0].goal, /"mornings running high"/);
  assert.deepEqual(fieldsFor("follow_up", "   "), fieldsFor("follow_up", null));
  // Both questions are required, so neither gets skipped for being optional.
  assert.equal(requiredCount(fieldsFor("follow_up", null)), 2);
});

test("merging raises a field's confidence but never lowers it", () => {
  const base = emptyIntake(defs);
  const high = merge(base, { fields: [{ id: "purpose", value: "Exhausted for six weeks", confidence: "high" }], declines: [], asks_export_help: null });
  assert.deepEqual(high.fields.purpose, { value: "Exhausted for six weeks", confidence: "high" });
  const again = merge(high, { fields: [{ id: "purpose", value: "tired", confidence: "low" }], declines: [], asks_export_help: null });
  assert.deepEqual(again.fields.purpose, high.fields.purpose, "a weaker extraction must not overwrite a high one");
});

test("two partial answers add up to one usable answer", () => {
  const base = emptyIntake(defs);
  const first = merge(base, { fields: [{ id: "update", value: "New desk job in August.", confidence: "low" }], declines: [], asks_export_help: null });
  assert.equal(first.fields.update.confidence, "low");
  assert.equal(answeredCount(first, defs), 0);
  const second = merge(first, { fields: [{ id: "update", value: "Sleeping about six hours.", confidence: "low" }], declines: [], asks_export_help: null });
  assert.deepEqual(second.fields.update, { value: "New desk job in August. Sleeping about six hours.", confidence: "medium" });
  assert.equal(answeredCount(second, defs), 1);
});

test("merging records a declined upload once, however often the patient says it", () => {
  const base = emptyIntake(defs);
  const once = merge(base, { fields: [], declines: ["whoop", "timeline"], asks_export_help: null });
  const twice = merge(once, { fields: [], declines: ["whoop"], asks_export_help: null });
  assert.deepEqual(twice.skipped, ["whoop", "timeline"]);
  // Values are trimmed on the way in, so a model's trailing newline never reaches Sour's notes.
  const padded = merge(base, { fields: [{ id: "purpose", value: "  Exhausted for six weeks\n", confidence: "high" }], declines: [], asks_export_help: null });
  assert.equal(padded.fields.purpose.value, "Exhausted for six weeks");
});

test("a field outside the template is extract's to reject, not merge's", () => {
  // merge trusts its input: extract() is what filters ids against the template before this runs. Pinning the
  // split here so a change that drops the filter shows up as a failure in the right module.
  const base = emptyIntake(defs);
  const stray = merge(base, { fields: [{ id: "not_a_field", value: "x", confidence: "high" }], declines: [], asks_export_help: null });
  assert.deepEqual(stray.fields.not_a_field, { value: "x", confidence: "high" });
  // It changes nothing the rest of the flow looks at: answers, next question and notes all come from the template.
  assert.equal(answeredCount(stray, defs), 0);
  assert.deepEqual(nextTarget(stray, defs), { kind: "field", def: defs[0] });
  assert.equal(renderNotes(stray, defs, visit).includes("x"), false);
});

test("the backstop counts a substantive reply the extractor missed", () => {
  const base = emptyIntake(defs);
  const answered = backstop(base, "purpose", "I have been exhausted for about six weeks now");
  assert.deepEqual(answered.fields.purpose, { value: "I have been exhausted for about six weeks now", confidence: "medium" });
  assert.equal(answeredCount(answered, defs), 1);
});

test("the backstop does not mistake a question, a shrug or a decline for an answer", () => {
  const base = emptyIntake(defs);
  for (const latest of [
    "What do you mean by that exactly?", // a question back
    "ok", // too short
    "not really", // a decline
    "no, nothing like that", // a decline
    "skip", // a decline
    "   ",
  ]) {
    assert.deepEqual(backstop(base, "purpose", latest).fields.purpose, base.fields.purpose, latest);
  }
  // Nothing was asked, so nothing can be answered.
  assert.deepEqual(backstop(base, null, "Exhausted for six weeks and shaky in the mornings"), base);
  // An answer already at medium or better is not overwritten by the raw text.
  const high = merge(base, { fields: [{ id: "purpose", value: "Exhausted for six weeks", confidence: "high" }], declines: [], asks_export_help: null });
  assert.deepEqual(backstop(high, "purpose", "and also my feet tingle sometimes").fields.purpose, high.fields.purpose);
});

test("the next question is the first unanswered one, then the wrap", () => {
  let state = emptyIntake(defs);
  assert.deepEqual(nextTarget(state, defs), { kind: "field", def: defs[0] });
  state = backstop(state, defs[0].id, "Exhausted for six weeks, worse in the afternoons");
  assert.deepEqual(nextTarget(state, defs), { kind: "field", def: defs[1] });
  state = backstop(state, defs[1].id, "New desk job in August and a cold two weeks ago");
  assert.deepEqual(nextTarget(state, defs), { kind: "wrap" });
  assert.equal(answeredCount(state, defs), requiredCount(defs));
  // A low-confidence answer is not an answer: Sweetie asks again.
  const weak = merge(emptyIntake(defs), { fields: [{ id: "purpose", value: "tired", confidence: "low" }], declines: [], asks_export_help: null });
  assert.deepEqual(nextTarget(weak, defs), { kind: "field", def: defs[0] });
});

test("a corrupt or partial stored intake falls back to an empty one rather than throwing", () => {
  assert.deepEqual(parseIntake("{not json", defs), emptyIntake(defs));
  assert.deepEqual(parseIntake("", defs), emptyIntake(defs));
  assert.deepEqual(parseIntake(undefined, defs), emptyIntake(defs));
  // A state written before a field existed keeps what it has and defaults the rest.
  const partial = parseIntake(JSON.stringify({ fields: { purpose: { value: "Exhausted", confidence: "high" } }, turns: 2 }), defs);
  assert.deepEqual(partial.fields.purpose, { value: "Exhausted", confidence: "high" });
  assert.deepEqual(partial.fields.update, { value: null, confidence: "unfilled" });
  assert.deepEqual(partial.skipped, []);
  assert.equal(partial.flagged, null);
  assert.equal(partial.turns, 2);
});

test("the notes Sour reads carry the flag, the visit and the answers, in that order", () => {
  let state = emptyIntake(defs);
  state = backstop(state, "purpose", "Exhausted for six weeks, worse in the afternoons");
  state = merge(state, { fields: [], declines: ["whoop"], asks_export_help: null });
  state.flagged = "severe_hypo";
  const lines = renderNotes(state, defs, { visitType: "follow_up", reason: "mornings running high" }).split("\n");
  assert.match(lines[0], /^⚠ Safety flag during intake: severe hypo\./);
  assert.equal(lines[1], "Visit: Follow-up. Called about: mornings running high");
  assert.match(lines[2], /^Why you're here: Exhausted for six weeks/);
  assert.equal(lines.at(-1), "Data not shared: whoop.");
  // An untouched intake still names the visit, and claims nothing about the patient.
  assert.equal(renderNotes(emptyIntake(defs), defs, visit), "Visit: Follow-up");
});
