import { expect, test, type Locator, type Page } from "@playwright/test";
import { MAX_HEIGHT } from "./screenshotSize";

// The one place a screenshot gets taken (T57, design §12.3).
//
// §12.3 exists so that both routines can *see* what they built, and `fullPage: true` on the mobile project
// was quietly undoing it: the provider dashboard is as tall as the practice's visit list, so by the time the
// phone ran it the shot was 20,000 pixels of three-pixel rows — 55 phone screens stacked into one image, in
// which nothing is legible at any size a reviewer can open. e2e/audit.spec.ts and e2e/deletion.spec.ts had
// each hit this and fixed it locally; eleven other specs still hardcoded `fullPage: true`, and every one of
// them grew taller with each ticket that booked another visit.
//
// So the default is per project and decided here: the desktop shoots the document, where a row is one line
// of a table and the whole page is worth having, and the phone shoots its viewport, where it is not. A spec
// that wants something else says so — `{ fullPage: true }` for a phone shot of a whole page (the patient
// screens in e2e/mobile.spec.ts are exactly that), `MODAL` for a dialog, which is one viewport's worth of
// subject at either width, and `SCREENFUL` for a page whose height is the practice's own data, which the
// desktop default turned out to be wrong about too (T81).
//
// Scrolling only chooses which part of a subject taller than the frame goes missing, which is the other
// shape of the same bug (T107): the §2.2 import dialog is 685px of content in the 525px its own
// `max-height: 88svh` leaves at 720, so every anchoring of it hid either the title or the two refused rows
// the test was about. `viewportHeight` gives the window the height the dialog is written against for the
// length of the shot, and `wholeRows` fails a frame that cuts a row through the middle rather than letting
// it be committed as evidence.
//
// Transitions are frozen for every shot, which is the other half of the same promise (T77). `page.screenshot`
// leaves CSS running unless it is passed `animations: "disabled"`, and the cards come in over 480ms: without
// it the committed screenshot is a half-faded card, which says nothing about the contrast or the weight of
// the type it was taken to show. Three specs had each found that and passed the option locally; the other
// twenty did not, so most of the PNGs both routines read could be a frame part-way through a transition —
// a state the product is never actually in. The Sweetie progress bar is the clearest of them
// (`transition: width 500ms` in app/globals.css): `desktop-journey-09-sweetie-complete.png` said 100% over a
// bar filled 53% of the way, and a reviewer had to spend time deciding whether that was a bug in the
// product. It was a bug in the picture. So the shutter waits for the animation here, once, for every shot.
//
// The pointer is moved off the page for every shot, which is the same promise a third time (T167). Playwright
// leaves the mouse parked wherever the last click or wheel put it, and this helper then scrolls the page under
// it — so whatever slides beneath that fixed viewport coordinate picks up `:hover` and is photographed wearing
// it. `mobile-provider-add-visit-step3-scroll-bottom.png` was "Do not message" carrying the gold `:hover`
// border while "Text and email" was the selected channel: two gold-bordered cards in one radio group, in the
// §2.2 frame a reviewer reads to see which channel the front desk chose. Only the phone's scroll landed a card
// under the pointer, so the desktop frame of the same step did not have it and nothing in the suite could say
// which frames did — any shot could acquire it or lose it by moving a few pixels. A patient or a clinician
// reading one of these screens has no pointer resting on a card they did not choose, so neither does the
// shutter; a shot whose subject *is* something under the pointer says `pointer: "kept"`.
//
// T157 had already met the other face of it and fixed it in one spec: Chromium dispatches a `mousemove` when
// a scroll changes what is under the cursor, Recharts opens a tooltip on one, and
// `mobile-journey-12-sour-spikes-unplaced.png` came back with a tooltip hanging over the card beside its
// subject. e2e/journey.spec.ts parked the pointer itself before those two shots; it no longer has to, and
// neither does the next spec to find this.

/** The default for this project: the document on the desktop, one screenful on the phone. */
export const fullPageByDefault = (): boolean => test.info().project.name === "desktop";

