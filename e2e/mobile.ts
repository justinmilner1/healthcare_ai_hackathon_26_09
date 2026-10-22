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
 * And the text that names a row is not cut off either (T101, design §6.5, §6.4).
 *
 * expectRowIntact above measures `a[href], button` — the things a person presses — which is the right set
 * for a top bar and blind to a row whose *text* is what hangs over the edge. On practice settings a
 * person's heading is `user.name ?? user.email` (§2.1), and until somebody types a name it is their whole
 * address — nothing fills one in at sign-in (T115, lib/team.ts): one unbreakable token, clipped by the card and by `.ss-page`'s overflow: hidden with no ellipsis
 * and no scrollbar to say that characters were missing. A reader could not tell the row was incomplete.
 *
 * Measured on the element's own box rather than on the glyphs inside it, which is exactly what separates the
 * bug from either fix: a line bounded by `text-overflow: ellipsis` keeps its box inside the cell and says on
 * screen that it was shortened, and a wrapped line keeps its box inside the cell and loses nothing — while
 * an unbounded line's box is the thing over the edge.
 *
 * Judged against the nearest ancestor that clips as well as against the viewport, because either is a place
 * where glyphs end up outside the box painting them: this page's table sits in an `overflow-x: auto` card,
 * and a cell wider than that card hides its end behind a scroll instead of past the screen.
 */
export async function expectTextIntact(page: Page, selector: string, screen: string): Promise<void> {
  const rows = page.locator(selector);
  await expect(rows.first(), `${screen}: nothing matched ${selector}`).toBeVisible();
  const clipped: string[] = await page.evaluate((sel) => {
    const found: string[] = [];
    const viewport = document.documentElement.clientWidth;
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
        const text = (node.textContent ?? "").trim().replace(/\s+/g, " ");
        if (!text) continue;
        // Only the innermost element carrying a run of text: an ancestor's box is its children's put
        // together and says nothing of its own about where the glyphs went.
        if (Array.from(node.children).some((child) => (child.textContent ?? "").trim())) continue;
        const box = node.getBoundingClientRect();
        // A box a pixel or two each way is the visually-hidden pattern (`.sr-only`: 1x1, clipped, read
        // aloud and never painted), not a line of type somebody is trying to read.
        if (box.width < 2 || box.height < 2) continue;
        let right = viewport;
        let left = 0;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX === "visible") continue;
          const edge = parent.getBoundingClientRect();
          right = Math.min(right, edge.right);
          left = Math.max(left, edge.left);
        }
        // Half a pixel of slack, as everywhere else here: these boxes are fractional.
        if (box.right <= right + 0.5 && box.left >= left - 0.5) continue;
        found.push(
          `${node.tagName.toLowerCase()} "${text.slice(0, 44)}" [${Math.round(box.left)}…${Math.round(box.right)}] outside [${Math.round(left)}…${Math.round(right)}]`,
        );
        if (found.length >= 8) return found;
      }
    }
    return found;
  }, selector);
  expect(
    clipped,
    `${screen}: text cut off at an edge with nothing on screen to say so (T101, design §6.5, §6.4)`,
  ).toEqual([]);
}

/**
 * A block whose every part is on screen, not centred somewhere off to the right (T102, design §6.5).
 *
 * `toBeVisible()` cannot answer this. Playwright calls an element visible when it has a box and is not
 * `display: none` — true of the dashboard's empty state at 375px, which was laid out as a `<td colSpan={7}>`
 * of a table that is 1120px wide on purpose and so centred its mascot, its heading, its explanation and its
 * "+ Add first patient" button at about x=560, past the right edge of the phone with the scroller sitting at
 * `scrollLeft: 0`. The card looked like a table that had failed to render.
 *
 * So this measures boxes, the way expectRowIntact does, and asks it of every painted descendant rather than
 * of the controls alone: on an empty state the heading and the one line of explanation are most of the
 * point, and a check that looked only at `a[href], button` would have passed a practice whose clinician may
 * not book (§5.2) — the branch that renders no button at all.
 *
 * Judged against the nearest clipping ancestor as well as the viewport, for the reason expectTextIntact is:
 * content inside an `overflow-x: auto` card is hidden behind a scroll rather than pushed past the screen,
 * and both are a reader not being shown it. Half a pixel of slack on each edge, as everywhere else here.
 */
