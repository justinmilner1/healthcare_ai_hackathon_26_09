import { expect, test } from "@playwright/test";
import { shot } from "./shot";

// T119 (design §12.3, §12.4): the `wholeRows` gate in e2e/shot.ts, judged against the frame the shot is
// actually about to take.
//
// §12.3's screenshots are what both routines see their work through, and §12.4 makes the check that writes
// them the gate, so a gate that refuses a frame which is whole costs a run and teaches the next caller a
// constraint that is not real. That is what `wholeRows` did: it narrowed from the *window* in both cases,
// and on the desktop project `fullPage` defaults to the whole scrollable document, where a row across the
// window's bottom edge is wholly in the image. T108's builder hit it on the way in — the anchor its shot
// scrolled to reported `"Safety flag during intake: cardiac or breath" 41 of 41px in frame`, sub-pixel
// rounding against an edge that capture does not have — and worked around it by naming only the block below
// the anchor.
//
// The subject here is the helper and not a product screen, so the page is written in this file rather than
// served: three known geometries at whatever height the project's window is, which is the only way to put a
// row exactly across the bottom edge of both a 1280 × 720 desktop window and a 375 × 667 phone one. The
// product's own use of the option is asserted where it is taken (e2e/flags.spec.ts, e2e/visits.spec.ts).

/** What the gate says when it refuses a frame, from `expectWholeRows` in e2e/shot.ts. */
const CUT = /a row is half in the frame/;

