// Unit tests for the clinician's "In the patient's words" block (T154, design §2.6, §2.5, §7.4).
//
// The case the ticket is about is the first one below: the §2.5 scan fires on the patient's *first* message,
// so the wrap leaves every field `unfilled`, `renderNotes` has nothing of theirs to emit, and the block used
// to quote two machine-written lines as the patient's words while the sentence that caused the flag reached
// no clinician surface at all. Everything else here is the fence around that fix: the ordinary wrap renders
// exactly what it rendered before, and a check-in nobody typed into says so rather than quoting the notes.
//
// `renderNotes` is run for real rather than stubbed, so the notes under test are the string the product
// actually puts on `Visit.notes` — the whole bug was a difference between what that string holds on one
// ending and on every other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_QUOTES, moreMessagesLine, notesHaveAnswers, patientWords } from "./patientWords";
import { emptyIntake, fieldsFor, renderNotes } from "./sweetie";
import type { IntakeFieldDef, IntakeState } from "./types";

const VISIT = { visitType: "follow_up", reason: "tired all the time", isSandbox: false };
const DEFS: IntakeFieldDef[] = fieldsFor(VISIT.visitType, VISIT.reason);

/** A bundle's worth of input, built from the state the product would really be in. */
const withState = (state: IntakeState, messages: string[]) => ({
  patient: { notes: renderNotes(state, DEFS, VISIT) },
  intake: state,
  intakeFields: DEFS,
  patientMessages: messages,
});

const FLAG_SENTENCE = "I had chest pain yesterday evening and it really scared me.";

describe("notesHaveAnswers", () => {
  it("is false exactly when nothing in the notes came from the patient", () => {
    // Also asserted from lib/sweetie.test.ts, which is where the notes it is about are rendered. Here
    // because this is the module it lives in — it is out of lib/sweetie.ts so that the provider brief, a
    // client component, can import this one without pulling lib/llm.ts into the browser bundle.
    const empty = emptyIntake(DEFS);
    assert.equal(notesHaveAnswers(empty, DEFS), false);
    assert.equal(notesHaveAnswers({ ...empty, flagged: "cardiac_or_breathing", turns: 1, wrapped: true }, DEFS), false);
    const filled = { ...empty, fields: { ...empty.fields, [DEFS[0].id]: { value: "worse since August", confidence: "high" as const } } };
    assert.equal(notesHaveAnswers(filled, DEFS), true);
  });
});

describe("a flag on the patient's first message", () => {
  // Exactly what lib/sweetieTurn.ts commits: the scan runs before any extraction, so the state wraps with
  // the flag set, one turn counted and not a single field filled.
  const flaggedFirst = (): IntakeState => ({ ...emptyIntake(DEFS), flagged: "cardiac_or_breathing", turns: 1, wrapped: true });

  it("quotes the sentence that caused the flag, which reached no clinician surface before", () => {
    const words = patientWords(withState(flaggedFirst(), [FLAG_SENTENCE]));
    assert.deepEqual(words.quotes, [FLAG_SENTENCE]);
    assert.equal(words.more, 0);
  });

  it("keeps the machine-written notes for the clinician, outside the quotation", () => {
    const words = patientWords(withState(flaggedFirst(), [FLAG_SENTENCE]));
    // Both lines `renderNotes` wrote are still in front of the clinician — the flag and what staff booked
    // the visit about — and neither is presented as something the patient said.
    assert.ok(
      words.context.some((l) => /Patient was told to call the office/.test(l)),
      "the safety-flag line is kept",
    );
    assert.ok(words.context.some((l) => /Called about: tired all the time/.test(l)), "the booked reason is kept");
    for (const line of words.context) assert.ok(!words.quotes.includes(line), "and no machine line is quoted");
  });

  it("says why these are raw words rather than answers", () => {
    const words = patientWords(withState(flaggedFirst(), [FLAG_SENTENCE]));
    assert.match(words.note, /safety scan stopped the check-in/i);
  });

  it("carries what the patient said after the flag too, in the order they said it", () => {
    // §2.5 takes the composer away, so a later message is one the patient went out of their way to send —
    // "what someone says after a flag is what the office wants to read" (lib/sweetieTurn.ts).
    const after = "Sorry, should I still answer the questions?";
    const words = patientWords(withState({ ...flaggedFirst(), turns: 2 }, [FLAG_SENTENCE, after]));
    assert.deepEqual(words.quotes, [FLAG_SENTENCE, after]);
  });
});

