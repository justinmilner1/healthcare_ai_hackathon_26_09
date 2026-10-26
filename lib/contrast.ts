// WCAG 2.1 contrast, for the one thing axe cannot answer about a focus indicator: whether it is visible
// (T166, design §6.4). axe's colour-contrast rule measures text against its background; a focus ring is
// neither, so there is no rule to fail and `e2e/a11y.ts` measures the ring itself and asserts on the number
// this returns.
//
// Two things make it a module rather than three lines in a spec. The sRGB transfer function is easy to write
// wrong in a way nothing notices — a plain channel average agrees with it closely enough on mid greys to
// look right — and the alpha composite is the whole point of the measurement. The pattern this was written
// against is `outline: 3px solid rgba(247, 93, 124, 0.28)`: a ratio taken from the colour as written calls
// it 3.9:1 against white and passes, and the ring a patient actually sees is 1.1:1, because 28% of it is
// the surface underneath.

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNCTIONAL = /^rgba?\(([^)]*)\)$/i;

/** One `#rgb`/`#rrggbb`/`#rrggbbaa` pair of hex digits as 0..255. */
const byte = (digits: string) => Number.parseInt(digits.length === 1 ? digits + digits : digits, 16);

/**
 * Parse the colour syntaxes this suite deals in: hex as a stylesheet writes it, and the `rgb()` / `rgba()`
 * forms `getComputedStyle` hands back.
 *
 * Anything else throws rather than resolving to black, because a focus ring that silently measures as the
 * darkest colour there is would pass every assertion below for the wrong reason.
 */
export function parseColor(input: string): Rgba {
  const text = input.trim();
  if (text.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = HEX.exec(text);
  if (hex) {
    const digits = hex[1];
    const size = digits.length === 3 || digits.length === 4 ? 1 : 2;
    if (digits.length !== size * 3 && digits.length !== size * 4) throw new Error(`not a colour: ${input}`);
    const at = (index: number) => byte(digits.slice(index * size, index * size + size));
    return {
      r: at(0),
      g: at(1),
      b: at(2),
      a: digits.length === size * 4 ? at(3) / 255 : 1,
    };
  }

  const functional = FUNCTIONAL.exec(text);
  if (!functional) throw new Error(`not a colour: ${input}`);
  // Both spellings: `rgb(1, 2, 3)` and the space-separated `rgb(1 2 3 / 0.5)` modern browsers also print.
  const parts = functional[1].replace("/", " ").split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) throw new Error(`not a colour: ${input}`);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/** `color` painted onto `backdrop`, which is taken to be opaque — the surface the ring is drawn on. */
export function composite(color: Rgba, backdrop: Rgba): Rgba {
  const mix = (over: number, under: number) => over * color.a + under * (1 - color.a);
  return { r: mix(color.r, backdrop.r), g: mix(color.g, backdrop.g), b: mix(color.b, backdrop.b), a: 1 };
}

/** WCAG relative luminance of an opaque colour, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The WCAG contrast ratio between `color` and `backdrop`, 1 to 21, with `color` composited onto `backdrop`
 * first so a translucent ring is measured as the colour it paints rather than as the colour it names.
 *
 * 3:1 is the bar for a non-text indicator (WCAG 1.4.11), which is what §6.4 holds a focus ring to.
 */
export function contrastRatio(color: string, backdrop: string): number {
  const under = parseColor(backdrop);
  if (under.a !== 1) throw new Error(`the backdrop a ring is measured against has to be opaque: ${backdrop}`);
  const lighter = Math.max(relativeLuminance(composite(parseColor(color), under)), relativeLuminance(under));
  const darker = Math.min(relativeLuminance(composite(parseColor(color), under)), relativeLuminance(under));
  return (lighter + 0.05) / (darker + 0.05);
}
