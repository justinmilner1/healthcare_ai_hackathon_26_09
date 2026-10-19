import { expect, test, type Page } from "@playwright/test";

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
 * A row nobody loses the end of: every control inside `selector` is whole, and none sits on another.
 *
 * expectNoHorizontalScroll cannot see this, by its own design above. `.ss-page` is `overflow: hidden`, so a
 * row wider than the screen is clipped rather than scrolled and `document.scrollWidth` never moves — an
 * admin's top bar ran past the right edge with the "Sour" wordmark under "Add patient" and "Sign out" cut in
 * half, and §6.5's measurement passed on it for two months (T79). So this measures the controls instead, and
 * asks the two questions a clipped row makes it impossible to answer from the document: is any of them over
 * the edge, and is any of them hidden behind another.
 *
 * Overlap is judged between the leaves — the links and buttons a person actually presses — because the
 * containers around them hold each other by design. Half a pixel of slack on both, for the same reason
 * expectTapTargets takes it: these boxes are fractional and two that merely touch are not overlapping.
 *
 * On a phone those same leaves are measured against TAP as well, which is the other half of the question a
 * crowded row asks: the cheap way to make four actions fit 375px is to shrink them below a thumb, and that
 * trades one §6.5 failure for another. Desktop is exempt, like every other width rule here — the buttons
 * are smaller there on purpose and §6.5 is about the phone.
 */
export async function expectRowIntact(page: Page, selector: string, screen: string): Promise<void> {
  const row = page.locator(selector).first();
  await expect(row, `${screen}: no row matched ${selector}`).toBeVisible();
  const measured = await row.evaluate((element, min) => {
    const limit = document.documentElement.clientWidth;
    const name = (node: Element): string => {
      const text = (node.getAttribute("aria-label") ?? node.textContent ?? "").trim().replace(/\s+/g, " ");
      return `${node.tagName.toLowerCase()} "${text.slice(0, 28)}"`;
    };
    const shown = [element, ...Array.from(element.querySelectorAll<HTMLElement>("a[href], button"))].filter(
      (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      },
    );
    const clipped = shown
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.left < -0.5 || box.right > limit + 0.5;
      })
      .map((node) => {
        const box = node.getBoundingClientRect();
        return `${name(node)} [${Math.round(box.left)}…${Math.round(box.right)}]`;
      });
    const leaves = shown.filter((node) => node !== element && !node.querySelector("a[href], button"));
    const stacked: string[] = [];
    for (let i = 0; i < leaves.length; i += 1) {
      for (let j = i + 1; j < leaves.length; j += 1) {
        const a = leaves[i].getBoundingClientRect();
        const b = leaves[j].getBoundingClientRect();
        if (a.right > b.left + 0.5 && a.left + 0.5 < b.right && a.bottom > b.top + 0.5 && a.top + 0.5 < b.bottom) {
          stacked.push(`${name(leaves[i])} over ${name(leaves[j])}`);
        }
      }
    }
    const small = leaves
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width + 0.5 < min || box.height + 0.5 < min;
      })
      .map((node) => {
        const box = node.getBoundingClientRect();
        return `${name(node)} ${Math.round(box.width)}×${Math.round(box.height)}`;
      });
    return { clipped, stacked, small, limit };
  }, TAP);
  expect(
    measured.clipped,
    `${screen}: cut off at the ${measured.limit}px edge, where \`.ss-page\`'s overflow: hidden hides it (T79, design §6.5)`,
  ).toEqual([]);
  expect(measured.stacked, `${screen}: controls on top of one another (T79, design §6.5)`).toEqual([]);
  if (test.info().project.name === "mobile") {
    expect(measured.small, `${screen}: controls under ${TAP}px (T79, design §6.5)`).toEqual([]);
  }
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

/**
 * The least room design §6.5 leaves Sweetie's transcript on a phone, in CSS pixels.
 *
 * Not a design figure — a regression gate. The page is `height: 100svh` with `overflow: hidden` above it, so
 * every fixed row on it (the top bar, the demo-mode card, the progress strip, the stepper, the composer, the
 * caption) is spent out of the same 667 pixels, and the transcript is the one element that takes what is
 * left. Nothing stopped that remainder reaching zero: it was 103 pixels when T83 was written, less than a
 * third of Sweetie's opening message, and the three mobile shots of her in that run were all of a greeting
 * cut through the middle of a line. A row added to this page without a cut somewhere else now fails here
 * rather than in a screenshot nobody measures.
 *
 * The number is the floor for the *worst* state of the screen rather than for its first one, because the
 * page's own chrome grows as the check-in goes on. Measured on the tree that fixed T83: 251px on the
 * opening screen and 200px once the patient has answered and "Skip the rest and view my week" has taken a
 * 44px row of the strip. A safety flag is the third state — it drops the skip link but wraps the stepper
 * onto a second line for its fourth pill — and e2e/mobile.spec.ts measures all three. 190 clears them and
 * still fails on anything that takes another row.
 */
