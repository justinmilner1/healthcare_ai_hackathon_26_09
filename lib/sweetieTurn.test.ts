// Design §6.2, the sentence in full: "Every patient message is stored before any model call; the transcript
// survives a crash."
//
// Both halves are claims about order and about what is in the database at each moment, so the store and the
// model are fakes that record the order they were called in, and the model can be told to throw. A test that
// only checked the end of a happy turn would pass against a route that called the model first and wrote the
// message afterwards, which is the failure this file exists to catch.
//
// "Crash" here means the thing a deployment actually does: the process stops, or a call throws something
// nobody planned for. A gateway that is merely unavailable is not a crash — §6.3 plans for that one, and it
// has its own tests below so the two are not confused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LLMUnavailable } from "./llm";
import { emptyIntake, fieldsFor, nextTarget, parseIntake } from "./sweetie";
import type { Target } from "./sweetie";
import { MAX_TURNS, guessExportHelp, runTurn } from "./sweetieTurn";
import type { TurnModel, TurnStore } from "./sweetieTurn";
import type { ChatRole, IntakeState, IntakeStatus } from "./types";

const VISIT = { visitType: "follow_up", reason: null };
const DEFS = fieldsFor(VISIT.visitType, VISIT.reason);
const NOTHING_UPLOADED: IntakeStatus = { hasDexcom: false, hasLocation: false, hasWhoop: false, answered: 0, done: false };

/**
 * A store that remembers what it was asked to do and in what order, and nothing else.
 *
 * `trace` is the assertion surface: it is what a crash dump of the turn would look like. `rows` and
 * `intake` are the two things that outlive the request — the transcript and `Visit.intake` — and they are
 * only ever changed by the calls that the real store makes durable, so reading them after a rejected turn is
 * reading what the next page load would see.
 */
function recordingStore(status: IntakeStatus = NOTHING_UPLOADED) {
  const trace: string[] = [];
  const rows: { role: ChatRole; content: string }[] = [];
  /** `Visit.intake` as stored: null until a turn commits, then the JSON the page is rebuilt from. */
  let intake: string | null = null;
  const store: TurnStore = {
    append: async (role, content) => {
      trace.push(`append:${role}`);
      rows.push({ role, content });
    },
    transcript: async () => {
      trace.push("transcript");
      return rows.map((m) => `${m.role === "sweetie" ? "Sweetie" : "Patient"}: ${m.content}`).join("\n");
    },
    status: async () => {
      trace.push("status");
      return status;
    },
    commit: async (reply, state) => {
      trace.push("commit");
      rows.push({ role: "sweetie", content: reply });
      intake = JSON.stringify(state);
    },
  };
  return {
    store,
    trace,
    rows,
    /** The state the next request would parse out of the row, which is what the page's stepper reads. */
    stored: () => (intake === null ? null : parseIntake(intake, DEFS)),
  };
}

/** A model that answers, records that it was asked, and can be told to fail on either call. */
function recordingModel(trace: string[], fail: { extract?: Error; speak?: Error } = {}) {
  const model: TurnModel = {
    extract: async (state, defs, transcript, latest, askedId) => {
      trace.push("extract");
      if (fail.extract) throw fail.extract;
      return {
        fields: askedId ? [{ id: askedId, value: latest, confidence: "high" as const }] : [],
        declines: [],
        asks_export_help: null,
      };
    },
    speak: async () => {
      trace.push("speak");
      if (fail.speak) throw fail.speak;
      return "Thank you. What has changed since your last visit?";
    },
  };
  return model;
}

const turn = (over: Partial<Parameters<typeof runTurn>[0]> = {}) => ({
  state: emptyIntake(DEFS),
  defs: DEFS,
  visit: VISIT,
  firstName: "Sam",
  providerName: "Dr Chen",
  ...over,
});

// ------------------------------------------------------------------------------------------------
// "stored before any model call"

