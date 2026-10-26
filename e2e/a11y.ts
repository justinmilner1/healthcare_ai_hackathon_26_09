import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { contrastRatio } from "../lib/contrast";

// The axe pass the patient pages are held to (design §6.4, §12.5). One helper, so every patient screen is
// judged by the same rules and a failure reads as a list of things to fix rather than a JSON dump.
//
// WCAG 2.1 AA is the bar §6.4 names, so those are the tags: axe's own `wcag2a`/`wcag2aa` plus the 2.1
// additions (`wcag21a`, `wcag21aa`). `best-practice` is deliberately left out — it is advice, not the
// standard, and a ticket that fails on advice stops being a ticket about WCAG.

/** The tags that make up WCAG 2.1 AA in axe's rule metadata. */
export const WCAG21AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/** §12.5's bar: nothing serious, and nothing worse. Moderate findings are reported, not failed on. */
const FAILING_IMPACTS = new Set(["serious", "critical"]);

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: unknown[]; failureSummary?: string }[];
};

/** One line per failing node, so the test output names the element and the fix. */
function describe(violations: Violation[]): string {
  return violations
    .map((violation) => {
      const where = violation.nodes
        .map((node) => `      ${node.target.join(" ")}\n        ${(node.failureSummary ?? "").split("\n").join("\n        ").trim()}`)
        .join("\n");
      return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n    ${violation.helpUrl}\n${where}`;
    })
    .join("\n");
}

/**
 * Run axe over the page as it stands and fail on anything serious or critical.
 *
 * `disableRules` is for a rule whose finding is not this page's to fix; every use needs a reason next to it.
 * `include` narrows the scan to a region, for a screen whose surroundings are checked by another test.
 */
export async function expectNoSeriousA11yViolations(
  page: Page,
  name: string,
  options: { disableRules?: string[]; include?: string } = {},
): Promise<void> {
  // Let the page settle first. axe reads the colours the page is painting *now*, so a scan that lands
  // mid-transition measures an interpolated colour: an entry fade on the intake step turns `--muted`
  // (#756a72, 5.6:1 on white) into #82787f (4.24:1) and the colour-contrast rule fails on a colour the
  // stylesheet never names. It shows up as a test that passes on a fast machine and fails on a slow one.
  // Bounded, because a deliberate looping animation (a spinner, a pulse) never finishes.
  await page.evaluate(async () => {
    const finished = document.getAnimations().map((animation) => animation.finished.catch(() => undefined));
    await Promise.race([Promise.all(finished), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  });

  let builder = new AxeBuilder({ page }).withTags([...WCAG21AA]);
  if (options.include) builder = builder.include(options.include);
  if (options.disableRules?.length) builder = builder.disableRules(options.disableRules);

  const results = await builder.analyze();
  const serious = (results.violations as Violation[]).filter((violation) =>
    FAILING_IMPACTS.has(violation.impact ?? ""),
  );
  const moderate = (results.violations as Violation[]).filter(
    (violation) => !FAILING_IMPACTS.has(violation.impact ?? ""),
  );
  if (moderate.length) {
    // Not a failure (§12.5 says serious), but a reviewer reading the log should still see it.
    console.warn(`axe on ${name}: ${moderate.length} non-serious finding(s)\n${describe(moderate)}`);
  }
  // Compared as rule ids, not as the violation objects: a failing `toEqual` prints both sides, and axe's
  // objects are hundreds of lines of nested detail each. The names go in the assertion, the detail in the
  // message underneath it.
  const names = serious.map((violation) => violation.id).sort();
  expect(names, `axe found serious accessibility violations on ${name}:\n${describe(serious)}`).toEqual([]);
}

/**
 * Walk the tab order until `target` holds focus.
 *
 * Tab rather than `locator.focus()`, because `:focus-visible` is a claim about *how* an element was focused
 * and not about whether it is: a script focus after a click keeps the pointer modality and matches nothing,
 * so the ring under test would read as absent on a page that paints it perfectly for a real keyboard user.
 *
 * `from` is where the walk starts, and defaults to the top of the document. A dialog needs it: the §2.2
 * wizard is `aria-modal` without trapping focus, so the tab order into it runs through the whole dashboard
 * behind it — a table that grows a row with every visit the suite books, which would make the number of
 * presses a property of how many tests ran first. Starting inside the dialog costs nothing the ring cares
 * about: the press that lands on the target is still a Tab.
 */
export async function tabUntilFocused(
  page: Page,
  target: Locator,
  options: { from?: Locator; limit?: number } = {},
): Promise<void> {
  const { from, limit = 40 } = options;
  if (from) await from.focus();
  else await page.locator("body").press("Tab");
  for (let step = 0; step < limit && !(await target.evaluate((node) => node === document.activeElement)); step++) {
    await page.keyboard.press("Tab");
  }
  await expect(target, "the tab order never reached this control").toBeFocused();
}

/** What a card is painting around itself: `getComputedStyle`'s outline, read off the live page. */
async function outlineOf(card: Locator): Promise<{ style: string; width: number; color: string }> {
  return card.evaluate((node) => {
    const computed = getComputedStyle(node);
    return {
      style: computed.outlineStyle,
      width: Number.parseFloat(computed.outlineWidth),
      color: computed.outlineColor,
    };
  });
}

/**
 * A control that hides its native input inside a styled label shows a focus indicator on the *card* when
 * the input is focused from the keyboard (T166, design §6.4).
 *
 * This is the half of §6.4 axe cannot reach. Its colour-contrast rule measures text against a background;
 * a focus ring is neither, so a card whose input is `opacity: 0` and whose stylesheet says nothing about
 * `:focus-visible` is a keyboard dead end that every automated pass calls clean. So the ring is measured
 * here: present, thick enough to see, and — composited, because a translucent ring paints a colour it does
 * not name — past the 3:1 WCAG asks of a non-text indicator against the surface it is drawn on.
 *
 * `against` is that surface, which has to be given rather than read: these cards sit on gradients, where
 * `backgroundColor` is `rgba(0, 0, 0, 0)` and the colour under any one edge of the ring is not a property
 * of any element.
 */
export async function expectVisibleFocusRing(
  page: Page,
  card: Locator,
  options: { name: string; against: string; from?: Locator },
): Promise<void> {
  const { name, against, from } = options;
  await tabUntilFocused(page, card.locator("input"), { from });

  const ring = await outlineOf(card);
  expect(ring.style, `${name}: the card paints no outline while its hidden input has focus`).not.toBe("none");
  expect(ring.width, `${name}: a focus ring under 2px is not one a keyboard user can follow`).toBeGreaterThanOrEqual(2);
  expect(
    contrastRatio(ring.color, against),
    `${name}: the ring is ${ring.color} on ${against}, under the 3:1 WCAG 1.4.11 asks of a non-text indicator`,
  ).toBeGreaterThanOrEqual(3);
}

/**
 * And the other half of the claim: the indicator belongs to focus alone, so a card that does not have it
 * paints no ring — whatever else it is (selected, connected, under the pointer).
 *
 * Without this the first assertion passes on a stylesheet that rings every card all the time, which is the
 * picture T77 is about: a committed screenshot in which a second card looks chosen.
 */
export async function expectNoFocusRing(card: Locator, name: string): Promise<void> {
  const ring = await outlineOf(card);
  expect(ring.style, `${name}: this card is not the focused one and should paint no ring`).toBe("none");
}
