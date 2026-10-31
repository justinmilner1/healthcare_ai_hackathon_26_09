// Whether the text on a page is readable, for the sites WCAG's contrast minimum covers and axe's
// `color-contrast` rule does not reach (T210, design §6.4, §12.5).
//
// `lib/contrast.ts` is the arithmetic — parse, composite, ratio — and was written for T166's focus rings,
// where axe has no rule at all. This module is the other gap: text whose colour axe *does* have a rule for
// and still says nothing about. §2.7's small print went two tickets at 3.49:1 and 3.54:1 against a 4.5:1
// bar with the §12.5 pass green over both, by two different exits from the same rule:
//
//   - the 1 / 2 / 3 chip on the narrative cards is `aria-hidden="true"` (T208, correctly — the `<ol>`
//     carries the position and the numeral must not be said twice), and axe skips a hidden subtree. Hidden
//     from a screen reader is not hidden from an eye, so the glyph is still text somebody has to read;
//   - "TIME IN RANGE" sits on `.patient-range-card`'s `radial-gradient`, and axe files `color-contrast` as
//     **incomplete** rather than as a violation when it cannot resolve the background to one colour.
//     `e2e/a11y.ts` fails on serious violations and on `aria-prohibited-attr` incompletes only.
//
// Neither exit is a bug in axe; both are it declining to guess. So the guess is made here instead, and made
// pessimistically: a colour is judged against the *worst* of the surfaces the flow actually paints that
// colour on, declared below. That costs nothing in precision for a pink on near-white paper — #e74568 was
// 3.85:1 on white and 3.49:1 on `--sweetie-soft` — and it means a new call site is covered by the gate
// without anybody having to work out which card it landed on.
//
// What this module does not try to be is axe's rule. It answers one question about colours and sizes handed
// to it; finding the elements to ask about is the caller's job, and in a test it happens in the browser
// (`expectReadableBrandText`, `e2e/a11y.ts`).

import { contrastRatio } from "./contrast";

/** One opaque surface text is drawn on, and where that colour came from. */
export type Surface = { color: string; where: string };

/** An element as this rule needs to see it: what it says, in what colour, at what size and weight. */
export type TextSample = {
  /** A selector-ish description, for the failure message to name the element. */
  where: string;
  /** The element's own text. Only used to tell text from an icon glyph — see `isTextual`. */
  content: string;
  /** `getComputedStyle(node).color`, or a hex as the stylesheet writes it. */
  color: string;
  fontSizePx: number;
  fontWeight: number;
};

export type Unreadable = {
  sample: TextSample;
  /** The surface it did worst against, which is the one the verdict is about. */
  surface: Surface;
  ratio: number;
  bar: number;
};

/**
 * WCAG 1.4.3's minimum for one run of text: 3:1 for large text, 4.5:1 for everything else.
 *
 * "Large" is 18pt, or 14pt bold — 24px, or 18.66px at weight 700 or above, at the 96dpi CSS reference. Both
 * T210 sites are 8px, so the distinction does not decide that ticket; it is here because the bar is a
 * property of the sample and a gate that applied 4.5:1 to a 57px display heading would be wrong about the
 * standard, and would be argued down rather than fixed.
 */
export function wcagTextBar(sample: { fontSizePx: number; fontWeight: number }): number {
  const large = sample.fontSizePx >= 24 || (sample.fontSizePx >= 18.66 && sample.fontWeight >= 700);
  return large ? 3 : 4.5;
}

/**
 * Is this run of characters *text*, or an icon that happens to be a character?
 *
 * WCAG 1.4.3 exempts "incidental" content, and the arrow in a decorative pill is a picture drawn with a
 * glyph rather than something anybody reads. Two live sites are exactly that and are **not** defects:
 * `.patient-report-empty > span`'s `↗` (already `aria-hidden`) and `.home-handoff b`'s `→` between two
 * labels that carry the meaning themselves.
 *
 * The test is "does it contain a letter or a digit", which is what separates those two from the chip: the
 * chip says `1`, and a numeral is read. Deliberately coarse — a glyph with a letter in it would be judged
 * as text, which is the safe direction to be wrong in.
 */
export function isTextual(content: string): boolean {
  return /[\p{L}\p{N}]/u.test(content);
}

/**
 * The surface `color` does worst against, with the ratio.
 *
 * Worst rather than each, because the verdict is one number and the failure message should name the surface
 * that produced it. Throws on an empty list rather than inventing white: a sample judged against nothing
 * would pass.
 */
export function worstSurface(color: string, surfaces: readonly Surface[]): { surface: Surface; ratio: number } {
  if (!surfaces.length) throw new Error("text has to be measured against at least one surface");
  return surfaces
    .map((surface) => ({ surface, ratio: contrastRatio(color, surface.color) }))
    .reduce((worst, next) => (next.ratio < worst.ratio ? next : worst));
}

/**
 * The samples that do not reach their WCAG bar against the worst surface they could be drawn on.
 *
 * Icon glyphs are dropped first (`isTextual`). An empty array is the whole of the claim.
 */
