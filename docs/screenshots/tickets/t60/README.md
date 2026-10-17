# T60 screenshots

From `bash scripts/agent-check.sh` on branch `t60-plural-counts`, written by `e2e/review.spec.ts`
(the single-day shots) and `e2e/print.spec.ts` (the seven-day one).

The bug was on a visit with one day of readings — a patient who uploaded this morning, which is the common
case the day before a visit. `data/fixtures/clarity_window.csv` is exactly that: 84 readings across
2026-09-19, with one spike on it. That is why the `E2E Reviewer` visit is where these were taken.

| File | What it shows |
|---|---|
| `desktop-provider-sour-reviewed.png` | `/provider/<id>?visit=<id>` — the screenshot the issue quoted, now reading `· 1 day · 84 readings`, `· 1 spike` and `Glucose, last 1 day`. All three strings on this screen go through `countOf` in `lib/plural.ts`. |
| `desktop-provider-print-single-day.png` | The same visit's sheet (`GET /provider/visit/<id>/print`). §7.4 makes the sheet the screen's twin, so it counts the day the same way: `· 1 day · 84 readings` and `Glucose, last 1 day`. |
| `mobile-provider-print-single-day.png` | The same sheet at 375px, where the header wraps onto three lines and the count is still on the first of them. |
| `desktop-provider-print.png` | The seven-day `E2E Printer` sheet, unchanged: `· 7 days · 2,016 readings` and `Glucose, last 7 days`. The plural path reads as it did, and the thousands separator the old `toLocaleString()` call gave the reading count is now inside the helper. |

T17's own screenshots still stand: they are all of the seven-day sheet, whose wording this ticket does not
touch, and `desktop-provider-print.png` above is the same screen taken again to show that.
