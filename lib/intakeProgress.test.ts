import assert from "node:assert/strict";
import test from "node:test";
import {
  intakeEnding,
  intakeProgressCard,
  intakeStepperEnd,
  type IntakeEnding,
  type IntakeProgressInput,
} from "./intakeProgress";

/** The two-field template `fieldsFor` builds for a follow-up, which is what the product ships (§2.5). */
const TEMPLATE = { totalFields: 2, office: "Dr. Demo Endo" };

/** Still being asked: one of the two answered, nothing has wrapped. */
const OPEN: IntakeProgressInput = {
  ...TEMPLATE,
  completeFields: 1,
  finished: false,
  flagged: false,
  questionsSkipped: false,
};

/** Answered to the end: both fields filled, Sweetie has said goodbye. */
const ANSWERED: IntakeProgressInput = {
  ...TEMPLATE,
  completeFields: 2,
  finished: true,
  flagged: false,
  questionsSkipped: false,
};

/** The ticket's state: one answer, then "Skip the rest of the questions" (T142). */
const SKIPPED: IntakeProgressInput = {
  ...TEMPLATE,
  completeFields: 1,
  finished: true,
  flagged: false,
  questionsSkipped: true,
};

/** The safety scan fired on the first answer (T66). */
const FLAGGED: IntakeProgressInput = {
  ...TEMPLATE,
  completeFields: 1,
  finished: true,
  flagged: true,
  questionsSkipped: false,
};

test("the three endings are told apart, not collapsed into `finished` (T142, §2.5)", () => {
  // The defect in four assertions: a skip wraps the intake and the scan wraps the intake, so `finished`
  // alone answers "ready" for all three.
  assert.equal(intakeEnding(OPEN), "open");
  assert.equal(intakeEnding(ANSWERED), "answered");
  assert.equal(intakeEnding(SKIPPED), "skipped");
  assert.equal(intakeEnding(FLAGGED), "flagged");
});

test("a flagged check-in is flagged whichever other way it also ended (T66)", () => {
  // The scan can fire on the message that fills the last field, and the flag is what §2.5 acts on.
  assert.equal(intakeEnding({ ...FLAGGED, completeFields: 2, questionsSkipped: true }), "flagged");
  assert.equal(intakeEnding({ ...FLAGGED, finished: false }), "flagged");
});

test("a skip with nothing left unanswered is a completed check-in, not an early ending", () => {
  // Pressing the link after filling the template leaves no gap to apologise for.
  assert.equal(intakeEnding({ ...SKIPPED, completeFields: 2 }), "answered");
});

test("no card shows a part-full track beside a sentence saying it is done (T142)", () => {
  // The contradiction the ticket is about: a percentage under 100, a track drawn to it, and "Your story is
  // ready" under both. Swept over every state rather than asserted on the one that had it.
  for (const [name, input] of [
    ["open", OPEN],
    ["answered", ANSWERED],
    ["skipped", SKIPPED],
    ["flagged", FLAGGED],
  ] as [string, IntakeProgressInput][]) {
    const card = intakeProgressCard(input);
    if (card.detail === "Your story is ready") {
      assert.equal(card.percent, 100, `${name}: a complete check-in reads 100%`);
    }
    if (card.percent !== null && card.percent < 100) {
      assert.notEqual(card.detail, "Your story is ready", `${name}: a part-full track says the check-in is done`);
    }
  }
});

test("an ending that stopped short drops the number and the track and says why (T66, T142, §2.5)", () => {
  const skipped = intakeProgressCard(SKIPPED);
  assert.equal(skipped.percent, null, "no percentage, so no track either");
  assert.equal(skipped.label, "Check-in ended early");
  assert.match(skipped.detail, /skipped the rest/i);
  assert.match(skipped.detail, /saved for your care team/i);
  assert.doesNotMatch(skipped.detail, /ready/i, "nothing on this card calls the check-in complete");

  const flagged = intakeProgressCard(FLAGGED);
  assert.equal(flagged.percent, null);
  assert.equal(flagged.label, "Check-in stopped");
  assert.equal(flagged.detail, "We stopped early so Dr. Demo Endo can look at this now.");
});

test("every state has a sentence, because §6.5 now shows it at 375px too", () => {
  for (const input of [OPEN, ANSWERED, SKIPPED, FLAGGED]) {
    assert.notEqual(intakeProgressCard(input).detail.trim(), "");
  }
});

test("a check-in answered to the end is unchanged: 100% beside 'Your story is ready'", () => {
  const card = intakeProgressCard(ANSWERED);
  assert.equal(card.label, "Conversation progress");
  assert.equal(card.percent, 100);
  assert.equal(card.detail, "Your story is ready");
});

