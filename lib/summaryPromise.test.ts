import assert from "node:assert/strict";
import test from "node:test";
import { intakeProgressCard, type IntakeEnding, type IntakeProgressInput } from "./intakeProgress";
import {
  checkInCompleteCopy,
  flaggedCardCopy,
  setupCompleteCopy,
  skipDestination,
  skipGoodbye,
  skipLinkLabel,
  type SummaryPromise,
} from "./summaryPromise";

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

test("the skip press goes to the summary on the same condition its label offers one (T137)", () => {
  // The half T133 left behind: the words were fixed and the `router.push` under them was not, so the
  // no-glucose press still landed on `/patient/<token>`. One predicate now answers both, which is what
  // this pair of assertions pins — a label that offers nothing beside a destination that is nowhere.
  assert.equal(skipDestination(true, "tok-123"), "/patient/tok-123");
  assert.equal(skipDestination(false, "tok-123"), null, "nothing to view, so the press goes nowhere");
  // Said once more as the invariant rather than as two literals: wherever the link says "view", there is
  // somewhere to go, and wherever it does not, there is not.
  for (const hasGlucose of [true, false]) {
    const offers = /view/i.test(skipLinkLabel(hasGlucose));
    assert.equal(
      skipDestination(hasGlucose, "tok-123") !== null,
      offers,
      `hasGlucose=${hasGlucose}: the label and the destination disagree`,
    );
    assert.equal(/you can view/i.test(skipGoodbye(hasGlucose)), offers, `hasGlucose=${hasGlucose}: the goodbye`);
  }
});

test("the completion card ends the transcript with the same promise as the rest of the page (T137)", () => {
  // The card the skipped check-in now stays on. Its whole box used to be a link to `/patient/<token>`
  // under "See the summary you'll share with your doctor", on `wrapped` alone — the offer the goodbye
  // above it declines, one line later and in larger type.
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  const glucose = checkInCompleteCopy(true, "answered");
  const none = checkInCompleteCopy(false, "answered");
  assert.match(glucose.detail, /summary/i, "with glucose there is one, and the card may say so");
  assert.doesNotMatch(none.detail, /summary/i, "without glucose the card offers nothing to look at");
  assert.match(none.detail, /saved for your care team/i, "what the patient did share is still acknowledged");
  // The check-in is over in both states, and that is not what the data decides — the ending is (T146).
  assert.equal(glucose.title, none.title);
  assert.match(none.title, /check-in is complete/i);
  for (const said of [glucose, none]) {
    assert.doesNotMatch(said.title, SPAN, said.title);
    assert.doesNotMatch(said.detail, SPAN, said.detail);
  }
});

test("the card ending the transcript does not call a check-in that stopped short complete (T146, §2.5)", () => {
  // The defect: the title was unconditional, so the one state the card is rendered in that is *not* a
  // completed check-in — the patient pressed "Skip the rest of the questions" with one of two answered —
  // was headlined "Your check-in is complete", a viewport under a rail reading "Check-in ended early".
  for (const hasGlucose of [true, false]) {
    const where = `hasGlucose=${hasGlucose}`;
    const skipped = checkInCompleteCopy(hasGlucose, "skipped");
    assert.doesNotMatch(skipped.title, /complete/i, `${where}: a skipped check-in is not complete`);
    assert.match(skipped.title, /ended early/i, `${where}: it says what happened instead`);
    // The sub-line was already right for the skip and is not what T146 changes: it answers the other
    // question, whether there is anything to go and look at.
    assert.equal(skipped.detail, checkInCompleteCopy(hasGlucose, "answered").detail, `${where}: the sub-line`);
    // Answered to the end is the state T137 wrote the card for, and it is untouched.
    assert.match(checkInCompleteCopy(hasGlucose, "answered").title, /check-in is complete/i, where);
  }
});

