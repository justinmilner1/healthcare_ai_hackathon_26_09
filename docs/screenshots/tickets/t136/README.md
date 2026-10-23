# T136 — the fifth site on the connect step, and the one that was set largest

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0: 1028 unit tests passing with 0
failures and 1 skipped, 19 infra tests, 265 Playwright tests with 11 skipped, the §11.4 restore drill `ok`;
whole check 13m12s, build 1m32s, e2e 11m00s). The cloud sandbox has no Docker daemon and the Playwright CDN
is blocked — the pre-installed Chromium stands in, which `scripts/agent-check.sh` arranges itself.

Both frames are the connect step **before anything is uploaded**, which is the state every word on it is
written against and the state a patient always arrives in. The deployment has no Dexcom credentials — the
default the check script, the README and the demo all run in — so the Dexcom card is on its `!configured`
branch.

| File | What it shows |
|---|---|
| `desktop-connect-step-no-span.png` | The step at 1280px. The art column reads **"Your data, / in one *picture.*"**, which was *"Your week, / in one picture."* It is still the largest type on the screen — `.artTitle` is `clamp(42px, 4vw, 58px)` against `.connectTitle`'s `clamp(31px, 2.7vw, 42px)` — but it no longer names a span the patient has not chosen yet. Beside it, T132's heading, lede and three card descriptions are unchanged, and `0 of 3 connected` at the foot says why none of them can name one. |
| `mobile-connect-step-no-span.png` | The same step at 375px (§6.5), whole page. The art column stacks **above** the panel here, so the headline is the first thing the patient reads and the only part of the step above the fold; it wraps inside the column with no horizontal scroll. This is the frame that made the string worth a ticket rather than a note. |

## Why "Your data" and not a number

No day count is in scope on this step and none was added: it renders before a single file exists. Every
source on it is a file whose range the **patient** picks — `parseClarityCsv` (`lib/glucose.ts`) keeps every
`EGV` row it is handed, and `data/fixtures/clarity_window.csv` is 84 readings inside one morning;
`lib/whoop.ts` clips nothing; `SleepNight[]` has no span requirement. So the wording is the one T123 settled
for the summary's no-data case and T132 for this step's other strings: say what sharing does, not how much
of it to expect.

The two sibling headlines on the same `<h2>` name no span and are untouched: step 0's "Less paperwork. /
More *you.*" and step 2's "Sweetie's / got *this.*"

## What this closes

T100 → T114 → T116 → T123 → T132 took the rule — the span comes from the data, not from the brand — off one
patient screen at a time. T132 fixed four strings on this step and photographed a fifth it had no mandate to
decide: brand copy of the same shape as `app/page.tsx`'s "7 days of context", which stays out of scope
because it is addressed to nobody in particular, but possessive and addressed to a patient mid-flow. T136 is
that decision, and `docs/screenshots/tickets/t132/README.md` now records where it was made.

With it made, `e2e/connections.spec.ts`'s "the connect step names no span before anything is shared" stops
naming three strings for a frame it was not allowed to sweep. It still names them — the noun pattern
`/\b(hours?|days?|weeks?|months?)\b/i` catches "3 days" and "48 hours", which a `/week/i` negative does not
— and now also asserts the headline above and carries `not.toContainText(/week/i)` over `main`, the scope
the two setup-complete assertions earlier in the file already use. The art panel is inside `main`, so that
negative is what stops a sixth site drifting onto this screen somewhere nobody thought to name.

`lib/dexcomHint.ts`'s OAuth branch keeps its "last 7 days" and is still the one span on the patient path
that stays: it is a fact about what the *connection* fetches, pinned by `lib/dexcom.test.ts`, not a
presumption about a file the patient picks.
