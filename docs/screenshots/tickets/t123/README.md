# T123 — the patient summary hero still said "your week" for one day and for nothing shared

From the `bash scripts/agent-check.sh` run that passed (exit 0) on the tree these commits landed as. The
eyebrow over the hero was the one line on this page that rendered the same string whatever arrived, because
it sits above both branches of `app/patient/[id]/page.tsx` and no spec asserted it. These are the three
states it now has, one frame each.

| File | What it shows |
|---|---|
| `desktop-patient-summary-single-day.png` | §2.7, the single-day visit (`data/fixtures/clarity_window.csv`, 84 readings inside one morning). **YOUR DAY WITH SWEETIE**, in the same 1280px frame as T114's "for 76% of **the day you shared**", a `HISTORY / 1 / day` tile and "a short summary of **your day**". The same frame in `docs/screenshots/tickets/t114/` reads "YOUR WEEK WITH SWEETIE" above those three — the contradiction this ticket was filed for, in T114's own evidence. |
| `desktop-patient-summary-no-places.png` | The seven-day visit (`data/dexcom_clarity_sample.csv`, the Sat–Fri chart). **YOUR WEEK WITH SWEETIE** over "97% of the week" and `HISTORY / 7 / days`, unchanged — `spanNoun()` branches on seven rather than defaulting to it, which is the other half of the acceptance criteria. |
| `desktop-a11y-summary-empty.png` | A visit with nothing shared. **YOUR CHECK-IN WITH SWEETIE**: no span at all above "Your glucose story is ready for its first chapter", and the card under it no longer presumes one either — "turn **your readings** into a clear picture" where it read "turn **the past week**" (§2.5, `lib/dexcomHint.ts`). |
| `mobile-a11y-summary-empty.png` | The same empty hero at 375px (§6.5). "YOUR CHECK-IN WITH SWEETIE" is the longest of the three eyebrows and still sets on one line. |

There is no mobile frame of the single-day hero here, and none was added: `mobile-patient-summary-single-day.png`
is anchored with `scrollTo: ".patient-overview"` (T100 — the claim and the tile that contradicted it stack at
375px and are what that shot was taken for), so the hero is scrolled out of it. The phone width of this
ticket's change is covered by the empty shot above, and the eyebrow's three states are each asserted in the
suite rather than only photographed — `e2e/flows.spec.ts` for one day and for seven, `e2e/a11y.spec.ts` for
nothing shared, all three through the one selector in `e2e/patient.ts`.
