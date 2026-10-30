# T199 — the chart caption counts its own markers

The caption under the glucose chart announced red markers in the plural on every visit that shared Dexcom
data, including the visit with **one** marker and the visit with **none**. Two readings, three surfaces each
(§2.6's brief, §7.4's printed sheet, §2.7's patient page), both widths.

## One rise

| File | What to look at |
|---|---|
| `desktop-provider-sour-flags.png`, `mobile-provider-sour-flags.png` | The screen the ticket was filed on. "Spikes > 180" reads **1**, the card below lists one row (`Sun 8:40 PM · 160 → 291`), the chart draws one marker labelled `291` — and the caption between them now reads **"Red marker is a spike."** |
| `desktop-provider-print-flags.png`, `mobile-provider-print-flags.png` | The same sentence on §7.4's sheet, out of the one `clinicianChartCaption` (T99). |
| `desktop-patient-summary-one-rise.png`, `mobile-patient-summary-one-rise.png` | §2.7's half, which no screenshot had ever held: **"Marker shows your biggest rise."** over one marker, above a "Your biggest rises" card listing one row. |

## No rise

The *well-controlled* week — the best outcome §7 has to report, and the one the caption described least
accurately. `data/fixtures/clarity_flat.csv`: 168 hourly readings between 88 and 174 mg/dL, so time in range
is 100%, no safety flag fires and `detectSpikes` finds nothing.

| File | What to look at |
|---|---|
| `desktop-provider-sour-flat-week.png`, `mobile-provider-sour-flat-week.png` | **"Shaded band is 70–180 mg/dL. No rises over 180 to mark."** — no claim about markers, and no second clause about labels giving the peak mg/dL. The "Spikes" card under it reads "No spikes over 180 detected.", so caption and card agree. |
| `desktop-provider-print-flat-week.png`, `mobile-provider-print-flat-week.png` | The sheet carrying the same string. |
| `desktop-patient-summary-flat-week.png`, `mobile-patient-summary-flat-week.png` | **"You had no rises over 180, so the chart shows no markers."** — second person, beside 100% time in range and "Above 180 0%", with no rises card under it. |

Both patient shots are anchored on `.patient-card-heading` rather than on the chart: `.patient-chart-wrap`
puts the chart's own top at the top of the frame and scrolls the sentence off above it.