export async function expectBlockOnScreen(page: Page, selector: string, screen: string): Promise<void> {
  const block = page.locator(selector).first();
  await expect(block, `${screen}: nothing matched ${selector}`).toBeVisible();
  const offScreen: string[] = await block.evaluate((root) => {
    const found: string[] = [];
    const name = (node: Element): string => {
      const text = (node.getAttribute("alt") ?? node.textContent ?? "").trim().replace(/\s+/g, " ");
      return `${node.tagName.toLowerCase()}${text ? ` "${text.slice(0, 32)}"` : ""}`;
    };
    for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      const box = node.getBoundingClientRect();
      // A box a pixel or two each way is the visually-hidden pattern, not something anybody is looking at.
      if (box.width < 2 || box.height < 2) continue;
      let left = 0;
      let right = document.documentElement.clientWidth;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === "visible") continue;
        const edge = parent.getBoundingClientRect();
        left = Math.max(left, edge.left);
        right = Math.min(right, edge.right);
      }
      if (box.left >= left - 0.5 && box.right <= right + 0.5) continue;
      found.push(
        `${name(node)} [${Math.round(box.left)}…${Math.round(box.right)}] outside [${Math.round(left)}…${Math.round(right)}]`,
      );
      if (found.length >= 8) break;
    }
    return found;
  });
  expect(
    offScreen,
    `${screen}: parts of it are off to one side, reachable only by scrolling sideways (T102, design §6.5)`,
  ).toEqual([]);
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
      // patient taps — so the input is skipped and its label is measured instead.
      if (element instanceof HTMLInputElement && element.type === "file") continue;
      // A radio or a checkbox is the 13px dot the browser draws, and the practice settings invite form puts
      // each one inside a label that is a card two lines tall (§2.1): the thumb lands on the card, which the
      // browser forwards to the control, so the card is the target and the dot is not. Only where there is
      // one — a control with no label is nobody's target but its own and is still measured here (T101).
      if (
        element instanceof HTMLInputElement &&
        (element.type === "radio" || element.type === "checkbox") &&
        element.labels?.length
      ) {
        continue;
      }
      // Every other label is the text beside a field whose own box is already in this list, and is not a
      // target of its own.
      if (element instanceof HTMLLabelElement) {
        const control = element.control ?? element.querySelector("input");
        if (!(control instanceof HTMLInputElement)) continue;
        if (control.type !== "file" && control.type !== "radio" && control.type !== "checkbox") continue;
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
 * 44px row of the strip. A safety flag is the third state — it drops the skip link and adds a fourth step
 * pill, which the stepper wraps when it has to — and e2e/mobile.spec.ts measures all three. 190 clears
 * them and still fails on anything that takes another row.
 */
export const TRANSCRIPT_ROOM = 190;

/**
 * The tallest Sweetie's opening message may be, in CSS pixels, to be readable without scrolling (T105).
 *
 * The region's floor above is a floor for the *worst* state of the screen. This is the budget for its
 * *first* state, where only Sweetie's opener is in the transcript, and it is written as the message's own
 * height rather than as "nothing is scrolled out of sight" so that it stays the §6.5 figure whatever chrome
 * the deployment happens to put above the conversation. The opening screen measured 251px on the tree that
 * fixed T83, with the sandbox demo card on it; `.sweetie-messages` spends 15px of that on padding at each
 * end (app/globals.css), which leaves 221 for the bubble.
 *
 * A patient whose practice has a longer name, or whose reason the office recorded at the 280 characters
 * `MAX_REASON` allows, can still be shown a bubble over this. That is what the scroll cue is for
 * (app/s/[token]/page.tsx); this is the gate on the message the product writes for itself.
 */
export const OPENING_BUBBLE_ROOM = 221;

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
 *
 * The room is measured on `.sweetie-transcript`, the box the conversation holds on the screen, rather than
 * on the scrolling region inside it. The two are the same height until the scroll cue appears, and the cue
 * takes its row out of the region (T105, app/globals.css) — so measuring the region would read the cue as
 * the page having lost 20px to new chrome, when the pixels went to telling the patient about the words the
 * region is already too short for and come back as soon as they are read. What the floor is about is how
 * much of a 375px phone §6.5 leaves the conversation, and that is the wrapper either way.
 */
export async function expectTranscriptUncut(page: Page, screen: string): Promise<void> {
  const transcript = page.locator(".sweetie-messages");
  await expect(transcript, `${screen}: no transcript on the page`).toBeVisible();
  const measure = () =>
    transcript.evaluate((element) => {
      const newest = element.lastElementChild;
      if (!newest) return null;
      const region = element.getBoundingClientRect();
      const room = (element.closest(".sweetie-transcript") ?? element).getBoundingClientRect();
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
        room: Math.round(room.height),
        text: (newest.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
      };
    });
  // The region glides rather than jumps (§6.4), so the first read can be of a scroll still in flight — and
  // `above` is zero throughout a downward glide, which makes it useless as the thing to wait on.
  //
  // The wait has to be at least as strict as the assertions under it, or it hands them a state they reject.
  // For a message that fits, `settling` is `above + below`, the two rect readings those assertions want at
  // 0 apiece, so a flat `<= 1` let a glide one pixel from done through: the reviewer run of 2026-10-21 read
  // `expect(fit.below).toBe(0)` holding a 1 on [desktop] e2e/flows.spec.ts:329 ("the stopped check-in"),
  // on a box whose whole check took 6m21s. Zero is not a knife-edge there — `.sweetie-messages` keeps 22px
  // of padding under the newest message (app/globals.css), so once the region has arrived `below` is 0 with
  // room to spare, and anything above it is the 340ms entrance transform or the scroll, both still moving.
  // The branch that does not fit is measured in `offsetTop`, which neither of those touches but a smooth
  // scroll can leave a sub-pixel short of, so it keeps the slack it was given.
  await expect
    .poll(
      async () => {
        const reading = await measure();
        if (!reading) return null;
        return reading.fits ? reading.settling === 0 : reading.settling <= 1;
      },
      { message: `${screen}: the transcript never settled on the newest message` },
    )
    .toBe(true);
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
      fit.room,
      `${screen}: the conversation is ${fit.room}px of the 375x667 screen, under the ${TRANSCRIPT_ROOM}px design §6.5 leaves it (T83)`,
    ).toBeGreaterThanOrEqual(TRANSCRIPT_ROOM);
  }
}