export const TRANSCRIPT_ROOM = 190;

/**
 * The newest thing Sweetie or the patient said is not cut off at the top of the transcript (T83, §6.5).
 *
 * The transcript is its own scrolling region and moves itself to the newest message, so what it is showing
 * is a layout question and not only a CSS one. Two things are asked of it. The first line of the newest
 * message is on screen — a message taller than the region shows its beginning, which is where the patient
 * starts reading, rather than its end over a first line sliced through the glyphs. And a message that fits
 * the region is in it whole, which is the same statement as "the region scrolled to its end" for anything
 * short enough.
 *
 * Both are measured against the region's own box rather than the viewport's, because the region is what
 * scrolls: an older message half out of the top of it is the patient having read on, not a defect.
 *
 * The room check is the phone's alone — a desktop transcript is half the window — but the two fit checks
 * hold at any width, which is why the specs that drive the whole conversation call this too.
 */
export async function expectTranscriptUncut(page: Page, screen: string): Promise<void> {
  const transcript = page.locator(".sweetie-messages");
  await expect(transcript, `${screen}: no transcript on the page`).toBeVisible();
  const measure = () =>
    transcript.evaluate((element) => {
      const newest = element.lastElementChild;
      if (!newest) return null;
      const region = element.getBoundingClientRect();
      const box = newest.getBoundingClientRect();
      const style = getComputedStyle(element);
      const top = Number.parseFloat(style.paddingTop);
      const padding = top + Number.parseFloat(style.paddingBottom);
      const fits = box.height + padding <= element.clientHeight + 1;
      const below = Math.round(Math.max(0, box.bottom - region.bottom));
      const above = Math.round(Math.max(0, region.top - box.top));
      return {
        above,
        below,
        fits,
        // Zero once the region has stopped moving: a message that fits is in the region whole, and one that
        // does not sits with its first line at the top of it. Anything else is a glide still in flight,
        // which is what the poll below waits out.
        settling: fits
          ? above + below
          : Math.round(Math.abs((newest as HTMLElement).offsetTop - top - element.scrollTop)),
        newest: Math.round(box.height),
        region: Math.round(region.height),
        text: (newest.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      };
    });
  // The region glides rather than jumps (§6.4), so the first read can be of a scroll still in flight — and
  // `above` is zero throughout a downward glide, which makes it useless as the thing to wait on.
  await expect
    .poll(async () => (await measure())?.settling, {
      message: `${screen}: the transcript never settled on the newest message`,
    })
    .toBeLessThanOrEqual(1);
  const fit = await measure();
  if (!fit) throw new Error(`${screen}: the transcript is empty, so there is nothing to measure`);
  expect(
    fit.above,
    `${screen}: "${fit.text}…" is cut off at the top of the transcript, ${fit.above}px of it above the region (T83, design §6.5)`,
  ).toBe(0);
  if (fit.fits) {
    expect(
      fit.below,
      `${screen}: "${fit.text}…" (${fit.newest}px) fits the transcript (${fit.region}px) and is still cut off at the bottom of it`,
    ).toBe(0);
  }
  if (test.info().project.name === "mobile") {
    expect(
      fit.region,
      `${screen}: the transcript is ${fit.region}px of the 375x667 screen, under the ${TRANSCRIPT_ROOM}px design §6.5 leaves it (T83)`,
    ).toBeGreaterThanOrEqual(TRANSCRIPT_ROOM);
  }
}

/** The four checks together, which is what every screen in e2e/mobile.spec.ts wants. */
export async function expectMobileReady(page: Page, screen: string, stepper?: string): Promise<void> {
  await expectNoHorizontalScroll(page, screen);
  await expectNothingScrollsSideways(page, screen);
  if (stepper) await expectStepperFits(page, stepper, screen);
  await expectTapTargets(page, screen);
}
