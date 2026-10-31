import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { contrastRatio } from "./contrast";
import {
  declaredColorTokens,
  describeUnreadable,
  isTextual,
  SWEETIE_BRAND_TOKENS,
  SWEETIE_TEXT_SURFACES,
  SWEETIE_TEXT_TOKENS,
  sweetieTextTokensUsed,
  unreadableText,
  wcagTextBar,
  worstSurface,
  type TextSample,
} from "./textContrast";

const STYLESHEET = path.join("app", "globals.css");
const css = () => readFileSync(STYLESHEET, "utf8");

const sample = (over: Partial<TextSample> = {}): TextSample => ({
  where: "span.patient-pattern-list-chip",
  content: "1",
  color: "#d01b42",
  fontSizePx: 8,
  fontWeight: 750,
  ...over,
});

test("WCAG's large-text threshold, on both sides of both halves", () => {
  // Small, which is what every site T210 is about turned out to be.
  assert.equal(wcagTextBar({ fontSizePx: 8, fontWeight: 750 }), 4.5);
  assert.equal(wcagTextBar({ fontSizePx: 23.9, fontWeight: 400 }), 4.5);
  assert.equal(wcagTextBar({ fontSizePx: 18.66, fontWeight: 699 }), 4.5);
  // Large: 18pt at any weight, or 14pt bold.
  assert.equal(wcagTextBar({ fontSizePx: 24, fontWeight: 400 }), 3);
  assert.equal(wcagTextBar({ fontSizePx: 18.66, fontWeight: 700 }), 3);
  // §2.7's hero display type, which is genuinely large and should not be held to 4.5:1.
  assert.equal(wcagTextBar({ fontSizePx: 57, fontWeight: 400 }), 3);
});

test("a glyph used as a picture is not text; a numeral is", () => {
  // The two sites T210 writes down as not defects.
  assert.equal(isTextual("↗"), false, ".patient-report-empty > span");
  assert.equal(isTextual("→"), false, ".home-handoff b");
  assert.equal(isTextual("  ·  "), false);
  assert.equal(isTextual(""), false);
  // And the chip, which is the defect: a numeral is read.
  assert.equal(isTextual("1"), true);
  assert.equal(isTextual("TIME IN RANGE"), true);
  // Coarse in the safe direction: a glyph with a letter beside it is judged as text.
  assert.equal(isTextual("↗ more"), true);
});

test("the worst surface is the one the verdict is about", () => {
  const worst = worstSurface("#e74568", SWEETIE_TEXT_SURFACES);
  assert.equal(worst.surface.color, "#fff0f4");
  assert.ok(Math.abs(worst.ratio - 3.49) < 0.01, `${worst.ratio} is not the measured 3.49`);
  // White is the kindest of the four, and picking it would have let both T210 sites through at 3.85.
  assert.ok(contrastRatio("#e74568", "#ffffff") > worst.ratio);
  assert.throws(() => worstSurface("#e74568", []), /at least one surface/);
});