/**
 * What the transcript is hiding, and whether the scroll cue says so (T105, design §6.5, §6.4).
 *
 * The cue's whole job is to be true: it may not announce words that are on the screen, and it may not stay
 * quiet over words that are not. So this measures the thing it is a claim about, by a different route from
 * the page's own arithmetic — a `Range` over the text of the newest message, which gives one rect per line
 * of type, against the bottom edge of the scrolling region.
 *
 * A line counts as hidden when more than half of its line box is under that edge, which is the rule
 * `hidesAnyText` applies (app/s/[token]/page.tsx) read off the lines themselves rather than off the row's
 * box: under half a line box is the leading and the descent space a line keeps below its glyphs, and over
 * it is the bottom of type a patient has not read. The first implementation of the cue measured the row,
 * padding and border and all, and announced a message whose every word was on the screen.
 *
 * Rects rather than the layout coordinates `readMore` uses (app/s/[token]/page.tsx), deliberately: this is
 * the reader's view of the screen, and it is taken after `expectTranscriptUncut` above has waited out both
 * the 340ms entrance transform and the glide, which are the two things rects are wrong about.
 */
export async function transcriptCue(page: Page): Promise<{ lines: number; hiddenLines: number; pastFold: number; cue: boolean }> {
  const measured = await page.locator(".sweetie-messages").evaluate((element) => {
    const newest = element.lastElementChild as HTMLElement | null;
    if (!newest) return { lines: 0, hiddenLines: 0, pastFold: 0 };
    const fold = element.getBoundingClientRect().bottom;
    const bubble = newest.querySelector<HTMLElement>(".sweetie-message") ?? newest;
    const style = getComputedStyle(bubble);
    const box = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16;
    const range = document.createRange();
    const lines: DOMRect[] = [];
    const walker = document.createTreeWalker(newest, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? "").trim()) continue;
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 && rect.height > 0) lines.push(rect);
      }
    }
    return {
      lines: lines.length,
      hiddenLines: lines.filter((line) => line.bottom - fold > box / 2).length,
      // The whole row, chrome and all, past the same edge — which is what the cue used to be measured on.
      pastFold: Math.round(newest.offsetTop + newest.offsetHeight - element.scrollTop - element.clientHeight),
    };
  });
  return { ...measured, cue: (await page.locator(".sweetie-more").count()) > 0 };
}

/** The four checks together, which is what every screen in e2e/mobile.spec.ts wants. */
export async function expectMobileReady(page: Page, screen: string, stepper?: string): Promise<void> {
  await expectNoHorizontalScroll(page, screen);
  await expectNothingScrollsSideways(page, screen);
  if (stepper) await expectStepperFits(page, stepper, screen);
  await expectTapTargets(page, screen);
}
