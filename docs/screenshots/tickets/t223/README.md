# T223 — a marker label was painted over the glucose chart's y-axis tick

The labels over the rises on §2.6's brief, §7.4's sheet and §2.7's summary were held clear of each other
(T23) and clear of every marker (T197), and nothing held them clear of the `250` down the left of the same
chart. At 375px a rise that peaks high and early in the window put its label straight through that tick:

> `docs/screenshots/tickets/t221/mobile-provider-print-one-placed-of-three.png` — the place label
> `37.777, -122.423` drawn on the `250`, with neither the tick's digits nor the label's left end readable.

Sixteen characters of coordinate pair centred 19.8px along a 177px plot start 23px **left of the plot
itself**, which is inside the y-axis gutter. The caption over every one of these charts promises labels
"where they fit", so this is that claim failing a third way in the same genre.

## The rule

`lib/markerLabels.ts`, beside the other two: **a label starts inside the plot, or it is dropped.**

```ts
const LEFT_LIMIT = 0;
…
if (x[i] - half < LEFT_LIMIT) return;        // T223: the axis
if (x[i] - half < lastLabelEnds) return;     // T23: the last label kept
if (x.some(…)) return;                       // T197: every marker
```

The boundary is the plot's own left edge rather than the end of the tick text, and the gutter between the
two is why that is the right place for it. `AXIS_TEXT_REACH` — `Y_AXIS.tickSize + Y_AXIS.tickMargin`, 8px —
is the empty space Recharts leaves there: it lays a left axis out from the plot edge backwards, so a label
that only just keeps the rule is still eight pixels clear of the digits. Visible on this ticket's own
evidence frame, `../t221/desktop-provider-print-one-placed-of-three.png`: the `250` ends at 354px and the
grid starts at 362px.

That eight is not spare change. `plot` is `card - 80` and the chrome Recharts lays out is 108, so every
`plot` in this product names a drawing area 28px wider than the one on screen, and a label the arithmetic
puts exactly on the plot's edge is really `half × 28 / plot` to the left of it — 5.9px for the longest label
this product draws over the narrowest plot it draws, inside the eight. The 80 stays where T23 left it
because `lib/timeAxis.ts`'s label widths were measured against it (T190); `lib/markerLabels.test.ts` holds
the bound instead.

**Horizontal only, deliberately.** The ticks sit at 70, 180 and 250 and every marker label is drawn above a
peak over 180, so a label that reaches back into the gutter is beside one of them more often than not — and
a rule that also asked *which* tick would have to model the plot's height, the y domain and the offset
Recharts chooses for `position: "top"`, none of which this module is handed. T190 is what estimating a
number Recharts owns costs.

## The frames

The fixture is T221's, `data/fixtures/clarity_three_rises.csv` + `timeline_android.json`: three rises on one
day from 06:00, the first peaking at 08:00 and the only one the matcher places.

| | |
|---|---|
| `mobile-provider-print-one-placed-of-three.png` | §7.4's sheet at 375px. The `250` is clean; `196` and `188` are readable. The place label is **dropped** — it cannot clear the axis, so the caption's promise is kept by not drawing it. This is the before/after pair with the T221 frame above. |
| `mobile-provider-sour-one-placed-of-three.png` | §2.6's brief at 375px, same reading. Its chart is taller, so before this ticket its label cleared the tick by about a line — the near miss that made the defect easy to produce and easy to miss. Dropped here too: the rule is horizontal, and a near miss is not a fit. |
| `desktop-provider-print-one-placed-of-three.png` | The sheet on a desk, where the plot is 553px and the same label starts 18.5px inside it. **Kept**, with the `250` readable beside it — a label is dropped because it does not fit, never because it is long. |
| `desktop-provider-sour-one-placed-of-three.png` | The brief on a desk, the same. |

## What the suite can see now

`expectMarkerLabelsClearOfAxis` in `e2e/charts.ts`, the sibling beside `expectMarkerLabelsClearOfMarkers`:
every drawn label against every y-axis tick box, in viewport pixels, on the five surfaces the marker check
already ran on and on T221's own scenario. Taking `LEFT_LIMIT` out reproduces the ticket exactly —

```
the sheet, one placed rise of three: a y-axis tick at (68.2, 1227.2) is painted over a label
at (81.0, 1235.6) in a 205px plot
```

— and the brief's assertion passes in that same run, which is the near miss above, on the record.

The y-axis locator is `.recharts-yAxis-tick-labels`, not `.recharts-yAxis-ticks`: since Recharts 3.4 a tick
label is portalled out of the axis group and only the label group's class still names the axis. The obvious
selector matches nothing and waits out its budget rather than failing on the comparison, which is how it was
caught here.

## Out of scope and unchanged

The existing marker comparison, byte for byte. `lib/match.ts`, `spikeVisitRelation`, the `Place` column, the
`Spikes > 180` tile and the chart captions — all correct as they stand (T221, T214, T191, T192). The time
axis under the line: untouched, and the reason `PLOT_CHROME` was left alone.