test("the card's title agrees with the rail on every ending it is rendered for (T142, T146)", () => {
  // Said over the endings rather than on the one that had it, because the bug was two surfaces reading one
  // state differently — and the rail is the surface T142 already made right. Wherever the rail drops the
  // percentage because the check-in stopped short, the card does not say "complete"; wherever the rail
  // reads 100%, it does. `open` is not in the sweep: the page renders this card only once the intake has
  // wrapped, so the title has no state to agree with while Sweetie is still asking.
  const TEMPLATE = { totalFields: 2, office: "Dr. Demo Endo" };
  const states: [IntakeEnding, IntakeProgressInput][] = [
    ["answered", { ...TEMPLATE, completeFields: 2, finished: true, flagged: false, questionsSkipped: false }],
    ["skipped", { ...TEMPLATE, completeFields: 1, finished: true, flagged: false, questionsSkipped: true }],
    ["flagged", { ...TEMPLATE, completeFields: 1, finished: true, flagged: true, questionsSkipped: false }],
  ];
  for (const [ending, input] of states) {
    const rail = intakeProgressCard(input);
    assert.equal(rail.ending, ending, `${ending}: the fixture is the state it is named after`);
    const title = checkInCompleteCopy(false, ending).title;
    assert.equal(
      /complete/i.test(title),
      rail.percent === 100,
      `${ending}: the card says "${title}" and the rail reads ${rail.percent}%`,
    );
  }
});

test("the flagged card offers the summary on the same condition as the rest of the page (T141)", () => {
  // The fifth surface, and the one T137 could not reach: the card the safety scan ends the transcript with
  // is a different branch of the same component, and its anchor to `/patient/<token>` was there on nothing
  // but the flag. With glucose it is T66's line, unchanged; without it there is nowhere to send anyone.
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;
  const glucose = flaggedCardCopy(true, "tok-141");
  const none = flaggedCardCopy(false, "tok-141");
  assert.equal(glucose.href, "/patient/tok-141");
  assert.equal(none.href, null, "nothing to view, so the card offers nowhere to go");
  assert.equal(glucose.detail, "See what you've shared so far", "T66's wording is not what T141 changes");
  // Not silence: the patient has just been told to call someone, so what reached their care team is the
  // one thing the card can still tell them. The same sentence the completion card uses, said once.
  assert.equal(none.detail, checkInCompleteCopy(false, "flagged").detail);
  assert.match(none.detail, /saved for your care team/i);
  assert.doesNotMatch(none.detail, /summary|see what/i, "without glucose the card offers nothing to look at");
  for (const said of [glucose, none]) assert.doesNotMatch(said.detail, SPAN, said.detail);
});

test("every surface of the promise holds the invariant: an offer where there is a destination (T133, T137, T141)", () => {
  // Said once for the whole module rather than per surface, because a sixth surface is how the last three
  // tickets each arrived: wherever one of these says the patient can go and look, `skipDestination` has
  // somewhere for them to go, and wherever it does not, nothing on the page does either.
  for (const hasGlucose of [true, false]) {
    const destination = skipDestination(hasGlucose, "tok-141");
    const where = `hasGlucose=${hasGlucose}`;
    const offers = destination !== null;
    assert.equal(setupCompleteCopy({ hasConnections: true, hasGlucose }).action !== null, offers, `${where}: the setup step`);
    assert.equal(/view/i.test(skipLinkLabel(hasGlucose)), offers, `${where}: the skip link`);
    assert.equal(/you can view/i.test(skipGoodbye(hasGlucose)), offers, `${where}: the goodbye`);
    assert.equal(/summary/i.test(checkInCompleteCopy(hasGlucose, "answered").detail), offers, `${where}: the completion card`);
    assert.equal(flaggedCardCopy(hasGlucose, "tok-141").href !== null, offers, `${where}: the flagged card`);
    // And the words the flagged card leads with are an offer exactly when there is one behind them.
    assert.equal(/see what/i.test(flaggedCardCopy(hasGlucose, "tok-141").detail), offers, `${where}: its words`);
  }
});