export type ShotOptions = {
  /**
   * Override the per-project default: `true` shoots the whole document even on a phone, `false` shoots one
   * viewport even on the desktop.
   */
  fullPage?: boolean;
  /**
   * Scroll this to the top of the viewport before shooting, for a subject that is below the fold on a phone.
   * A selector string or a locator; the first match is used.
   */
  scrollTo?: string | Locator;
  /**
   * Where `scrollTo` puts the subject vertically. `"start"` (the default) is the top of the viewport, which
   * is what a card taller than the screen wants — `scrollIntoViewIfNeeded` stops as soon as the card is
   * barely on screen and leaves the shot mid-rows with no header on it. `"center"` is for a single row
   * inside a long table, which otherwise lands half cut off at the bottom edge.
   */
  block?: "start" | "center" | "end" | "nearest";
  /**
   * And horizontally. The dashboard's table is `min-width: 1120px` inside an `overflow-x: auto` card
   * (app/globals.css), so at 375px a third of it is on screen and the Stage, Messages and Actions columns
   * are off to the right — which is where most of what these tests assert on lives. Passing the cell rather
   * than the row as `scrollTo`, with `inline: "center"`, brings that column into the shot.
   */
  inline?: "start" | "center" | "end" | "nearest";
  /**
   * Give the window this much height for the shot, and hand it back the moment it is taken.
   *
   * For a dialog whose own height is written against the window and which this project's window is too
   * short to hold. The §2.2 import preview is the one of those: `.import-dialog` is `max-height: 88svh`, so
   * at the desktop project's 720px it gets 525px of scrolling body for 685px of content, and whatever the
   * shot is anchored on, 160px of the subject is behind an edge. Scrolling only chooses which 160px — the
   * header and the paste box, or the rows and the two refusals the test is about (T107).
   *
   * So the window is given the height the dialog is asking for — 1000px is a maximised window on a 1280 x
   * 1024 desk monitor, which is what a scheduler importing a day is sitting at — the shot is taken, and the
   * window goes back to the project's own size before the test carries on. Nothing in the image is a state
   * the product is never in: it is this dialog on a taller screen.
   *
   * It is not a way around `SCREENFUL` or the §12.3 size gate. A page whose height is the practice's own
   * data has no window that holds it, and growing the window for one would produce exactly the picture T81
   * took out of the suite.
   *
   * **This is where the growing starts, not where it stops** (T188). A height on its own is a number that
   * fits the content it was measured against, and the import dialog's content is not fixed: its rows are
   * named by `uniqueName`, so a cell's wrap — and the row's height with it — is a property of the run. 1000
   * answered that content to within 14 pixels, which is two thirds of a line of type, so whether the last
   * row was whole in the frame was decided by whether one more generated name happened to wrap. Pair it
   * with `viewportFits` to have those pixels measured rather than guessed.
   */
  viewportHeight?: number;
  /**
   * Grow the window until this subject has nothing of its own behind one of its own scrolling edges.
   *
   * The derived half of `viewportHeight` above, and the fix for the one thing a named height cannot promise
   * (T188): that the frame holds the whole subject whatever this run's content does to its height. The §2.2
   * import preview is the one of those — `.import-scroll` measured 785px of content in the 771px a 1000px
   * window leaves it, so the table's last row hung 13px past that scroller's bottom edge and `wholeRows`
   * refused the frame, on about one run in ten and never twice for the same reason, because a row's height
   * there is the height of its wrapped cells and the cells are named by `uniqueName`.
   *
   * It measures instead: how much the worst of the subject's own scrollers is hiding, grow the window by
   * exactly that, measure again. The dialog is `max-height: 88svh`, so 14px of overflow is relieved by about
   * 16px of window and the second round closes the rest; nothing here knows that ratio, which is why it is a
   * loop and not an arithmetic.
   *
   * **The subject and not `wholeRows`' rows**, although the rows are what the gate below judges. A scroller
   * with nothing behind its edges is at the top of its content as well as the bottom of it, and the rows are
   * not all a frame of this dialog is for: asking only that the rows fit was answered once by the body
   * scrolling to its end, which put every row in the picture and took the dialog's title out of it. What
   * `wholeRows` adds on top is the other half T107 asked for — a row *wholly* past an edge is not half a
   * row, so the gate alone is content with a frame that has lost three of them.
   *
   * A form control is not one of the subject's scrollers: a `<textarea>`'s scrollbar is the value somebody
   * typed into a box sized in pixels, so no window height has ever moved it. The import dialog's paste box
   * is exactly that, and counting it sent the first draft of this growing the window to 1,496px chasing 62
   * pixels of CSV.
   *
   * Growing the window is all it does — the page is never restyled for a shot, so the frame stays a picture
   * of the product on a taller screen. That also sets its limit, and the limit is asserted rather than
   * silently accepted: an overflow the window cannot relieve (a `max-height` in pixels rather than viewport
   * units, inside a subject that needs more than it allows) fails here, naming the scroller, instead of
   * reaching `wholeRows` as a cut row with no explanation on it.
   */
  viewportFits?: string;
  /**
   * Every element matching this is either wholly in the frame or wholly out of it, or the shot fails here.
   *
   * The counterpart to the option above, because a frame that cuts a table row through its text is the bug
   * T107 was filed for and nothing in a PNG says it happened: `desktop-provider-import-preview.png` showed
   * three rows under a tally claiming two problems, with the fourth row clipped mid-name at the bottom edge
   * of `.import-scroll` and the two refused rows below it. A reviewer reading that file could not tell a
   * working validator from one that drops bad rows.
   *
   * **Which frame that is, is `fullPage`'s answer and not the window's** (T119). A `fullPage: false` shot is
   * one screenful, so the window is an edge of the frame and a row across its bottom edge really is cut in
   * half in the image. A `fullPage: true` shot is the whole scrollable document: that same row is wholly in
   * the picture, and the frame has no window edge for anything to be cut by. Judging both against the window
   * made the gate refuse frames that were whole, on the project that takes most of the suite's shots — T108's
   * builder lost a run to it, on an anchor `scrollIntoView({ block: "start" })` had landed a fraction above
   * the top edge of a desktop capture that did not have one.
   *
   * Either way it is judged against every ancestor that clips, the way `expectTextIntact` in e2e/mobile.ts
   * judges a line of type (T101): a row hidden behind a scroller's edge is a row nobody is being shown, in a
   * full-page capture as much as in a screenful, because the scroller hides it before the shutter opens. A
   * row wholly outside the frame is fine — this asks that what is in the picture is whole, not that
   * everything is in the picture.
   */
  wholeRows?: string;
  /**
   * Whether the pointer is moved off the page before the shutter opens. The default is `"parked"`, and
   * `"kept"` is for a shot whose subject is something only a pointer brings on screen — a chart tooltip is
   * the one of those in this suite (e2e/charts.ts), and it hovers the chart deliberately a line earlier.
   */
  pointer?: "parked" | "kept";
  /**
   * Whether CSS transitions and animations keep running while the shutter is open. The default is
   * `"disabled"` and there is no good reason for a spec to pass `"allow"`; it exists so that a spec whose
   * subject *is* a transition can say so in one word rather than reaching past this helper.
   */
  animations?: "disabled" | "allow";
};

