# T212 — the SLEEP table handed to Sour dated every night a day before the night the brief draws

`lib/sour.ts` built the model's `SLEEP` block from `SleepNight.date` **minus one day**, on the premise that
WHOOP dates a cycle by the morning it ended. This repo's parser does not: `parseWhoopCsv` dates a night by
the cycle *start*, which is an evening. So the shift did not undo anything — it moved every night onto the
evening before the patient went to bed, and the brief named each one a weekday earlier than the bars beside
it. `nightOf` is now that date, unshifted, and the weekday is derived in `tz()` like every other time the
model sees (§7, §2.6).

## The disagreement, measured on the seeded `Sam Sample` visit

`data/whoop_sample.csv` through `parseWhoopCsv`, then `renderSourInput(buildSourInput(...))` with
`SUMMARY_TZ=UTC`, against the labels `components/SleepChart.tsx` puts on the same seven rows:

| `SleepNight.date` | hours | the bar | the SLEEP row **before** | the SLEEP row **now** |
|---|---|---|---|---|
| 2026-09-19 | 7.1 | Sat | `Fri 09-18` | `Sat 09-19` |
| 2026-09-20 | 5.4 | Sun | `Sat 09-19` | `Sun 09-20` |
| 2026-09-21 | 7.8 | Mon | `Sun 09-20` | `Mon 09-21` |
| 2026-09-22 | 5.9 | Tue | `Mon 09-21` | `Tue 09-22` |
| 2026-09-23 | 6.6 | Wed | `Tue 09-22` | `Wed 09-23` |
| 2026-09-24 | 8.2 | Thu | `Wed 09-23` | `Thu 09-24` |
| 2026-09-25 | 7.4 | Fri | `Thu 09-24` | `Fri 09-25` |

The shortest night is the one to read the frames by: **5.4 h is Sunday's** on every surface, and the brief
used to call it Saturday's.

## The frames

Three surfaces draw these bars, and all three are here at both widths. Nothing in the pixels changed — that
is the point: the pictures were already right, and it was the table under them that was a day out.

- `desktop-provider-sour.png`, `mobile-provider-sour.png` — the clinician's brief, the frame the bug was
  found in. The **Sleep** card reads `Sat Sun Mon Tue Wed Thu Fri` with `5.4h` over **Sun** and `8.2h` over
  **Thu**. Three other readings of the same week share that calendar in the same frame: the glucose axis
  (`Sat … Fri`), the spike table (`Sun 10:30 PM`, `Tue 10:45 PM`, `Fri 7:40 PM`), and the seeded answer under
  *Discuss with Sour* ("Of the 5, 3 peak after 19:00 — Sun 22:30, Tue 22:45, Fri 19:40 … Sleep on those three
  nights averages 6.2h against 7.4h"). The model's table is the fourth now, and no longer the odd one out.
- `desktop-provider-print.png`, `mobile-provider-print.png` — the §7.4 one-pager. Same card, same seven
  weekdays, `5.4h` on **Sun**.
- `desktop-patient-summary-sleep-recovery.png`, `mobile-patient-summary-sleep-recovery.png` — the patient's
  own view (§2.7). Its open **Table** twin is the calendar written out: `2026-09-19 · 7.1 h` against the Sat
  bar, `2026-09-20 · 5.4 h` against the Sun bar. That is the pairing the brief now agrees with, and the
  reason this frame is the one to check the fix against rather than a chart alone.

## What else moved with it

- **The dinner join.** `lateDinnerBefore` keys on `localDate(s.visit.end)` and looked that up by the shifted
  date, so a Saturday-evening stop was reported as the dinner before *Friday's* sleep. A stop left on the
  evening of `D` is now the dinner before the night of `D` — the night slept after it, which is the pairing
  §7's worked example rests on.
- **The summary zone.** This was the one block in the module that ignored `tz()`: it parsed and formatted in
  the process zone and locale, so a non-UTC `SUMMARY_TZ` could drop every dinner. The weekday now comes off
  a `localNoon()` anchor in `tz()`; `lib/sour.test.ts` holds the weekdays and the join at `Europe/Berlin`
  (UTC+2) and `Atlantic/Cape_Verde` (UTC-1).
- **The prompt.** `lib/prompts.ts` told the model the nights were "labeled by the evening before" while
  handing it an exemplar ("5.4 h Sun, 5.9 h Tue") lifted from the chart's labels — one calendar described,
  another supplied. It says *night of* now, and the exemplar is what the table says.
- **Where the contract lives.** Four readings of `SleepNight.date` each restated a premise about WHOOP's
  export. It is stated once now, beside `parseWhoopCsv` in `lib/sleep.ts`, and `lib/types.ts`, `lib/sour.ts`,
  `lib/seedFollowUp.ts` and `components/SleepChart.tsx` cite it. The parser also reads the date off the
  export's text rather than off the instant it parsed to, so the field no longer moves with the zone the
  parse happens in (a date-only cell parses as UTC midnight, a cell with a time and no offset as
  process-local — opposite drifts for the two shapes WHOOP writes).
