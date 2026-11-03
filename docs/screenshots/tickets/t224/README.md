# T224 — the plot width handed to the chart modules was 28px wider than the one Recharts draws

`components/GlucoseChart.tsx` measures its card and takes the chart's chrome off to get the drawing area it
hands `lib/timeAxis.ts` (which ticks the time axis) and `lib/markerLabels.ts` (which labels the rises). The
figure it took off was a literal `80`, from T23. Recharts lays out **108**: the plot's left edge is at
`margin.left + YAxis.width` = 52 and its right edge is `margin.right` = 56 in from the other side.

So every `plot` in this product named a drawing area 28px wider than the one on screen. Measured in the
suite's own Chromium, on the six frames these three surfaces draw, by the box of
`.recharts-cartesian-grid` — which *is* the plot, one line per y-axis tick running its full width:

| Frame | card | `data-axis-plot` said | Recharts drew |
|---|---|---|---|
| §2.6's brief at 375px | 289 | 209 | **181** |
| §7.4's sheet at 375px | 285 | 205 | **177** |
| §2.7's own page at 375px | 317 | 237 | **209** |
| §2.6's brief, desk | 868 | 788 | **760** |
| §7.4's sheet, desk | 661 | 581 | **553** |
| §2.7's page, desk | 974 | 894 | **866** |

Nothing measured *within* the plot ever noticed, because every gap inside it was the same fraction of the
same overstated width. What notices is a rule that compares a position in the plot against a real number of
pixels — which is both of the modules that are handed it.

## Why it could not be a one-line change

`lib/timeAxis.ts`'s `LABEL_WIDTH` and `LABEL_GAP` were measured against the overstated widths (T190), so
they silently absorbed the error. Correcting the chrome alone is a regression: `LABEL_WIDTH.day` is 23 and
`LABEL_GAP` was 8, so a weekday was planned at 31px, and §2.7's corrected 209px card gives its seven
midnights 29.87px each — `floor(209 / 31)` is 6, and the chart thins to four weekdays for no reason a reader
could see. The seven really are 29.87px apart on screen and Recharts really needs 27.56px for them
(`"Wed"` measured at 22.5625px plus its own `minTickGap` of 5), so **the product was right and the model was
wrong twice in compensating directions.**

Both had to move together. `LABEL_GAP` is 6:

| `LABEL_GAP` | `day` pitch | margin over Recharts' 27.56px | narrowest plot that still keeps seven |
|---|---|---|---|
| 8 (T190) | 31px | 3.44px | 217px — wider than the card, so the seventh weekday goes |
| 7 | 30px | 2.44px | 210px — still wider than the card |
| **6** | **29px** | **1.44px** | **203px**, 6px of slack under the card as measured |
| 5 | 28px | 0.44px | 196px, and the model is back on the boundary it must not sit on |

The four `LABEL_WIDTH` figures were re-measured on all four grains, in the same browser on the same six
frames, and are unchanged to the digit — what they measure is a string in a font, not a plot.

## The frames

Six, one per surface per width, all on a seven-day export so the weekday grain is the subject.

| | |
|---|---|
| `mobile-provider-sour-week-chart.png` | §2.6's brief at 375px, the seeded week. **Four weekdays** (Sat · Mon · Wed · Fri), which is what its 181px plot has always drawn: too narrow for seven, so the axis thins to a two-day step rather than losing a day silently. Three of the five rises labelled, `250` clean. Unchanged by this ticket, which is the promise. |
| `desktop-provider-sour-week-chart.png` | The same brief on a desk, 760px: **seven weekdays**, every rise labelled. |
| `mobile-provider-print-flat-week.png` | §7.4's sheet at 375px, on `data/fixtures/clarity_flat.csv`. Four weekdays, same branch as the brief and for the same reason — its plot is 177px, the narrowest in the product. |
| `desktop-provider-print-flat-week.png` | The sheet on a desk, 553px: seven weekdays. |
| `mobile-375-patient-summary-full.png` | §2.7's page at 375px, whole — the one standing entry in `e2e/screenshot-exceptions.json`. **All seven weekdays**, on the 209px plot that is the narrowest card keeping them, and the frame the whole `LABEL_GAP` table above is sized against. It is also the one frame whose *marker* labels changed: it drew `206` and both of the patient's `a place you went` until this ticket, and those two place labels were 8.6px apart on screen (left 160.5→237.8 and 246.4→323.7, measured in the suite's Chromium) where `lib/markerLabels.ts` asks for 10px of clear space — the clearance was granted on a plot 13% wider than the one drawn. The later of the two is dropped now; it keeps its marker and its row in `Your biggest rises`, which is what the caption's "the labels that fit" has always meant. |
| `desktop-patient-summary-seven-day.png` | The same page on a desk, 866px: seven weekdays, all five rises labelled, both place labels back. The drop above is about the width and not about the label. |

## What the suite can see now

`e2e/charts.ts` compares `data-axis-plot` with the box of `.recharts-cartesian-grid` on every surface that
reads its axis at all, so a future drift between the model and Recharts' own layout is a failing test rather
than a number nobody is looking at. It is also what caught this ticket's own near miss: a first run of the
check reused a server built from the previous tree, and the assertion said so in those terms — *"the chart
told lib/timeAxis.ts and lib/markerLabels.ts the plot was 788px and Recharts drew 761.0px"*.

In the unit suites: `lib/markerLabels.test.ts` asserts `PLOT_CHROME === DRAWN_CHROME` where it used to assert
that their difference was 28, and `plotWidth` is checked at every card width from 0 to 1600 rather than at
one. `lib/timeAxis.test.ts` asserts both halves of the pitch at every plot from 120 to 1400px: the labels are
never closer than Recharts will paint them, **and** the axis is never thinned while it still had more than
2px a label to spare — which is the half no test had before, and the half that makes `LABEL_GAP` a
measurement rather than a preference.

## Out of scope and unchanged

Where a marker label is painted (T223) and what it says (T128, T191, T192). T223's rule is still the plot's
own left edge; what changed is that the 8px gutter beside the y-axis is now clearance in full rather than
2.1px of it, so a longer `LABEL_CHARS` can no longer re-open that ticket silently. The right-hand edge of the
plot: nothing has ever held a label inside it, and nothing here changes that.