/** A dialog: one viewport's worth of subject, at either width. */
export const MODAL: ShotOptions = { fullPage: false };

/**
 * The page itself is the subject, at either width.
 *
 * For a page that fits in about two phone screens and whose layout is the point: the code screen, consent,
 * the Sweetie transcript, the connect steps. Nothing on them grows with the practice's data, so the shot has
 * a fixed height, and the whole-page layout at 375px is what design §6.5 asks to be able to look at. A page
 * taller than that takes the default instead and gets a screenful on the phone — a 7,000-pixel column of a
 * clinician's brief is the same unreadable picture the dashboard was, only shorter.
 */
export const WHOLE_PAGE: ShotOptions = { fullPage: true };

/**
 * One screenful with the subject scrolled into it, at either width.
 *
 * For a page whose height is the practice's own data rather than its own design. The provider dashboard is
 * the only one of those in the product, and T57 left the desktop shooting the whole document of it on the
 * grounds that a desktop row is one line of a table rather than five stacked ones — true of the row, and
 * wrong about the page, because the list grows a row with every visit the suite books. By the time
 * `e2e/visits.spec.ts` took its shot the document was 7,015 pixels, and the §12.3 size gate was excusing
 * four desktop dashboard shots by name (T81, e2e/screenshot-exceptions.json).
 *
 * Every one of those shots was taken to show one row — a stage pill, an invite, a delivery tooltip, an
 * absence — and says so in `scrollTo`. Nothing else in a list of other specs' patients is evidence about
 * the ticket that shot it, so the shot is one screenful of the subject on both projects, and stays the same
 * size however many visits the suite goes on to book.
 */
