# T87 screenshots

From `bash scripts/agent-check.sh` on `main`, written by `e2e/a11y.spec.ts` (the summary the issue quoted)
and `e2e/journey.spec.ts` (the four tooltip shots and the sheet). The tooltip shots are new: `e2e/charts.ts`
hovers each chart, asserts the row it opens, and hands the caller the open tooltip to photograph.

Desktop only, which is also where the check lives: §6.5's 375px device has no pointer to hover with, so
there is no tooltip on a phone to take a picture of.

| File | What it shows |
|---|---|
| `desktop-a11y-summary.png` | The screenshot the issue quoted, retaken. The tooltip over the glucose line reads **`Sat 9:30 AM / Glucose: 118 mg/dL`** — the same reading, one separator, no space before the colon. |
| `desktop-journey-10-patient-summary-tooltip-glucose.png` | §2.7, the patient's own summary: `Glucose: 120 mg/dL`. |
| `desktop-journey-10-patient-summary-tooltip-sleep.png` | The same page's sleep columns: `Asleep: 5.9 h · recovery 41%`. The recovery suffix is the part of the string this ticket promised to leave alone, and `e2e/charts.ts` requires it rather than tolerating it. |
| `desktop-journey-12-sour-brief-tooltip-glucose.png` | §2.6, the clinician's brief, drawn from the same two components: `Glucose: 120 mg/dL`. |
| `desktop-journey-12-sour-brief-tooltip-sleep.png` | And its sleep card: `Asleep: 5.9 h · recovery 41%`. |
| `desktop-journey-15-print-sheet.png` | §7.4, the third surface. Its tooltips are asserted in `e2e/journey.spec.ts` and not photographed — the sheet's subject is what the printer puts on the page, and a hover state is not on it. Here to show the sheet itself is unchanged. |

Tooltip colours, the 12px size and the `itemStyle`/`labelStyle` that carry §6.4's contrast and T64's
legibility are untouched; the diff is one prop per chart.