/**
 * A document taller than the window, holding the two geometries the gate has to tell apart.
 *
 * `#straddle` crosses the window's bottom edge: 60px of it above the fold and 20px below, at either
 * project's height, because the spacer above it is sized in `vh`. Nothing clips it — `body` and `html` are
 * `overflow: visible` — so the only question about it is which frame it is judged against.
 *
 * `#clipped` is half behind the bottom edge of an `overflow-y: auto` scroller, 60 of its 80 pixels showing,
 * and the scroller sits inside the first screenful at both widths so that the window never has an opinion
 * about it. A scroller hides what is past its edge before the shutter opens, so this one is cut in every
 * capture there is.
 *
 * It carries a viewport meta because every page in the product does, and without one the phone project is
 * not a phone: Chromium falls back to a 980px layout viewport, `100vh` grows to 1,743px to match, and the
 * full-page shot below came out 2,575 × 6,203 — refused by the §12.3 size gate in e2e/screenshotSize.ts,
 * which is that gate working correctly on a fixture that had quietly stopped being the thing it claimed.
 * The geometry `beforeEach` asserts holds either way, which is why only the file size gave it away.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>wholeRows fixture</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;font:16px/1.25 system-ui,sans-serif">
  <div id="scroller" style="overflow-y:auto;height:100px;background:#eef">
    <div style="height:40px">above</div>
    <div id="clipped" style="height:80px;background:#dde">half behind the scroller's edge</div>
    <div style="height:200px">below</div>
  </div>
  <div style="height:calc(100vh - 160px)">the fold is 60px into the row below</div>
  <div id="straddle" style="height:80px;background:#fed">across the window's bottom edge</div>
  <div style="height:240px">so the document is taller than the window</div>
</body></html>`;

test.beforeEach(async ({ page }) => {
  await page.setContent(PAGE);
  // The geometry the three cases rest on, asserted rather than assumed: a spacer in `vh` is the only way to
  // land a row on the fold at two window heights, and a layout that drifted would make every case below
  // pass for the wrong reason.
  const placed = await page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const straddle = box("straddle");
    const scroller = box("scroller");
    const clipped = box("clipped");
    const fold = document.documentElement.clientHeight;
    return {
      above: Math.round(fold - straddle.top),
      below: Math.round(straddle.bottom - fold),
      shownInScroller: Math.round(Math.min(clipped.bottom, scroller.bottom) - clipped.top),
      clippedHeight: Math.round(clipped.height),
      taller: document.documentElement.scrollHeight > fold,
    };
  });
  expect(placed, "the fixture's geometry, which every case below reads as the frame's edges").toEqual({
    above: 60,
    below: 20,
    shownInScroller: 60,
    clippedHeight: 80,
    taller: true,
  });
});

test("a row across the window's bottom edge is whole in a full-page capture, so the shot passes", async ({ page }) => {
  // The frame is the whole scrollable document: all 80 pixels of the row are in the PNG. This is the case
  // the gate used to refuse, and it is the desktop project's default, which is where most of the suite's
  // shots are taken.
  await shot(page, "shot-wholerows-fullpage-straddle", { fullPage: true, wholeRows: "#straddle" });
});

test("the same row is cut in a one-screenful capture, so the shot fails", async ({ page }) => {
  // The window is an edge of this frame, and 20 of the row's 80 pixels are past it: a PNG that is evidence
  // about neither half of the row, which is what T107 built the option to refuse.
  await expect(
    shot(page, "shot-wholerows-screenful-straddle", { fullPage: false, wholeRows: "#straddle" }),
    "a row across the window's bottom edge, in a shot bounded by the window",
  ).rejects.toThrow(CUT);
});

test("a row behind a scroller's edge is cut in both captures, so both shots fail", async ({ page }) => {
  // The half of the check that `fullPage` does not touch. The scroller has already hidden 20 of the row's 80
  // pixels by the time the shutter opens, so no capture of any size holds it whole.
  for (const fullPage of [true, false]) {
    await expect(
      shot(page, `shot-wholerows-${fullPage ? "fullpage" : "screenful"}-clipped`, { fullPage, wholeRows: "#clipped" }),
      `a row behind an overflow scroller's edge, with fullPage: ${fullPage}`,
    ).rejects.toThrow(CUT);
  }
});

// T126: the slack at the frame's edges, which is about `scrollTo` and not about layout.
//
// `scrollIntoView({ block: "start" })` is asked to land the anchor flush against an edge, so the anchor sits
// *on* the boundary by construction and only rounding decides which side of it the box lands on. At half a
// pixel of slack that was a coin toss: `e2e/flags.spec.ts`' anchor measured `box.top` anywhere from -0.59 to
// +0.41 over 27 mobile runs at a device scale of 2.625, and the gate failed about one run in twelve on a row
// it described in the same breath as "76 of 76px in frame". The reviewer run of 2026-10-22 found `main` red
// on exactly that.
//
// The fixture is its own page so that the shots above keep their committed frames. It pins the slack from
// both sides: a sub-pixel overhang is rounding and passes, and a six-pixel one is a cut and fails, so the
// tolerance cannot be widened into something that hides a real one.
const EDGES = `<!doctype html>
<html><head><meta charset="utf-8"><title>wholeRows edge fixture</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;font:16px/1.25 system-ui,sans-serif">
  <div id="hairline" style="margin-top:-0.6px;width:170px;height:60px;background:#dfd">a fraction above the edge</div>
  <div id="overhang" style="position:absolute;top:-6px;left:190px;width:170px;height:60px;background:#fdd">six pixels above it</div>
  <div style="height:200vh">so the document is taller than the window</div>
</body></html>`;

test.describe("the slack at the frame's edges", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(EDGES);
    const placed = await page.evaluate(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      return { hairline: box("hairline").top, overhang: box("overhang").top };
    });
    // The sub-pixel row is past the half-pixel slack this replaced — otherwise the first case below would
    // pass against the old threshold too and prove nothing — and comfortably inside the new one.
    expect(placed.hairline, "a hairline above the edge, past the old half-pixel slack").toBeLessThan(-0.5);
    expect(placed.hairline, "and still well inside the two-pixel one").toBeGreaterThan(-1);
    expect(placed.overhang, "a cut the slack must not swallow").toBeCloseTo(-6, 1);
  });

  test("a row a fraction of a pixel above the window's top edge is rounding, not a cut, so the shot passes", async ({ page }) => {
    await shot(page, "shot-wholerows-hairline", { fullPage: false, wholeRows: "#hairline" });
  });

  test("a row six pixels above it is a cut, so the slack cannot be widened into one", async ({ page }) => {
    await expect(
      shot(page, "shot-wholerows-overhang", { fullPage: false, wholeRows: "#overhang" }),
      "six pixels of a row past the window's top edge",
    ).rejects.toThrow(CUT);
  });
});