test("a check-in still being asked keeps the arithmetic it had: the fields plus the wrap", () => {
  // 1 of 2 answered is 1 of 3 steps, as the rail has always drawn it — the track cannot read full while a
  // question is still outstanding.
  const card = intakeProgressCard(OPEN);
  assert.equal(card.percent, 33);
  assert.equal(card.detail, "1 of 2 questions answered");
  assert.equal(intakeProgressCard({ ...OPEN, completeFields: 0 }).percent, 0);
  assert.equal(intakeProgressCard({ ...OPEN, completeFields: 2 }).percent, 67);
});

test("the card survives the moment before GET /api/sweetie has answered with the template", () => {
  // `fields` is empty until the route replies, and 0/1 is a real percentage rather than a NaN.
  const card = intakeProgressCard({ ...OPEN, totalFields: 0, completeFields: 0 });
  assert.equal(card.percent, 0);
  assert.equal(card.detail, "0 of — questions answered");
});

test("the stepper's last step is ticked only by a check-in that answered the questions (T146, §2.5)", () => {
  // The defect in one assertion: a skip sets `questionsSkipped` *and* `wrapped` (lib/sweetie.ts), so the
  // step's old `finished && !flagged` was true and the strip read "✓ Why you're here · 2 Since last visit
  // · ✓ Done" — a tick on the right of a step still carrying its number.
  assert.equal(intakeStepperEnd("skipped").done, false);
  assert.equal(intakeStepperEnd("skipped").label, "Ended early");
  assert.doesNotMatch(intakeStepperEnd("skipped").label, /done/i);
  // The tooltip said it a second time, so it has to agree a second time.
  assert.doesNotMatch(intakeStepperEnd("skipped").title, /complete/i);
  assert.match(intakeStepperEnd("skipped").title, /ended early/i);
});

test("the two endings that stopped short are the two with no tick, and say which they are (T66, T146)", () => {
  // The invariant rather than the state: whatever words these get later, an ending that left questions
  // unanswered does not take the tick, and the two are not told apart by the same word.
  const short = [intakeStepperEnd("skipped"), intakeStepperEnd("flagged")];
  for (const step of short) {
    assert.equal(step.done, false, step.label);
    assert.doesNotMatch(step.label, /done/i, step.label);
    assert.notEqual(step.label.trim(), "", "a word for what happened, not a blank pill");
  }
  assert.notEqual(short[0].label, short[1].label, "a skip and a flag are not the same thing");
  // T66's step, down to the tooltip e2e/mobile.spec.ts finds it by.
  assert.equal(intakeStepperEnd("flagged").label, "Stopped");
  assert.equal(intakeStepperEnd("flagged").title, "Check-in stopped early and flagged for the office");
});

test("a check-in answered to the end keeps its tick, and one still going has not earned one", () => {
  const answered = intakeStepperEnd("answered");
  assert.deepEqual(answered, { label: "Done", done: true, title: "Check-in complete" });
  // Open is the step ahead of the patient: named, not ticked, and unchanged by T146.
  assert.deepEqual(intakeStepperEnd("open"), { label: "Done", done: false, title: "Check-in complete" });
});

test("the strip and the rail cannot disagree, because they are the same ending (T142, T146)", () => {
  // The whole point of routing both through `intakeEnding`: swept over the four states, the step is ticked
  // exactly where the card reads 100%, and the step says so in words wherever the card drops the number.
  for (const [name, input] of [
    ["open", OPEN],
    ["answered", ANSWERED],
    ["skipped", SKIPPED],
    ["flagged", FLAGGED],
  ] as [string, IntakeProgressInput][]) {
    const card = intakeProgressCard(input);
    const step = intakeStepperEnd(card.ending);
    assert.equal(step.done, card.percent === 100, `${name}: the tick and the percentage disagree`);
    if (card.percent === null) {
      assert.doesNotMatch(step.label, /done/i, `${name}: a card with no number beside a step saying "Done"`);
      assert.doesNotMatch(step.title, /^Check-in complete$/, `${name}: and the tooltip says it again`);
    }
  }
});

test("every ending has a step, so none of them falls through to a blank pill", () => {
  for (const ending of ["open", "answered", "skipped", "flagged"] as IntakeEnding[]) {
    const step = intakeStepperEnd(ending);
    assert.notEqual(step.label.trim(), "", ending);
    assert.notEqual(step.title.trim(), "", ending);
  }
});