test("the two sites this rule was written for fail it, and the colour that replaced them passes", () => {
  // The chip and "TIME IN RANGE", as they were. Both have to fail, or the gate below proves nothing.
  const before = unreadableText(
    [
      sample({ color: "#e74568" }),
      sample({ where: ".patient-range-number small", content: "TIME IN RANGE", color: "#e74568", fontWeight: 780 }),
    ],
    SWEETIE_TEXT_SURFACES,
  );
  assert.equal(before.length, 2);
  for (const finding of before) {
    assert.equal(finding.bar, 4.5);
    assert.equal(finding.surface.color, "#fff0f4");
    assert.ok(finding.ratio < 4.5);
  }
  // The message a routine reads has to name the element, both colours and both numbers.
  const described = describeUnreadable(before);
  assert.match(described, /\.patient-range-number small/);
  assert.match(described, /#e74568 on #fff0f4/);
  assert.match(described, /under 4\.5:1/);

  assert.deepEqual(unreadableText([sample()], SWEETIE_TEXT_SURFACES), []);
});

test("an icon glyph is dropped before it is measured, however dark the paper", () => {
  // #e74568 on #fff0f4 is 3.49:1, so this would fail if the exemption were not applied.
  assert.deepEqual(
    unreadableText([sample({ where: ".home-handoff b", content: "→", color: "#e74568", fontSizePx: 9 })], SWEETIE_TEXT_SURFACES),
    [],
  );
});

test("large text is held to 3:1 rather than excused or over-judged", () => {
  const display = sample({ content: "Your week with Sweetie", color: "#e74568", fontSizePx: 57, fontWeight: 400 });
  // 3.49:1 on the worst surface: under 4.5 but over 3, so large text at this colour is not a finding.
  assert.deepEqual(unreadableText([display], SWEETIE_TEXT_SURFACES), []);
  // And a colour that misses even 3:1 still is.
  const faint = unreadableText([{ ...display, color: "#ffb3c6" }], SWEETIE_TEXT_SURFACES);
  assert.equal(faint.length, 1);
  assert.equal(faint[0].bar, 3);
});

test("the tokens come out of the stylesheet, not out of a copy of them", () => {
  const tokens = declaredColorTokens(`
    :root {
      --background: #FBFAF9;
      --sweetie-dark: #d01b42;
      --derived: var(--sweetie-dark);
      --mixed: color-mix(in srgb, var(--sweetie) 16%, transparent);
    }
    .elsewhere { --sweetie-dark: #000000; }
  `);
  assert.equal(tokens.get("--background"), "#fbfaf9");
  assert.equal(tokens.get("--sweetie-dark"), "#d01b42");
  // A reference or a computation is not a colour this module can measure, so it is left out rather than
  // resolved wrongly.
  assert.equal(tokens.has("--derived"), false);
  assert.equal(tokens.has("--mixed"), false);
  assert.equal(tokens.size, 2, "only the first :root block, and only its hex values");

  for (const bad of ["", ".a { color: red }", ":root { --a: var(--b); }"]) {
    assert.throws(() => declaredColorTokens(bad), /:root block|colour tokens/, bad);
  }
});

test("the `color:` declarations name the token meant for text and no other brand pink", () => {
  // T210's completeness criterion as an assertion. `color: var(--sweetie)` would be a new site of the same
  // bug in the lighter of the two pinks (2.79:1 on --sweetie-soft), and this is what refuses it.
  assert.deepEqual(sweetieTextTokensUsed(css()), [...SWEETIE_TEXT_TOKENS]);
  // The rule itself, against the three spellings this stylesheet writes: the token outright, the themed
  // slot, and the slot with the token as its fallback (`.ss-eyebrow`).
  assert.deepEqual(sweetieTextTokensUsed(".a { color: var(--sweetie-dark); }"), ["--sweetie-dark"]);
  assert.deepEqual(sweetieTextTokensUsed(".a { color: var(--theme-dark); }"), ["--sweetie-dark"]);
  assert.deepEqual(
    sweetieTextTokensUsed(".a {\n  color: var(--theme-dark, var(--sweetie-dark));\n}"),
    ["--sweetie-dark"],
  );
  assert.deepEqual(sweetieTextTokensUsed(".a { color: var(--sweetie); }"), ["--sweetie"]);
  // A fill is not text: neither a border nor a background is this rule's business, and `border-color` is
  // not a `color:` declaration however much it looks like one inside a regular expression.
  assert.deepEqual(sweetieTextTokensUsed(".a { border-color: var(--sweetie); background: var(--sweetie-soft); }"), []);
});

// The gate (T210, design §6.4). axe cannot state either of this ticket's two findings — one site is
// `aria-hidden`, the other is on a gradient — so this is where a Sweetie pink that drifts back under the
// bar is caught, next to `expectReadableBrandText` in `e2e/a11y.ts`, which catches a *new* site using one.
test("every pink the stylesheet paints text with is readable as small text on every surface it is drawn on", () => {
  const tokens = declaredColorTokens(css());
  const failures: string[] = [];
  for (const token of SWEETIE_TEXT_TOKENS) {
    const color = tokens.get(token);
    assert.ok(color, `${token} is not declared in ${STYLESHEET} any more — fix this list, not the test`);
    for (const surface of SWEETIE_TEXT_SURFACES) {
      const ratio = contrastRatio(color, surface.color);
      if (ratio < 4.5) {
        failures.push(`${token} (${color}) on ${surface.color} is ${ratio.toFixed(2)}:1 — ${surface.where}`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `a pink this stylesheet writes text in is under the 4.5:1 WCAG 2.1 AA asks of small text (design §6.4):\n${failures.join("\n")}`,
  );
  // The value that was there is still the value that fails, so the gate above is known to be able to fire.
  assert.ok(contrastRatio("#e74568", "#fff0f4") < 4.5);
  // And both brand pinks are declared, since the live gate recognises text by those two colours.
  for (const token of SWEETIE_BRAND_TOKENS) assert.ok(tokens.get(token), `${token} is declared`);
});

test("the stylesheet does not paint anything in the colour T210 took out", () => {
  // The whole of the fix was moving one token, so no *declaration* of the old value is the assertion that
  // says the move happened rather than a second token having been added beside it. Declarations rather
  // than occurrences: the comment on the token records the number it used to be, and should.
  const declarations = [...css().matchAll(/^\s*(?:--[a-z0-9-]+|color|background(?:-color)?)\s*:\s*([^;]*#e74568[^;]*);/gim)];
  assert.deepEqual(
    declarations.map((hit) => hit[0].trim()),
    [],
    "#e74568 is 3.49:1 on --sweetie-soft (T210) — nothing should declare it",
  );
});
