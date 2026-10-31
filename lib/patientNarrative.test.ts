import assert from "node:assert/strict";
import test from "node:test";
import { patientPatternsSubtitle, patientQuestionsSubtitle } from "./patientNarrative";

/** The counts §7 can produce: `lib/prompts.ts` asks for 1 to 3 of each and `lib/sourRun.ts` clamps at 3. */
const ONE = ["Your readings were steady all week."];
const TWO = [...ONE, "Three of four overnight highs followed dinners out after 8pm."];
const THREE = [...TWO, "Mornings after short nights ran about 20 mg/dL higher."];

const ONE_Q = ["Should I keep the same evening dose?"];
const TWO_Q = [...ONE_Q, "Is 7 hours of sleep enough for me?"];
const THREE_Q = [...TWO_Q, "Would a different breakfast help the mid-morning rise?"];

test("the patterns card does not call a single pattern 'a few', or claim a relation between one thing", () => {
  const one = patientPatternsSubtitle(ONE);
  assert.equal(one, "A pattern worth noticing.");
  // The two words the ticket is about, each named rather than left to the equality above: a reword that
  // keeps the sentence but puts either of them back fails here.
  assert.doesNotMatch(one, /a few/i);
  assert.doesNotMatch(one, /together/i);
  assert.doesNotMatch(one, /patterns/i);
});

test("and says what it has always said over two and three (AC1)", () => {
  assert.equal(patientPatternsSubtitle(TWO), "A few patterns worth noticing together.");
  assert.equal(patientPatternsSubtitle(THREE), "A few patterns worth noticing together.");
});

test("the questions card does not call a single question 'these' or 'them'", () => {
  const one = patientQuestionsSubtitle(ONE_Q);
  assert.equal(one, "Bring this into your visit, or use it as a starting point.");
  // Both pronouns, separately: T200's bug was a sentence fixed in its first clause and left plural in the
  // second, and the equality above is the only thing that would have caught that by accident.
  assert.doesNotMatch(one, /\bthese\b/i);
  assert.doesNotMatch(one, /\bthem\b/i);
});

test("and says what it has always said over two and three (AC2)", () => {
  assert.equal(patientQuestionsSubtitle(TWO_Q), "Bring these into your visit, or use them as a starting point.");
  assert.equal(patientQuestionsSubtitle(THREE_Q), "Bring these into your visit, or use them as a starting point.");
});

test("both sentences are one sentence read at two counts, not two voices", () => {
  // What the agreement is allowed to change is the words that have to agree, and nothing else. The shared
  // tail is what keeps a later reword of one branch from leaving the page saying two different things about
  // the same card at two different counts.
  for (const [n, items] of [[1, ONE], [2, TWO], [3, THREE]] as const) {
    assert.match(patientPatternsSubtitle(items), /worth noticing/, `patterns at ${n}`);
  }
  for (const [n, items] of [[1, ONE_Q], [2, TWO_Q], [3, THREE_Q]] as const) {
    assert.match(patientQuestionsSubtitle(items), /^Bring .* into your visit, or use .* as a starting point\.$/, `questions at ${n}`);
  }
});

test("the count is the array's, so the sentence cannot disagree with the list it sits over", () => {
  // The page hands each function the same array it maps the list items from (app/patient/[id]/page.tsx), so
  // what is pinned here is that the length is the only input: the contents do not move either sentence.
  assert.equal(patientPatternsSubtitle(["anything at all"]), patientPatternsSubtitle(ONE));
  assert.equal(patientQuestionsSubtitle(["anything at all"]), patientQuestionsSubtitle(ONE_Q));
  assert.equal(patientPatternsSubtitle(["a", "b"]), patientPatternsSubtitle(TWO));
  assert.equal(patientQuestionsSubtitle(["a", "b"]), patientQuestionsSubtitle(TWO_Q));
});