export const SCREENFUL: ShotOptions = { fullPage: false };

/**
 * Where the pointer goes before the shutter opens: one pixel outside the document, where nothing is under it.
 *
 * Outside rather than the `0, 0` corner e2e/charts.ts moves to before a hover it does mean to make. A corner
 * is still inside the viewport, so whatever the page puts in its top-left pixel is hovered there; measured in
 * this Chromium against a fixture with a fixed corner box, `document.querySelectorAll(":hover")` at `0, 0`
 * comes back holding that box and at `-1, -1` comes back empty. Empty is the state a committed frame is
 * supposed to be evidence about, and it survives everything this helper does afterwards — the
 * `scrollIntoView` above, and the scrolling Playwright does of its own accord to take a `fullPage` capture —
 * because no scroll brings the document to a point that is not in it.
 */
const OFF_THE_PAGE = { x: -1, y: -1 };

/**
 * Write `e2e/screenshots/<project>-<name>.png`, the filename §12.3 and every
 * `docs/screenshots/tickets/*` reference depend on.
 */
export async function shot(page: Page, name: string, options: ShotOptions = {}): Promise<void> {
  const {
    fullPage = fullPageByDefault(),
    scrollTo,
    block = "start",
    inline = "nearest",
    animations = "disabled",
    pointer = "parked",
    viewportHeight,
    viewportFits,
    wholeRows,
  } = options;
  const projectWindow = page.viewportSize();
  const start = Math.max(projectWindow?.height ?? 0, viewportHeight ?? 0);
  const grown = Boolean(projectWindow && (start > projectWindow.height || viewportFits));
  try {
    if (grown && start > projectWindow!.height) await resizeWindow(page, projectWindow!.width, start);
    if (grown && viewportFits) await growToFit(page, viewportFits, name, projectWindow!.width, start);
    if (scrollTo) {
      const target = typeof scrollTo === "string" ? page.locator(scrollTo) : scrollTo;
      await target.first().evaluate((element, position) => {
        element.scrollIntoView(position);
      }, { block, inline });
    }
    // After the scroll, because the scroll is what decides what sits under the pointer — and before the gate
    // below, so what it measures is the frame that is about to be taken.
    if (pointer === "parked") await page.mouse.move(OFF_THE_PAGE.x, OFF_THE_PAGE.y);
    if (wholeRows) await expectWholeRows(page, wholeRows, name, fullPage);
    await page.screenshot({
      path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
      fullPage,
      animations,
    });
  } finally {
    // Whatever happened above, the next assertion runs at the window the project asked for.
    if (grown) await page.setViewportSize(projectWindow!);
  }
}

/**
 * Give the window this height, and wait for the renderer to be laying out against it.
 *
 * The resize is applied in the renderer before `setViewportSize` resolves; the wait is for the layout it
 * causes, so neither the shutter nor the measurement below can read the old one. A condition, not a pause:
 * e2e/budget.ts owns the clocks.
 */
async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction((want) => window.innerHeight === want, height);
}

