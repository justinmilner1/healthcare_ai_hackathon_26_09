// Which elements ARIA forbids an accessible name on — the rule behind T207 and T209, in one place so a
// test can hold a page to it (design §6.4, §12.1, §12.5).
//
// ARIA 1.2 gives every role a "Name From" clause, and for a handful of roles it is **prohibited**: the role
// describes a stretch of markup rather than a thing a user can act on or be told about, so there is nothing
// for a name to be the name of. `aria-label` on such an element is not a smaller mistake than a wrong label;
// the name is *dropped*, so nobody hears it and nobody notices it is wrong. That is the mechanism T207 found
// under §2.7's stat row — `aria-label="Week at a glance"` on a role-less `<div>`, announced by nothing,
// contradicting the `History / 1 / day` tile inside it for two tickets — and T209 found four more sites of.
//
// A role-less `<div>` is the common case, because its implicit role is `generic`, which is on the list. The
// fix is never to delete the attribute and move on: either the element takes a role ARIA lets be named
// (`group`, `status`, a list, a `<section>`), or the words move onto visible text, or — when the label says
// nothing a user needs — it goes.
//
// axe knows this rule (`aria-prohibited-attr`, `wcag2a`/`wcag412`) but files it as *incomplete* rather than
// as a violation whenever the badly-named element contains text, because it cannot be sure the text is not
// itself serving as the name. `e2e/a11y.ts` fails the patient pages on those incompletes for that reason.
// This module is the other half: a rule plain enough to assert on a provider or landing surface, where a
// full axe pass would be out of proportion to one attribute (T209).

/**
 * The roles ARIA 1.2 states an accessible name is **prohibited** on.
 *
 * Taken from the specification's role definitions rather than from axe, so it can be read against the
 * standard: `caption`, `code`, `deletion`, `emphasis`, `generic`, `insertion`, `paragraph`, `presentation`
 * (and its synonym `none`), `strong`, `subscript`, `superscript`, `term`, `time`.
 */
const NAME_PROHIBITED_ROLES: ReadonlySet<string> = new Set([
  "caption",
  "code",
  "deletion",
  "emphasis",
  "generic",
  "insertion",
  "none",
  "paragraph",
  "presentation",
  "strong",
  "subscript",
  "superscript",
  "term",
  "time",
]);

/**
 * HTML elements whose *implicit* role is one of the above, so a bare `aria-label` on them is dropped.
 *
 * Deliberately a subset of HTML-AAM, and deliberately only the elements whose mapping does not depend on
 * where they sit in the document. `<header>` and `<footer>` are `generic` inside sectioning content and
 * `banner`/`contentinfo` outside it; `<section>` is `generic` until it has a name and `region` once it has
 * one, which makes naming it the fix rather than the fault (and is why `<section>` is one of the three
 * answers above). Neither can be decided from a tag name, so neither is here: this set answers "yes,
 * prohibited" and leaves everything it cannot be sure of alone.
 */
const IMPLICITLY_PROHIBITED_TAGS: ReadonlySet<string> = new Set([
  // role=generic
  "b",
  "bdi",
  "bdo",
  "data",
  "div",
  "i",
  "kbd",
  "pre",
  "q",
  "samp",
  "small",
  "span",
  "u",
  "var",
  // role=paragraph
  "p",
  // one role each
  "caption", // caption
  "code", // code
  "del", // deletion
  "em", // emphasis
  "figcaption", // caption
  "ins", // insertion
  "strong", // strong
  "sub", // subscript
  "sup", // superscript
  "time", // time
  "dfn", // term
]);

/** An element as this rule needs to see it: its tag name and whatever its `role` attribute says. */
export type RoleCarrier = { tag: string; role?: string | null };

/**
 * The role token that counts, out of a `role` attribute.
 *
 * `role` is a space-separated list of fallbacks and the first *valid* token wins; this takes the first
 * token, which is the same thing for every value anything in this repository writes, and `undefined` for an
 * attribute that is absent or all whitespace. An empty `role=""` is not a role, so the implicit one applies
 * — which is the case a `role` added and then emptied leaves behind.
 */
function explicitRole(role: string | null | undefined): string | undefined {
  const first = (role ?? "").trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : undefined;
}

/**
 * Does ARIA prohibit an accessible name on this element?
 *
 * An explicit `role` decides it on its own: a role on the prohibited list is a dropped name however
 * promising the tag was, and any other role is taken at its word — this rule's job is to be certain when it
 * says yes, not to re-implement the whole of HTML-AAM. With no role, the tag's implicit role answers.
 */
export function prohibitsName(element: RoleCarrier): boolean {
  const role = explicitRole(element.role);
  if (role) return NAME_PROHIBITED_ROLES.has(role);
  return IMPLICITLY_PROHIBITED_TAGS.has(element.tag.trim().toLowerCase());
}

/**
 * The elements out of `elements` that carry a name ARIA will not let them have.
 *
 * The input is every element on a page that has an `aria-label` or an `aria-labelledby` — the caller does
 * that collecting, because in a test it happens in the browser — and the output is the ones whose name is
 * therefore announced by nothing. An empty array is the whole of the claim: a page either has such an
 * element or it does not.
 */
export function prohibitedNames<T extends RoleCarrier>(elements: readonly T[]): T[] {
  return elements.filter((element) => prohibitsName(element));
}
