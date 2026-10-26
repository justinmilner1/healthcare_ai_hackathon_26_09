import assert from "node:assert/strict";
import test from "node:test";
import { composite, contrastRatio, parseColor, relativeLuminance } from "./contrast";

const close = (actual: number, expected: number, within = 0.05) =>
  assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

test("the three colour spellings the suite meets", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#271f25"), { r: 39, g: 31, b: 37, a: 1 });
  assert.deepEqual(parseColor("rgb(39, 31, 37)"), { r: 39, g: 31, b: 37, a: 1 });
  // What getComputedStyle hands back for a translucent outline, in both the comma and the slash spelling.
  assert.deepEqual(parseColor("rgba(247, 93, 124, 0.28)"), { r: 247, g: 93, b: 124, a: 0.28 });
  assert.deepEqual(parseColor("rgb(247 93 124 / 0.28)"), { r: 247, g: 93, b: 124, a: 0.28 });
  assert.deepEqual(parseColor("#ffffff80"), { r: 255, g: 255, b: 255, a: 128 / 255 });
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
});

test("a colour that cannot be read is an error, not black", () => {
  // Resolving an unknown syntax to black would make every ring below pass for the wrong reason.
  for (const bad of ["", "currentColor", "oklch(0.7 0.1 20)", "#12345", "rgb(a, b, c)"]) {
    assert.throws(() => parseColor(bad), /not a colour/, bad);
  }
});

test("relative luminance follows the sRGB transfer function, not a channel average", () => {
  close(relativeLuminance(parseColor("#ffffff")), 1);
  close(relativeLuminance(parseColor("#000000")), 0);
  // Mid grey: the average says 0.5, the standard says 0.216. This is the number the ratio rests on.
  close(relativeLuminance(parseColor("#808080")), 0.2158, 0.001);
});

test("compositing paints the colour onto the surface under it", () => {
  assert.deepEqual(composite(parseColor("rgba(0, 0, 0, 0.5)"), parseColor("#ffffff")), {
    r: 127.5,
    g: 127.5,
    b: 127.5,
    a: 1,
  });
  // Opaque: the backdrop makes no difference at all.
  assert.deepEqual(composite(parseColor("#271f25"), parseColor("#ffffff")), { r: 39, g: 31, b: 37, a: 1 });
});

test("the known ratios, in both directions", () => {
  close(contrastRatio("#000000", "#ffffff"), 21);
  close(contrastRatio("#ffffff", "#ffffff"), 1);
  // The ring T166 added, against both surfaces it is drawn on: the wizard's white dialog and the two stops
  // of the Sweetie sidebar's gradient. One colour, over 3:1 on all of them.
  close(contrastRatio("#271f25", "#ffffff"), 16.04, 0.05);
  close(contrastRatio("#271f25", "#f76181"), 5.33, 0.05);
  close(contrastRatio("#271f25", "#e84970"), 4.29, 0.05);
  // And the colour that was not chosen, which the lighter stop leaves no room over.
  close(contrastRatio("#ffffff", "#f76181"), 3.01, 0.05);
});

test("a translucent ring is measured as what it paints (T166)", () => {
  // The whole reason this is a module: `rgba(247, 93, 124, 0.28)` reads as a pass if the alpha is dropped.
  close(contrastRatio("rgb(247, 93, 124)", "#ffffff"), 3.08, 0.05);
  assert.ok(
    contrastRatio("rgba(247, 93, 124, 0.28)", "#ffffff") < 1.5,
    "28% of an accent over white is a ring nobody can see",
  );
});

test("the backdrop has to be opaque, because nothing is known about what is behind it", () => {
  assert.throws(() => contrastRatio("#ffffff", "rgba(0, 0, 0, 0.2)"), /opaque/);
});
