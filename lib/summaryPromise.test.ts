import assert from "node:assert/strict";
import test from "node:test";
import { setupCompleteCopy, skipGoodbye, skipLinkLabel, type SummaryPromise } from "./summaryPromise";

/** The three states a visit can be in by the time it reaches the end of the connections step. */
const NOTHING: SummaryPromise = { hasConnections: false, hasGlucose: false };
const NO_GLUCOSE: SummaryPromise = { hasConnections: true, hasGlucose: false };
const GLUCOSE: SummaryPromise = { hasConnections: true, hasGlucose: true };

/** Every state, including the one the product cannot reach, so the sweeps below cover the whole function. */
const EVERY_STATE: [string, SummaryPromise][] = [
  ["nothing shared", NOTHING],
  ["connections but no glucose", NO_GLUCOSE],
  ["glucose shared", GLUCOSE],
  // Glucose without a connection counted is not a state the page produces — a Dexcom upload is itself a
  // connection — but the function must not fall through to the empty column if it ever arrives.
  ["glucose with no connection counted", { hasConnections: false, hasGlucose: true }],
];

test("the summary is offered on the condition that renders one, not on any connection (T133)", () => {
  // The defect in one assertion: `/patient/<token>` renders on `status.hasDexcom` (lib/bundle.ts), so a
  // WHOOP CSV or a Timeline export alone must not put a button to it on the screen.
  assert.equal(setupCompleteCopy(GLUCOSE).action, "View my glucose");
  assert.equal(setupCompleteCopy(NO_GLUCOSE).action, null, "a non-glucose connection offers no summary");
  assert.equal(setupCompleteCopy(NOTHING).action, null);
  assert.equal(
    setupCompleteCopy({ hasConnections: false, hasGlucose: true }).action,
    "View my glucose",
    "glucose decides the offer on its own; the connection count does not gate it",
  );
});

test("the state with something shared and no glucose is its own, not either of the other two (T133)", () => {
  // T116 gave the step two columns and T133 is the third. Asserting that all three differ is what stops a
  // later reword from collapsing this one back into whichever neighbour it most resembles: it has the
  // empty column's actions and the shared column's premise, and neither one's words.
  const nothing = setupCompleteCopy(NOTHING);
  const neither = setupCompleteCopy(NO_GLUCOSE);
  const glucose = setupCompleteCopy(GLUCOSE);
  assert.notEqual(neither.bubble, nothing.bubble);
  assert.notEqual(neither.bubble, glucose.bubble);
  assert.notEqual(neither.lede, nothing.lede);
  assert.notEqual(neither.lede, glucose.lede);
  // It has something, so it cannot repeat the empty column's claim that nothing was shared.
  assert.doesNotMatch(neither.lede, /haven't shared any data/i);
  assert.match(neither.lede, /saved for your care team/i, "what the patient did share is acknowledged");
  // And it has no summary, so it cannot repeat the offer.
  assert.doesNotMatch(neither.lede, /go straight to/i);
});

test("no state of the step names a span, because none of them knows one (T114, T116, T123, T133)", () => {
  // The same sweep lib/dexcomHint.test.ts holds `summaryDataInvite` to, for the same reason: an article or
  // a tense is what a reword changes, so the noun is what gets pinned. "a week", "the past week" and
  // "7 days" all fail. A span on the patient path is read off `stats.days` through spanNoun()
  // (lib/plural.ts) at the three sites that know how many days arrived, and this step is not one of them.
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  for (const [where, state] of EVERY_STATE) {
    const said = setupCompleteCopy(state);
    assert.doesNotMatch(said.bubble, SPAN, `${where}: the bubble`);
    assert.doesNotMatch(said.lede, SPAN, `${where}: the lede`);
    assert.doesNotMatch(said.hint, SPAN, `${where}: the hint`);
    if (said.action !== null) assert.doesNotMatch(said.action, SPAN, `${where}: the button`);
  }
});

test("the chat's skip link and the goodbye make the same promise as the step, under the same rule", () => {
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  // With glucose both may offer the summary; without it neither may, and neither names a span either way.
  assert.match(skipLinkLabel(true), /view my glucose/i);
  assert.doesNotMatch(skipLinkLabel(false), /view/i, "nothing to view, so the link does not offer it");
  assert.match(skipGoodbye(true), /you can view your glucose now\./i);
  assert.doesNotMatch(skipGoodbye(false), /you can view/i);
  for (const said of [skipLinkLabel(true), skipLinkLabel(false), skipGoodbye(true), skipGoodbye(false)]) {
    assert.doesNotMatch(said, SPAN, said);
  }
});

test("the goodbye still tells the patient what is saved, in both states", () => {
  // The sentence that was always true is the one the route is for: §2.5 makes sharing optional, and a
  // patient who skips the rest has to be told that what they did give is kept. Dropping the overreaching
  // clause must not take that with it.
  for (const said of [skipGoodbye(true), skipGoodbye(false)]) {
    assert.match(said, /skipped the remaining questions/i, said);
    assert.match(said, /saved for your care team/i, said);
  }
});
