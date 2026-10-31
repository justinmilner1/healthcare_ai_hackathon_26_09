import assert from "node:assert/strict";
import test from "node:test";
import { prohibitedNames, prohibitsName } from "./ariaName";

// T209 (design §6.4, §12.5): the rule T207 found the hard way, held to the cases that produced it.

test("a role-less div cannot carry a name — the shape of all five sites", () => {
  // §2.7's stat row (T207), Sweetie's typing indicator, the two steppers and the landing visual (T209).
  assert.equal(prohibitsName({ tag: "div" }), true);
  assert.equal(prohibitsName({ tag: "DIV" }), true, "tag names come back upper-case from the DOM");
  assert.equal(prohibitsName({ tag: "div", role: null }), true);
  assert.equal(prohibitsName({ tag: "div", role: "" }), true, "an emptied role is not a role");
  assert.equal(prohibitsName({ tag: "div", role: "   " }), true);
});

test("the roles that fix those sites are allowed a name", () => {
  // The three answers T209's first criterion offers, and the two it was fixed with.
  for (const role of ["group", "status", "list", "listitem", "region", "navigation", "log"]) {
    assert.equal(prohibitsName({ tag: "div", role }), false, role);
  }
  // A <section> with a name *is* a region, so naming it is the fix and not the fault.
  assert.equal(prohibitsName({ tag: "section" }), false);
  assert.equal(prohibitsName({ tag: "ol" }), false, "an ordered list is a list, and a list can be named");
  assert.equal(prohibitsName({ tag: "nav" }), false);
  assert.equal(prohibitsName({ tag: "button" }), false);
  assert.equal(prohibitsName({ tag: "input" }), false);
});

test("an explicit role decides it, in both directions", () => {
  // A promising tag with a prohibited role: the name is dropped anyway.
  assert.equal(prohibitsName({ tag: "section", role: "presentation" }), true);
  assert.equal(prohibitsName({ tag: "ol", role: "none" }), true);
  assert.equal(prohibitsName({ tag: "button", role: "generic" }), true);
  // And the reverse, which is the fix: a prohibited tag given a role that may be named.
  assert.equal(prohibitsName({ tag: "div", role: "group" }), false);
  assert.equal(prohibitsName({ tag: "p", role: "status" }), false);
});

test("the first token of a role list is the one that counts", () => {
  assert.equal(prohibitsName({ tag: "div", role: "none presentation" }), true);
  assert.equal(prohibitsName({ tag: "div", role: "group listitem" }), false);
  assert.equal(prohibitsName({ tag: "div", role: "  STATUS  " }), false, "case and padding are the DOM's");
});

test("the other prohibited implicit roles, so a reworded fix cannot land on one", () => {
  // A label moved off a div and onto the nearest piece of prose is the obvious wrong fix: <p>, <em>,
  // <strong>, <small> and <span> are all as unnameable as the div was.
  for (const tag of ["p", "span", "em", "strong", "small", "code", "time", "b", "i", "figcaption", "dfn"]) {
    assert.equal(prohibitsName({ tag }), true, tag);
  }
});

test("context-dependent mappings are left alone rather than guessed", () => {
  // <header>/<footer> are generic inside sectioning content and banner/contentinfo outside it, and a tag
  // name cannot say which. The rule answers "yes" only where it is certain, so these are not offenders.
  assert.equal(prohibitsName({ tag: "header" }), false);
  assert.equal(prohibitsName({ tag: "footer" }), false);
  assert.equal(prohibitsName({ tag: "aside" }), false);
});

test("prohibitedNames keeps the offenders and nothing else", () => {
  const scanned = [
    { tag: "DIV", role: null, label: "Setup progress", where: ".ss-stepper" },
    { tag: "OL", role: null, label: "Intake steps", where: ".sweetie-field-progress" },
    { tag: "DIV", role: "status", label: "Sweetie is typing", where: ".sweetie-typing" },
    { tag: "DIV", role: null, label: "Meet Sweetie and Sour", where: ".home-visual" },
  ];
  assert.deepEqual(
    prohibitedNames(scanned).map((element) => element.where),
    [".ss-stepper", ".home-visual"],
  );
  // The whole of the claim a page is held to: nothing on it is in this bucket.
  assert.deepEqual(prohibitedNames([]), []);
  assert.deepEqual(prohibitedNames(scanned.filter((element) => element.role)), []);
});