describe("a wrap that filled fields", () => {
  const answered = (): IntakeState => {
    const state = emptyIntake(DEFS);
    const fields = { ...state.fields };
    for (const def of DEFS) fields[def.id] = { value: `answer about ${def.id}`, confidence: "high" };
    return { ...state, fields, turns: 2, wrapped: true };
  };

  it("renders the notes in one quotation, as the brief always has", () => {
    const input = withState(answered(), ["answer about one thing", "and another"]);
    const words = patientWords(input);
    assert.deepEqual(words.quotes, [input.patient.notes], "the notes, whole and unsplit");
    assert.equal(words.note, "", "nothing above it to explain");
    assert.deepEqual(words.context, [], "and nothing beside it: the machine lines stay inside the notes");
    assert.equal(words.more, 0);
  });

  it("is unchanged by a flag that fired once answers were in", () => {
    // The scan can fire on a later message, when fields are already filled. That wrap has the patient's own
    // answers in its notes, so it is the ordinary rendering and not the raw one.
    const words = patientWords(withState({ ...answered(), flagged: "severe_hypo" }, [FLAG_SENTENCE]));
    assert.equal(words.quotes.length, 1);
    assert.match(words.quotes[0], /answer about/);
    assert.equal(words.note, "");
  });
});

describe("a check-in with no answers and no words", () => {
  it("says plainly that the patient wrote nothing, and does not quote the notes", () => {
    const state: IntakeState = { ...emptyIntake(DEFS), turns: 0, wrapped: true };
    const words = patientWords(withState(state, []));
    assert.deepEqual(words.quotes, [], "machine-written notes are never the quotation");
    assert.match(words.note, /wrote nothing/i);
    assert.ok(words.context.length > 0, "the notes are still shown as context");
  });

  it("keeps the old empty state where the check-in has not run a turn at all", () => {
    const words = patientWords({ patient: { notes: null }, intake: emptyIntake(DEFS), intakeFields: DEFS, patientMessages: [] });
    assert.equal(words.note, "Sweetie has not collected answers yet.");
    assert.deepEqual(words.quotes, []);
    assert.deepEqual(words.context, []);
  });

  it("treats whitespace-only messages as nothing written", () => {
    const state: IntakeState = { ...emptyIntake(DEFS), turns: 1, wrapped: true };
    const words = patientWords(withState(state, ["   ", "\n"]));
    assert.deepEqual(words.quotes, []);
    assert.match(words.note, /wrote nothing/i);
  });
});

describe("a check-in the patient wrote in without filling anything", () => {
  it("quotes what they wrote and says it answered none of the questions", () => {
    // Six turns of nothing the extractor could use: the cap wraps the interview anyway
    // (MAX_TURNS, lib/sweetieTurn.ts) and the notes hold no answer.
    const state: IntakeState = { ...emptyIntake(DEFS), turns: 6, wrapped: true };
    const words = patientWords(withState(state, ["mm", "not sure", "same as always"]));
    assert.deepEqual(words.quotes, ["mm", "not sure", "same as always"]);
    assert.match(words.note, /filled one of Sweetie's questions/i);
    assert.doesNotMatch(words.note, /safety scan/i, "no flag fired here");
  });

  it("counts what it cannot fit rather than dropping it", () => {
    const state: IntakeState = { ...emptyIntake(DEFS), turns: 9, wrapped: true };
    const said = Array.from({ length: MAX_QUOTES + 3 }, (_, i) => `message ${i + 1}`);
    const words = patientWords(withState(state, said));
    assert.equal(words.quotes.length, MAX_QUOTES, "the sheet is a one-pager (§7.4)");
    assert.deepEqual(words.quotes, said.slice(0, MAX_QUOTES), "the earliest, which is where the flag would be");
    assert.equal(words.more, 3);
    assert.equal(moreMessagesLine(3), "3 further messages in the check-in, not shown here.");
    assert.equal(moreMessagesLine(1), "1 further message in the check-in, not shown here.");
  });
});
