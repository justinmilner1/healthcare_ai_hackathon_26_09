import assert from "node:assert/strict";
import test from "node:test";
import { intakeEnding, intakeProgressCard, type IntakeProgressInput } from "./intakeProgress";

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
