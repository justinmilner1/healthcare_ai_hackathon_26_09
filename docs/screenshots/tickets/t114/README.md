# T114 — four more places on the patient path still called the shared data "your week"

From the `bash scripts/agent-check.sh` run that passed on the tree these commits landed as. The pair to read
first is the two `*-foot` shots at one width: the same card, over one day of readings and over seven.

| File | What it shows |
|---|---|
| `desktop-patient-summary-single-day-foot.png` | §2.7, the foot of the patient's own page on the single-day visit (`data/fixtures/clarity_window.csv`, 84 readings inside one day). "Your doctor's office is preparing a short summary of **your day**." It read "your week" before this ticket, under a chart of one morning. |
| `desktop-patient-summary-seven-day-foot.png` | The same card on the seven-day visit (`data/dexcom_clarity_sample.csv`, the Sat–Fri chart above it). "a short summary of **your week**" — the wording the page was written with, unchanged, which is the other half of the acceptance criteria. |
| `mobile-patient-summary-single-day-foot.png` | The same single-day card at 375px (§6.5). The sentence wraps to two lines and the span is on the first. |
| `mobile-patient-summary-seven-day-foot.png` | And the seven-day card at 375px, framed identically, so the pair is a before-and-after of one part of one page rather than two different parts. |
| `desktop-patient-summary-single-day.png` | The top of the same single-day page, which is the frame the ticket was filed against: T100's "for 76% of **the day you shared**" beside a `HISTORY / 1 / day` tile. With the foot shot above it, the whole page now names one span. |
| `mobile-patient-summary-single-day.png` | The same at 375px: 76%, "the day you shared", `HISTORY 1 day`, `84 readings`. |

The heading over the model's patterns — "What your week showed" at seven days, "What your day showed" at one —
is the fourth site and is in none of these frames, because it needs a non-empty `patterns` to render and the
check script runs with no model key, so Sour saves both narrative sections empty (§6.3, §11.3). Its wording is
asserted in `lib/plural.test.ts`; the e2e assertion in `e2e/flows.spec.ts` is the negative one over the whole
card, which holds whichever of the two cards is on screen.