export function unreadableText(
  samples: readonly TextSample[],
  surfaces: readonly Surface[],
): Unreadable[] {
  return samples
    .filter((sample) => isTextual(sample.content))
    .map((sample) => {
      const { surface, ratio } = worstSurface(sample.color, surfaces);
      return { sample, surface, ratio, bar: wcagTextBar(sample) };
    })
    .filter((finding) => finding.ratio < finding.bar);
}

/** One line per finding, naming the element, the two colours, the ratio and the bar it missed. */
export function describeUnreadable(findings: readonly Unreadable[]): string {
  return findings
    .map(
      ({ sample, surface, ratio, bar }) =>
        `  ${sample.where} — "${sample.content.trim().slice(0, 40)}" at ${sample.fontSizePx}px/${sample.fontWeight}: ` +
        `${sample.color} on ${surface.color} (${surface.where}) is ${ratio.toFixed(2)}:1, under ${bar}:1`,
    )
    .join("\n");
}

const TOKEN = /^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\s*;/gim;

/**
 * The colour tokens a stylesheet's first `:root` block declares, as `--name` → hex.
 *
 * Read out of `app/globals.css` rather than copied into this file, so the gate measures the colour the
 * product paints and cannot pass on a value that moved. Only hex values are collected: a token defined as
 * `var(...)` or `color-mix(...)` is a reference or a computation, not a colour this module can measure, and
 * silently skipping it is better than resolving it wrongly.
 */
export function declaredColorTokens(css: string): Map<string, string> {
  const open = css.indexOf(":root");
  if (open < 0) throw new Error("no :root block in the stylesheet");
  const start = css.indexOf("{", open);
  const end = css.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error("no :root block in the stylesheet");
  const block = css.slice(start + 1, end);
  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(TOKEN)) tokens.set(name, value.toLowerCase());
  if (!tokens.size) throw new Error("no colour tokens in the :root block");
  return tokens;
}

/**
 * The tokens the stylesheet paints *text* with, which are the ones the 4.5:1 bar applies to.
 *
 * One, today: `--sweetie-dark`. Every call site of it in `app/globals.css` is a `color:` declaration,
 * directly or through `--theme-dark` under `.sweetie-theme`, and there is no non-text use of it to preserve
 * — which is why T210 moved the token rather than adding a readable companion beside it.
 *
 * `--sweetie` is deliberately *not* here. It is the fill: `--theme`, the colour of a border, a filled step
 * marker, a chart line. Holding a fill to a text minimum would be a claim WCAG does not make, and the way
 * to stop it becoming text is the gate over the live page rather than a number in this list.
 */
export const SWEETIE_TEXT_TOKENS = ["--sweetie-dark"] as const;

/**
 * The brand pinks, for recognising one as the colour of a run of text on a page that is already rendered.
 *
 * Both of them, because this list answers "is this element painting text in the Sweetie pink" and not "is
 * this colour allowed to be text". `--sweetie` is the lighter of the two, so a call site that reached for
 * it would be further under the bar than the one this ticket is about, and a gate that only knew about the
 * colour already fixed would not be a gate (`expectReadableBrandText`, `e2e/a11y.ts`).
 */
export const SWEETIE_BRAND_TOKENS = ["--sweetie", "--sweetie-dark"] as const;

/**
 * The `--sweetie*` tokens a stylesheet reaches for in a `color:` declaration, however indirectly.
 *
 * T210's second acceptance criterion is that the audit is complete rather than two cards, and this is that
 * audit as an assertion: the set of brand tokens the stylesheet paints text with should be exactly
 * `SWEETIE_TEXT_TOKENS`. `--theme-dark` counts as `--sweetie-dark`, since that is what `.sweetie-theme`
 * sets it to and the fallback on `.ss-eyebrow` names it outright; under `.sour-theme` the same slot is
 * `--sour-ink`, which is not a Sweetie pink and not this rule's business.
 */
export function sweetieTextTokensUsed(css: string): string[] {
  const used = new Set<string>();
  for (const [, value] of css.matchAll(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/g)) {
    for (const [, token] of value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      if (token === "--theme-dark") used.add("--sweetie-dark");
      else if (token.startsWith("--sweetie")) used.add(token);
    }
  }
  return [...used].sort();
}

/**
 * The opaque surfaces the Sweetie flow paints that pink text on, worst first in effect.
 *
 * Measured rather than inferred — each is a colour sampled out of a committed screenshot or read straight
 * off the token it comes from, because three of the four are gradients where no element has the colour as
 * its `backgroundColor` and `getComputedStyle` answers `rgba(0, 0, 0, 0)`. That is the same reason
 * `expectVisibleFocusRing` takes its surface as an argument (`e2e/a11y.ts`).
 */
export const SWEETIE_TEXT_SURFACES: readonly Surface[] = [
  { color: "#fff0f4", where: "--sweetie-soft: the narrative-card chips, and the end of .home-lane-sweetie's gradient" },
  { color: "#fff2f5", where: ".patient-range-card's radial-gradient, sampled off desktop-a11y-summary.png" },
  { color: "#fbf9f8", where: ".ss-page's own paper under its blush, which is what .home-section-heading's eyebrow sits on" },
  { color: "#ffffff", where: "the plain cards: .ss-card, .home-lane's gradient at its white end" },
];
