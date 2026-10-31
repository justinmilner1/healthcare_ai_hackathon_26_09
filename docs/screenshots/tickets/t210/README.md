# T210 — `--sweetie-dark` is the ink, so it is text-grade

`--sweetie-dark` is the pink §2.7 writes its small print in, and at `#e74568` it was below WCAG 2.1 AA
against every surface it was drawn on (design §6.4). The fix is one line of `app/globals.css`; the ticket is
the other two thirds — **which** sites, and **why neither §6.4 nor §12.5 had ever said so**.

## The colour decision: the token moved

Not a darker companion beside it. Every call site of `--sweetie-dark` in `app/globals.css` is a `color:`
declaration — four outright, plus `.ss-eyebrow` and `.ss-step-done span` through `--theme-dark` under
`.sweetie-theme` — so the token has **no non-text use to keep**, and a `--sweetie-text` added next to it
would have left `--sweetie-dark` with zero call sites. `--theme-dark` is text-grade ink in both other themes
already (`--sour-ink` `#293126`, `--sour-green` `#60804f`); the Sweetie slot was the odd one out.

`#e74568` → `#d01b42`: the same `hsl(347, 77%)` hue and saturation, lightness 59% → 46%. The same pink, read
as the same pink in the frames below, and past the bar on the worst paper it is painted on:

| Surface | before | after |
|---|---|---|
| `--sweetie-soft` `#fff0f4` — the narrative chips, and `.home-lane-sweetie`'s gradient at its pink end | 3.49:1 | **4.86:1** |
| `.patient-range-card`'s `radial-gradient`, sampled `#fff2f5` | 3.54:1 | **4.92:1** |
| `#fbf9f8` — `.ss-page`'s own paper, under its blush | 3.67:1 | **5.11:1** |
| `#ffffff` — the plain cards | 3.85:1 | **5.36:1** |

Every one of these is small text by WCAG's definition (large is 24px, or 18.66px bold): the chips are 8px /
750, "TIME IN RANGE" is 8px / 780, the landing eyebrows are 10px / 780. So 4.5:1 is the bar, not 3:1, and
nothing in the table was near it.

## The audit, complete

`grep -n 'sweetie-dark' app/globals.css` was the starting list. Judged on the surface each one actually
paints on:

| Site | What it draws | Verdict |
|---|---|---|
| `.patient-pattern-list li > span:first-child`, `.patient-question-list li > span:first-child` | §2.7's 1 / 2 / 3 chip on both narrative cards, on `--sweetie-soft` | **was 3.49:1** — fixed by the token |
| `.patient-range-number small` | "TIME IN RANGE" under the big percentage, on the gradient | **was 3.54:1** — fixed by the token |
| `.ss-eyebrow` via `--theme-dark` — `app/page.tsx`'s four | the landing eyebrows. Three resolve to this token; `FOR CARE TEAMS` does not, because `.home-lane-sour` re-points `--theme-dark` at `--sour-green` | **was 3.85 / 3.67 / 3.83:1** — three sites the ticket's list did not name, measured off the committed `t209` frames; fixed by the token |
| `.ss-eyebrow` — `VerifyScreen`, `PatientNotice`, `ConsentScreen` | the practice name over each card. Those three overrides set `margin-bottom` only, so the colour is the token | **was 3.85:1** — `.ss-card`'s `rgba(255,255,255,0.94)` over `.ss-page`'s blush samples as `#ffffff` around the glyphs in this run's `desktop-a11y-code.png`; fixed by the token, measured **5.36:1** |
| `.ss-step-done span` via `--theme-dark` | a completed step's numeral on `--theme-soft` | no live site today — both `<Stepper>` call sites are `.sour-theme`, where the slot is `--sour-ink` — but it is a text use of the token and is covered now |
| `.patient-report-empty > span` | the decorative `↗`, already `aria-hidden` | **not a defect.** A glyph used as a picture is not text (WCAG 1.4.3 exempts incidental content), so it is exempted by rule rather than by name: `isTextual` in `lib/textContrast.ts` asks for a letter or a digit |
| `.home-handoff b` | the `→` between "Patient story" and "Clinical signal" | **not a defect**, the same way. The two labels beside it carry the meaning; the arrow is 9px of decoration in a pill |
| the intake page's own eyebrow | `--pink-dark` `#db1b45` in `app/s/[token]/intake/intake.module.css` | **not a defect** — a different, darker pink, 4.94:1 on white, and not this token at all |

One pink on these screens is **not** this token and was checked anyway, since it is the other pink small
print on §2.7: `.patient-finish-card`'s "There's a little more to share", a literal `#9d3452` on its own
`linear-gradient(135deg, #fff5f7, #ffedf2)`. Sampled off this run's `desktop-a11y-summary-narrative.png`
it is **6.45:1**, so it passes on its own and is left alone.

Nothing else reaches for a Sweetie pink as text. `--sweetie` `#f75d7c` is the *fill* (`--theme`): a border, a
filled step marker. It is never a `color:`, and `sweetieTextTokensUsed` (`lib/textContrast.ts`) asserts that
— holding a fill to a text minimum would be a claim WCAG does not make, and `2.79:1` is what it would be.

## Why §6.4 and §12.5 were both green over it

