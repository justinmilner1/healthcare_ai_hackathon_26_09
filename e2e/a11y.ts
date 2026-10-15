import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

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