describe("the patient's message is stored first (§6.2)", () => {
  it("writes the message, then reads the transcript, then calls the model", async () => {
    const { store, trace, rows, stored } = recordingStore();
    await runTurn(turn({ message: "Mornings keep running high and it worries me." }), store, recordingModel(trace));

    // The order is the design sentence. `append:patient` before `extract` and `speak` is the whole claim,
    // and `commit` last is the other one: nothing is written between the message and the end of the turn.
    assert.deepEqual(trace, ["append:patient", "transcript", "extract", "status", "speak", "commit"]);
    assert.equal(rows[0].role, "patient");
    assert.equal(rows[0].content, "Mornings keep running high and it worries me.");
    assert.equal(stored()?.turns, 1);
  });

  it("stores it before the model even when the model is the thing that is broken", async () => {
    // §6.3's path, which must not be allowed to cost the patient their words.
    const { store, trace, rows } = recordingStore();
    const result = await runTurn(turn({ message: "Shaky most mornings for about three weeks." }), store, recordingModel(trace, { extract: new LLMUnavailable("gateway down") }));

    assert.equal(trace.indexOf("append:patient"), 0);
    assert.ok(trace.indexOf("append:patient") < trace.indexOf("extract"));
    assert.equal(result.fellBack, true);
    assert.equal(result.fallbackAt, "extract");
    assert.equal(rows[0].content, "Shaky most mornings for about three weeks.");
    // The scripted words are a question, not an apology: the intake carries on (§6.3).
    assert.equal(rows[1].role, "sweetie");
    assert.ok(rows[1].content.length > 0);
  });

  it("runs the safety scan before the model, and stops the turn there", async () => {
    const { store, trace, rows, stored } = recordingStore();
    const result = await runTurn(turn({ message: "I passed out this morning and I'm shaking badly." }), store, recordingModel(trace));

    // No `extract`, no `speak`: a red flag is deterministic, so a gateway that is down cannot swallow it.
    assert.deepEqual(trace, ["append:patient", "commit"]);
    assert.ok(result.flagged, "the scan fired");
    assert.equal(stored()?.flagged, result.flagged);
    assert.equal(stored()?.wrapped, true);
    assert.equal(rows[0].role, "patient", "the patient's words are stored even on the turn that stops");
  });

  it("acknowledges an upload without inventing a patient message", async () => {
    const { store, trace, rows } = recordingStore();
    await runTurn(turn({ event: { kind: "dexcom", count: 2016, days: 7 } }), store, recordingModel(trace));

    assert.deepEqual(trace, ["transcript", "status", "speak", "commit"]);
    assert.deepEqual(rows.map((r) => r.role), ["sweetie"]);
  });
});

// ------------------------------------------------------------------------------------------------
// "the transcript survives a crash"

describe("a crash mid-turn leaves a consistent state (§6.2)", () => {
  /** Not an LLMUnavailable: the unplanned kind, which is what "crash" means here. */
  const bug = () => new TypeError("Cannot read properties of undefined");

  for (const where of ["extract", "speak"] as const) {
    it(`a crash in ${where} keeps the message and writes nothing else`, async () => {
      const { store, trace, rows, stored } = recordingStore();
      const crash = bug();
      const input = turn({ message: "New desk job in August and a cold two weeks ago." });

      await assert.rejects(
        () => runTurn(input, store, recordingModel(trace, { [where]: crash })),
        (e: unknown) => e === crash,
        "an unplanned failure must escape rather than be committed as if the turn had worked",
      );

      // What the next page load sees: the patient's own message, and nothing half-written behind it.
      assert.deepEqual(rows, [{ role: "patient", content: "New desk job in August and a cold two weeks ago." }]);
      assert.equal(trace.includes("commit"), false, "a turn that crashed must not commit");
      assert.equal(stored(), null, "Visit.intake is untouched, so the stepper reads what it read before");
      assert.deepEqual(input.state, emptyIntake(DEFS), "the caller's state object was not mutated either");
    });
  }

  it("does not count the crashed turn twice when the patient says it again", async () => {
    // The patient's browser shows their message with no answer, so they send it again. The second attempt
    // starts from what was stored, which is still the empty intake — so the turn count lands on one, not two,
    // and the field is filled once. A turn that had committed half of itself could not make that promise.
    const first = recordingStore();
    const crash = bug();
    const input = turn({ message: "Tired all the time, worse in the afternoons." });
    await assert.rejects(() => runTurn(input, first.store, recordingModel(first.trace, { extract: crash })));
    assert.equal(first.stored(), null);

    const second = recordingStore();
    const retry = await runTurn(turn({ state: first.stored() ?? emptyIntake(DEFS), message: "Tired all the time, worse in the afternoons." }), second.store, recordingModel(second.trace));

    assert.equal(retry.state.turns, 1, "the crashed attempt did not advance the count");
    assert.equal(second.stored()?.turns, 1);
    assert.equal(second.stored()?.fields.purpose.value, "Tired all the time, worse in the afternoons.");
  });

  it("puts the reply and the state it was written from in one call, never two", async () => {
    // The reply is not appended like the patient's message is: it goes through `commit` with the state, so
    // there is no instant in which the patient can read a question the stored intake has never seen.
    const { store, trace } = recordingStore();
    await runTurn(turn({ message: "Mostly home cooking, some takeaway on Fridays." }), store, recordingModel(trace));

    assert.deepEqual(trace.filter((t) => t === "append:patient" || t === "commit"), ["append:patient", "commit"]);
    assert.equal(trace.filter((t) => t === "append:sweetie").length, 0);
    assert.equal(trace.filter((t) => t === "commit").length, 1);
  });
});