/**
 * How many times `growToFit` may measure and grow.
 *
 * Each round grows the window by what the subject is hiding, and the subject takes only its own share of
 * that — 88svh for the import dialog — so what is left shrinks by a constant factor every round, and the
 * subject capped at the smallest share of the window is the one that takes the most rounds. The import
 * dialog settles in two; a subject at `50svh`, where half of each round's growth is lost, is inside eight
 * rounds from an overflow of 250px. A round is one resize and one measurement, so the cost of the headroom
 * is milliseconds, and the bound is there for a subject that never settles — which then fails with the
 * scroller's name on it rather than by running a test out of its budget.
 */
const FIT_ROUNDS = 8;

/** When a subject counts as fitting: the same two pixels `expectWholeRows` reads as rounding rather than as
 *  a row behind an edge, so this cannot stop one short of what the gate below asks for, or chase the
 *  fraction of a pixel a sub-pixel layout leaves between a scroller and its content. */
const FITS_WITHIN = 2;

/**
 * The most any of `selector`'s own scrollers is hiding, and which one it is.
 *
 * Scoped to the subject and down, so the page behind a dialog is not one of them — `expectWholeRows` below
 * walks *up* from a row instead, because the question there is which edge is nearest, and the question here
 * is what the window still owes this subject. The worst scroller rather than the sum of them: one window
 * relieves them all at once.
 *
 * Form controls are not scrollers of the subject. A `<textarea>` is as tall as its CSS says and as full as
 * what somebody typed into it, and no window height has ever changed either — see `viewportFits` above for
 * the run this cost.
 *
 * Reading `scrollHeight` forces the layout a resize has just made dirty, so this cannot answer about the
 * window the shot is not about: measured on the import dialog, `.import-dialog` came back at exactly 0.88 of
 * each new window height, which is the resize-lag reading of #260 ruled out.
 */
function overflowOf(page: Page, selector: string): Promise<{ overflow: number; where: string }> {
  return page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    let worst = { overflow: 0, where: sel };
    if (!root) return worst;
    const typed = new Set(["TEXTAREA", "INPUT", "SELECT"]);
    for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (typed.has(element.tagName)) continue;
      if (getComputedStyle(element).overflowY === "visible") continue;
      const overflow = element.scrollHeight - element.clientHeight;
      if (overflow <= worst.overflow) continue;
      worst = { overflow, where: element.className || element.tagName.toLowerCase() };
    }
    return worst;
  }, selector);
}

/**
 * Grow the window until `selector` has nothing behind a scrolling edge of its own — see `viewportFits` above.
 *
 * Returns the height it settled at. The failure is the interesting half: an overflow that growing the window
 * does not shrink is a `max-height` in pixels rather than in viewport units, or a subject the §12.3 size gate
 * has no room for, and either way no frame holds the subject whole. Saying so here, with the scroller's class
 * on it, is the difference between a diagnosis and `wholeRows` reporting a cut row for the ninth time.
 */
async function growToFit(page: Page, selector: string, name: string, width: number, from: number): Promise<number> {
  // The subject has to be on the page, for the same reason `expectWholeRows` says so below: `overflowOf`
  // answers "nothing behind an edge" for a selector that matches nothing, which is indistinguishable from a
  // subject that fits. A mistyped `viewportFits` would then hand the frame back to `viewportHeight` alone --
  // the named number this exists to replace -- and the shot would go back to depending on what the run's
  // content happened to do to its height, silently, which is the whole of T188 reopening itself.
  await expect(page.locator(selector).first(), `${name}: nothing matched ${selector}`).toBeVisible();
  // `fullPage: false` is what a grown window is for, so the PNG is one window at this project's device
  // scale: growing the window grows the image. Not a way around e2e/screenshotSize.ts — a subject that
  // needs more than the gate allows fails below, by name, rather than writing a file the gate then refuses.
  const ceiling = Math.floor(MAX_HEIGHT / (await page.evaluate(() => window.devicePixelRatio)));
  let height = from;
  for (let round = 0; round < FIT_ROUNDS; round += 1) {
    const { overflow } = await overflowOf(page, selector);
    if (overflow < FITS_WITHIN) return height;
    // By what it is hiding, which is the least that can relieve it: the subject takes a share of the window
    // and nothing here knows that share, so an under-grow is corrected by the next round and an over-grow
    // could not be.
    const wanted = Math.min(ceiling, height + overflow);
    if (wanted <= height) break;
    await resizeWindow(page, width, wanted);
    height = wanted;
  }
  const { overflow, where } = await overflowOf(page, selector);
  expect(
    overflow,
    `${name}: a ${height}px window still leaves ${overflow}px of ${selector} behind the bottom edge of ` +
      `${where}, so no frame holds it whole (T188, design §12.3). Growing the window does not relieve it: ` +
      `look for a max-height in pixels rather than viewport units, or a subject taller than the §12.3 size ` +
      `gate allows.`,
  ).toBeLessThan(FITS_WITHIN);
  return height;
}