Two different exits from axe's `color-contrast` rule, which is the part worth fixing:

- **the chip is inside an `aria-hidden="true"` subtree** (T208, correctly — the `<ol>` carries the position
  and the numeral must not be said twice), and axe skips a hidden subtree. Hidden from a screen reader is
  not hidden from an eye;
- **"TIME IN RANGE" sits on a gradient.** axe files `color-contrast` as **incomplete** rather than as a
  violation when it cannot resolve the background to one colour, and `e2e/a11y.ts` fails on `serious`
  violations and on `aria-prohibited-attr` incompletes only;
- and the three landing sites were out of reach a third way: §12.5 puts axe on the **patient** pages, so
  nothing in the suite had ever looked at `/`.

Neither exit is a bug in axe — both are it declining to guess. So the guess is made in two places instead,
both of which fail on the colour as it was:

1. **`lib/textContrast.test.ts`** — the token gate. It reads `--sweetie-dark` out of `app/globals.css`
   (`declaredColorTokens`, so the measurement cannot pass on a value that moved) and holds it to 4.5:1 on
   every surface in the table above. Checked by putting `#e74568` back in the stylesheet and re-running:
   four failures, one per surface, each naming the ratio and where the surface came from — plus the
   companion assertion that nothing *declares* the old value any more.
2. **`expectReadableBrandText`** (`e2e/a11y.ts`) — the live gate, over the rendered page. It finds the
   elements **by their colour** rather than by a list of selectors: every element with text of its own whose
   computed `color` is one of the two brand pinks, judged by `wcagTextBar` against the worst declared
   surface. A call site added later is covered without anybody remembering to add it here, which is the
   property these two findings cost two tickets for the want of. Called on the summary with data, the
   summary with both narrative cards, and the landing page.

   Its own silent-pass is closed too: a page with no pink text on it would satisfy "no findings" for free,
   which is the shape of green these two sites already sat under once. So the helper also asserts it found
   something to judge, and says which failure that is. That floor is what makes the three call sites above
   evidence rather than three empty lists — each one is a page the gate measured pink text on and passed.

The icon-glyph exemption is the one judgement in it, and it is in `lib/` with a test on both sides: `↗` and
`→` out, `1` and `TIME IN RANGE` in.

## The frames

Nothing about §2.7's layout, type sizes or spacing moved (criterion 3), so each pair below is a
before-and-after of the **characters' colour** and nothing else — compare against `t208/` and `t209/` beside
it.

Stated as a measurement rather than as an impression, because "only the colour moved" is a claim a pair of
frames can be read either way on. Counting the pixels that are *exactly* the token's value in each frame and
clustering them into bands gives the same count in the same places before and after:

| Frame | pixels at the token's value | bands, by y |
|---|---|---|
| `t209/desktop-landing.png` (`#e74568`) | 683 | 187–193, 827–833, 1048–1054 |
| `t210/desktop-landing.png` (`#d01b42`) | **683** | **187–193, 827–833, 1048–1054** |
| `t208/desktop-a11y-summary-narrative.png` (`#e74568`) | 8 | 152, 182, 466, 496 |
| `t210/desktop-a11y-summary-narrative.png` (`#d01b42`) | **8** | **152, 182, 466, 496** |
| `t208/mobile-a11y-summary-narrative.png` (`#e74568`) | 374 | 366–380, 466–480, 568–582, 922–936, 1001–1015, 1080–1094 |
| `t210/mobile-a11y-summary-narrative.png` (`#d01b42`) | **374** | **the same six, to the pixel** |

Identical glyph coverage in identical positions: the same characters, at the same size and weight, in the
same place, in a different ink. Neither frame holds a pixel of `#e74568` any more. Measured on the rendered
pages the ratios come out a shade better than the table above, because the declared surfaces are the
pinkest point of each gradient rather than the point the glyphs happen to sit on — "TIME IN RANGE" samples
`#fff5f8` around it in `desktop-a11y-summary.png` (5.02:1) and the landing eyebrows 5.36, 5.11 and 5.32:1.
The gate keeps the pessimistic surface; being wrong in that direction is the point of it.

| File | What to look at | Compare with |
|---|---|---|
| `desktop-a11y-summary-narrative.png` | §2.7's two narrative cards. The 1 / 2 / 3 chips: same pill, same `--sweetie-soft` fill, same 8px numeral, darker ink. | `t208/desktop-a11y-summary-narrative.png` |
| `mobile-a11y-summary-narrative.png` | The same pair at the 375px of §6.5. | `t208/mobile-a11y-summary-narrative.png` |
| `desktop-a11y-summary.png` | "TIME IN RANGE" under the big percentage, on the gradient axe would not resolve. | — |
| `mobile-a11y-summary.png` | And the same label at 375px, where the range card stacks. | — |
| `desktop-landing.png` | The three eyebrows this ticket added to the list: "BEFORE THE VISIT · DURING THE VISIT", "ONE CONNECTED CARE JOURNEY", "FOR PATIENTS" — and, beside the last, "FOR CARE TEAMS" still in `--sour-green`, which is the override working. | `t209/desktop-landing.png` |
| `mobile-landing.png` | The hero eyebrow at 375px. | `t209/mobile-landing.png` |