// ------------------------------------------------------------------------------------------------
// What a reload reads back. The page's own restore is e2e/durability.spec.ts; this is the state behind it.

describe("the stored state is what the next turn and the stepper read", () => {
  it("round-trips through Visit.intake, and the stepper lands on the question Sweetie just asked", async () => {
    const { store, trace, stored } = recordingStore();
    const result = await runTurn(turn({ message: "High after dinner most nights and I want to know why." }), store, recordingModel(trace));

    const restored = stored();
    assert.ok(restored, "the turn committed");
    // The target is not stored; it is recomputed from the state. So a reload asks the same next question as
    // the turn that was interrupted by it, which is why the stepper does not move when the page reloads.
    assert.deepEqual(nextTarget(restored, DEFS), result.target satisfies Target);
    assert.deepEqual(restored.fields, result.state.fields);
    assert.equal(restored.wrapped, result.state.wrapped);
  });

  it("wraps once both questions are answered, and says so in the stored state", async () => {
    const { store, trace, stored } = recordingStore();
    let state: IntakeState = emptyIntake(DEFS);
    for (const message of ["Mornings run high and it worries me.", "New job in August, sleeping about six hours."]) {
      state = (await runTurn(turn({ state, message }), store, recordingModel(trace))).state;
    }
    assert.deepEqual(nextTarget(state, DEFS), { kind: "wrap" });
    assert.equal(stored()?.wrapped, true);
    assert.equal(stored()?.turns, 2);
  });

  it("stops asking after MAX_TURNS even with the template unfilled", async () => {
    // The extractor is told nothing useful, so no field ever fills; the cap is what ends the conversation.
    const { store, trace, stored } = recordingStore();
    const silent: TurnModel = { ...recordingModel(trace), extract: async () => ({ fields: [], declines: [], asks_export_help: null }) };
    let state: IntakeState = emptyIntake(DEFS);
    for (let i = 0; i < MAX_TURNS; i++) {
      // One word, so the deterministic backstop does not count it as an answer either.
      state = (await runTurn(turn({ state, message: "ok" }), store, silent)).state;
    }
    assert.equal(state.turns, MAX_TURNS);
    assert.equal(stored()?.wrapped, true, "the cap wraps the intake rather than asking a seventh time");
  });
});

// ------------------------------------------------------------------------------------------------

describe("guessExportHelp", () => {
  // The extractor's `asks_export_help` worked out from the words, for the turns where there is no extractor.
  const cases: [string, string | null][] = [
    ["how do I export my Dexcom data?", "dexcom"],
    ["where do I find the Google Maps timeline file", "timeline"],
    ["how do I download my whoop sleep csv", "whoop"],
    ["my sugars have been high", null],
    ["I have the dexcom app", null],
  ];
  for (const [text, expected] of cases) {
    it(`${expected ?? "nothing"} from "${text}"`, () => assert.equal(guessExportHelp(text), expected));
  }
});
