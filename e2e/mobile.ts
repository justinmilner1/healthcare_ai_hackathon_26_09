import { expect, type Page } from "@playwright/test";

// The three measurements design §6.5 asks of the patient pages, written once so every screen is judged the
// same way (T23). playwright.config.ts pins the mobile project's viewport to 375px, which is the width the
// section names; these helpers skip themselves on the desktop project so a spec can call them unguarded.

/** The smallest comfortable touch target: 44 CSS pixels square. */
export const TAP = 44;

type Box = { label: string; width: number; height: number };

/**
 * Nothing sticks out sideways: the document is no wider than the viewport.
 *
 * The assertion is on the document, because that is what a patient feels as the page sliding under their
 * thumb — an element wider than the screen inside an `overflow: hidden` parent is clipped, not scrolled, and
 * is not what §6.5 is about. The elements that do reach past the right edge are collected anyway and printed
 * in the failure, because "scrollWidth is 441" on its own names nothing to fix.
 */
export async function expectNoHorizontalScroll(page: Page, screen: string): Promise<void> {
  const measured = await page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth;
    const over: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= limit + 1 && box.left >= -1) continue;
      const id = element.id ? `#${element.id}` : "";
      const cls = element.className && typeof element.className === "string"
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
      over.push(`${element.tagName.toLowerCase()}${id}${cls} [${Math.round(box.left)}…${Math.round(box.right)}]`);
      if (over.length >= 8) break;
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: limit, over };
  });
  expect(
    measured.scrollWidth,
    `${screen} scrolls sideways at ${measured.clientWidth}px (design §6.5). Past the right edge:\n  ${measured.over.join("\n  ")}`,
  ).toBeLessThanOrEqual(measured.clientWidth);
}

/**
 * And nothing inside the page hides content behind a sideways scroll of its own.
 *
 * The document can sit still while a card inside it does not: the stepper and the spike table are both
 * `overflow-x: auto`, so at 375px they clipped their own content — the later steps, the place a rise
 * happened — where expectNoHorizontalScroll could not see it. This asks every element that *can* scroll
 * sideways whether it is actually doing so.
 */
export async function expectNothingScrollsSideways(page: Page, screen: string): Promise<void> {
  const scrollers: string[] = await page.evaluate(() => {
    const found: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const overflow = getComputedStyle(element).overflowX;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      const cls = typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
      found.push(`${element.tagName.toLowerCase()}${cls} (${element.scrollWidth}px inside ${element.clientWidth}px)`);
    }
    return found;
  });
  expect(scrollers, `${screen}: content hidden behind a sideways scroll (design §6.5)`).toEqual([]);
}

/**
 * A stepper that fits: the element is no wider than its own scroll box.
 *
 * The steppers are `overflow-x: auto`, so a stepper that does not fit hides its later steps behind a scroll
 * the patient has to find — which is the thing §6.5 rules out. Measured on the element rather than on the
 * page for exactly that reason: it can overflow without the document moving at all.
 */
export async function expectStepperFits(page: Page, selector: string, screen: string): Promise<void> {
  const stepper = page.locator(selector).first();
  await expect(stepper, `${screen}: no stepper matched ${selector}`).toBeVisible();
  const measured = await stepper.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(
    measured.scrollWidth,
    `${screen}: the stepper (${selector}) is ${measured.scrollWidth}px inside ${measured.clientWidth}px, so later steps are behind a sideways scroll (design §6.5)`,
  ).toBeLessThanOrEqual(measured.clientWidth);
}

/**
 * Every control a thumb has to hit is at least 44px square.
 *
 * "Control" is buttons, links, and form fields that are their own block — the things a patient taps on
 * purpose. A link sitting inside a sentence is left out: its target is the line of text it is part of, and
 * padding it to 44px would break the paragraph around it rather than make anything easier to hit. That is
 * the same exemption WCAG 2.5.8 makes for inline targets, and it is decided from layout (`display: inline`
 * with text on both sides), not from a list of selectors, so a control cannot slip through by being renamed.
 */
export async function expectTapTargets(page: Page, screen: string): Promise<void> {
  const small: Box[] = await page.evaluate((min) => {
    const selector = "button, a[href], input, select, textarea, summary, label, [role='button'], [role='link']";
    const tooSmall: Box[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      // A file input is hidden on purpose on both upload screens — the card or chip wrapping it is what a
      // patient taps — so the input is skipped and its label is measured instead. Every other label is the
      // text beside a field whose own box is already in this list, and is not a target of its own.
      if (element instanceof HTMLInputElement && element.type === "file") continue;
      if (element instanceof HTMLLabelElement) {
        const control = element.control ?? element.querySelector("input");
        if (!(control instanceof HTMLInputElement) || control.type !== "file") continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // Inline text links: part of a sentence, exempt. `display: inline` is the test, and a link that is the
      // whole of its paragraph is not exempt — it is a control that happens to be written as a link.
      if (style.display === "inline") {
        const parent = element.parentElement;
        const around = parent ? (parent.textContent ?? "").trim().length : 0;
        const own = (element.textContent ?? "").trim().length;
        if (parent && around > own) continue;
      }
      // Half a pixel of slack, and the same rounding in the verdict as in the message. A 44px box on a
      // 2.625x phone screen is 115.5 device pixels, which Chromium snaps to 115 or 116 depending on where
      // the element happens to sit — so an exactly-44px control measures 43.81 about half the time, and
      // without the slack this fails while printing "44".
      if (box.width + 0.5 >= min && box.height + 0.5 >= min) continue;
      const label = (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || element.tagName).trim().slice(0, 40);
      tooSmall.push({ label: `${element.tagName.toLowerCase()} "${label}"`, width: Math.round(box.width), height: Math.round(box.height) });
    }
    return tooSmall;
  }, TAP);
  expect(
    small.map((box) => `${box.label} ${box.width}×${box.height}`),
    `${screen}: controls under ${TAP}px (design §6.5)`,
  ).toEqual([]);
}

/** The four checks together, which is what every screen in e2e/mobile.spec.ts wants. */
export async function expectMobileReady(page: Page, screen: string, stepper?: string): Promise<void> {
  await expectNoHorizontalScroll(page, screen);
  await expectNothingScrollsSideways(page, screen);
  if (stepper) await expectStepperFits(page, stepper, screen);
  await expectTapTargets(page, screen);
}