/**
 * Nothing matching `selector` is half in the frame — see `wholeRows` above for why that is worth failing on.
 *
 * `fullPage` is the capture this is judging, because it is what decides where the frame's edges are: the
 * window bounds a screenful, and a full-page capture is the whole scrollable document, where the only thing
 * that can still show half a row is an ancestor that clips (T119).
 */
async function expectWholeRows(page: Page, selector: string, name: string, fullPage: boolean): Promise<void> {
  await expect(page.locator(selector).first(), `${name}: nothing matched ${selector}`).toBeVisible();
  const cut: string[] = await page.evaluate(({ sel, windowIsAnEdge }) => {
    const found: string[] = [];
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const box = row.getBoundingClientRect();
      // A box a pixel or two tall is the visually-hidden pattern, not a row anybody is reading.
      if (box.height < 2) continue;
      // The frame, in the client coordinates the boxes below are in. A full-page capture holds the whole
      // document, so it has no top or bottom edge of its own and starts out unbounded; a screenful is
      // bounded by the window. Either way every clipping ancestor narrows it from there.
      let top = windowIsAnEdge ? 0 : -Infinity;
      let bottom = windowIsAnEdge ? document.documentElement.clientHeight : Infinity;
      for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowY === "visible") continue;
        const edge = parent.getBoundingClientRect();
        top = Math.max(top, edge.top);
        bottom = Math.min(bottom, edge.bottom);
      }
      const shown = Math.min(box.bottom, bottom) - Math.max(box.top, top);
      // The slack is a whole two pixels at each edge, and it is about `scrollTo` rather than about layout
      // (T126). `scrollIntoView({ block: "start" })` is asked to land the anchor flush against an edge, so
      // the anchor sits *on* the boundary by construction and nothing but rounding decides which side of it
      // the box lands. Measured on the mobile project, 27 runs of e2e/flags.spec.ts' own anchor at a device
      // scale of 2.625: `box.top` came out anywhere from -0.59 to +0.41, a window a whole CSS pixel wide,
      // because the scroll offset is quantized to the device-pixel grid and the content above the anchor
      // lays out a fraction differently from run to run. At half a pixel that window straddled the
      // threshold, so the gate failed about one run in twelve on a row it reported as "76 of 76px in
      // frame" — whole, by its own message. Two pixels is over three times the worst overhang seen and
      // still 2.6% of the shortest row this guards, while the cuts it exists to refuse are the fixture's
      // 20 of 80px and the half-read flag of T107. It cannot be widened again without making it mean
      // something: if this ever trips, make the scroll land the anchor inside the frame instead.
      const hidden = box.height - shown;
      if (shown < 2) continue; // wholly out of the frame, which is not half a row
      if (hidden < 2) continue; // wholly in it
      const text = (row.textContent ?? "").trim().replace(/\s+/g, " ");
      found.push(`"${text.slice(0, 44)}" ${Math.round(shown)} of ${Math.round(box.height)}px in frame`);
      if (found.length >= 8) return found;
    }
    return found;
  }, { sel: selector, windowIsAnEdge: !fullPage });
  expect(cut, `${name}: a row is half in the frame, so the shot is evidence about neither half (T107, design §12.3)`).toEqual([]);
}
