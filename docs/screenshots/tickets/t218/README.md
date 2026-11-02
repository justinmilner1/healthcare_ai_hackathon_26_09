# T218 — the sleep card stops being framed as the glucose span

`desktop-a11y-summary.png` and `mobile-a11y-summary.png` are the patient summary over the pairing this
ticket was filed on. Before this ticket they read:

```
YOUR DAY WITH SWEETIE
Your glucose was between 70 and 180 for 76% of the day you shared
HISTORY / 1 / day     AVERAGE / 117 / mg/dL     SLEEP / 6.8 / hours / night
Your sleep
Nightly sleep and recovery from your connected data.
  ▮ Sat   ▮ Sun   ▮ Mon          ← three nights
```

A page that says "day" in four places, plotting a bar per night for Sat, Sun and Mon beside a tile reading
`1 day`, with `6.8 hours / night` averaged over all three.

## Nothing named the wrong span

T100 → T114 → T116 → T123 → T132 → T207 took one rule onto this page a string at a time: **the span comes
from the data, not from the brand.** Every span claim on `/patient/<token>` reads `spanNoun(stats.days)`
out of `lib/plural.ts`, so no literal can disagree with the `History` tile. All of those strings were
right here. This is the same rule broken from the other end — the sleep card's **data** is a different
span from the one the page is framed as, and no string on the page said so.

`stats.days` is derived from the glucose series alone (`lib/bundle.ts`, `computeStats`):

```ts
const days = n ? Math.max(1, Math.round((Date.parse(glucose[n - 1].t) - Date.parse(glucose[0].t)) / 86400000)) : 0;
```

`bundle.sleep` is parsed from a WHOOP export — a separate upload with its own range, which §9.3 leaves to
the §2.5 data panel. Nothing reconciled the two, so the glucose span was printed as the whole page's span
and the sleep series silently overran it.

With the committed fixtures the overrun is most of the card:

| Fixture | Range |
|---|---|
| `data/fixtures/clarity_window.csv` | Sat **19 Sep**, 06:00–12:55 — 84 readings, one morning |
| `data/fixtures/whoop_cycles.csv` | **19→20, 20→21, 21→22** — three nights |

Two of the three nights fall entirely **after** the only day of glucose the page is about, and the
`6.8 hours / night` tile is an average over all three. The common pairing, because the two exporters have
unrelated default ranges.

## The remedy: the card names its own span

AC2 offered two resolutions — the card naming its own span, or the nights being clipped. §7 makes the
numbers code-generated and they are **right for the data each came from**, so clipping would throw away
real nights and move a correct average to fix a labelling fault. Nothing is clipped and no figure moves.

`lib/sleepSpan.ts` is the one decision, and the predicate is a count against a count because that is what
the surfaces hold — `GlucoseStats` carries `days`, not the window it was measured over, and one bar is one
night:

```ts
export function sleepSpanOverruns(sleep: SleepNight[], days: number): boolean {
  return days >= 1 && sleep.length > days;
}
```

Strictly greater, so a sleep series *inside* the frame is untouched: three scored nights of a week the page
correctly claims is not this bug, and every committed §12.3 shot of a week rests on that wording not
moving. `days >= 1` is the one branch worth stating — with no readings the page makes no span claim for a
card to contradict (the hero's nothing-shared branch names no span, T116/T132, and both clinician surfaces
gate their sleep card on `status.hasDexcom`).

Four wordings compose from one clause, so no surface decides it:

| Surface | Before | After |
|---|---|---|
| §2.7 `SLEEP` tile detail | `"hours / night"` (literal in the page) | `hours · 3 nights` |
| §2.7 sleep card subtitle | `Nightly sleep and recovery from your connected data.` | …`These 3 nights cover more than the day of glucose above.` |
| §2.6 brief / §7.4 sheet, sleep card heading | `Sleep` (literal in both) | `Sleep, 3 nights` |
| §2.6 brief / §7.4 sheet, `Sleep` tile hint | `recovery 61%` | `3 nights · recovery 61%` |

The glucose side of the patient clause is `spanNoun`'s noun, like the four sentences the page already
composes from it, so the clause and the hero over it cannot disagree about what arrived.

## The clinician side was latent, not clean

`app/provider/[id]/sour.tsx` and `app/provider/visit/[id]/print/page.tsx` head their chart card
`Glucose, last {countOf(st.days, "day")}` — correct, and about the glucose. The sleep card beside it was
headed with the bare literal `Sleep`, so it inherited that frame; the `Sleep` tile's `h/night` was honest
about the rate and silent about the count. No committed shot showed it only because **every single-day
provider fixture in the suite has no WHOOP data** (`desktop-provider-print-single-day.png`,
`desktop-provider-sour-flags.png` both read `— / no WHOOP data`).

So the suite had no way to draw the frame. `visitWithReadings` in `e2e/flags.spec.ts` now takes an optional
WHOOP export, and a new test drives the same fixture pair through the brief and the sheet — which is what
`provider-sour-sleep-span` and `provider-print-sleep-span` are.

## How it is held

- `lib/sleepSpan.test.ts` — the mismatched pair read out of the committed fixtures through `computeStats`,
  not written out here (AC4). It pins the pair first (`days === 1`, three nights, `6.8`), then every
  wording, then the equivalence that makes AC2 true: across spans 0, 1, 2, 3, 4, 7 and 14, all four
  surfaces count or do not count together.
- `lib/sleepRecovery.test.ts` — the span clause rides on whichever recovery branch the sentence took, and
  adds no `recovery` of its own. T205's two sentences are asserted unchanged at a span they fit.
- `e2e/a11y.spec.ts` — the patient frame, at **both widths**, on the test that has uploaded this pair since
  T206. It reads `stats.days` and the night count off the bundle first, so a widened fixture fails there
  and names the reason, and ends on `expectNoWiderSpan` against the card's **own** span (AC5).
- `e2e/flags.spec.ts` — the brief and §7.4's sheet, with the bare `Sleep` heading asserted to be gone
  (`toHaveCount(0)`): the heading this replaced is a substring of the new one, so a loose match would pass
  over the bug.

## The frames

| File | What to look at |
|---|---|
| `desktop-a11y-summary.png` | The whole frame the ticket was filed on, corrected: `HISTORY / 1 / day` and `SLEEP / 6.8 / hours · 3 nights` in one tile row, and the card at the bottom plotting Sat, Sun and Mon under a subtitle that says which of the two those bars are. |
| `desktop-a11y-summary-sleep.png` · `mobile-a11y-summary-sleep.png` | The card on its own, at both widths. The phone frame is the one the shot above cannot give: `a11y-summary` is a whole document on the desktop and one screenful on a phone, so at 375px the card had never been in a frame. The subtitle is a sentence longer than it was — where it wraps is the thing to look at (§6.5). |
| `desktop-provider-sour-sleep-span.png` · `mobile-provider-sour-sleep-span.png` | The brief, anchored so the frame holds the **pair**: `Glucose, last 1 day` over `Sleep, 3 nights`. A frame of the fix without the heading it was disagreeing with is not evidence of much. |
| `desktop-provider-sour-sleep-span-tiles.png` · `mobile-provider-sour-sleep-span-tiles.png` | The brief's other half, three cards up: `6.8` over `h/night`, with `3 nights · recovery 61%` under it — beside the GMI tile that hedges its own span for the same reason (T185). |
| `desktop-provider-print-sleep-span.png` · `mobile-provider-print-sleep-span.png` | §7.4's sheet, where one function serves both headings and both hints. The copy carried into the room cannot frame these nights more loosely than the brief does. |

None of these pairings existed before this ticket: every single-day provider fixture in the suite has no
WHOOP data, so the brief and the sheet had no frame in which the two spans could be seen to disagree.

## What this does not change

No number. `sleepAvgHours` is still `6.8` over all three nights, `recoveryAvg` still `61`, and `stats.days`
is still the glucose span — §7 makes them code-generated and they are right for the data each came from
(the ticket says so itself: "a wording/labelling bug, not a numbers bug"). Nothing is clipped, so a patient
who uploaded a fuller WHOOP export still sees every night of it.

Nor does it change the uncounted branch. A week of glucose with a week of nights reads exactly as it did:
`hours / night` on the tile, T205's two sentences on the card, a one-word `Sleep` heading on both clinician
surfaces. `e2e/flows.spec.ts`'s two sleep-card tests run over `data/dexcom_clarity_sample.csv`'s seven days
beside seven WHOOP nights and assert those sentences unchanged — which is the promise this ticket had to
keep while fixing the other case.

## What it does not catch

The predicate is a count against a count — three nights against one day — because that is what the surfaces
hold: `GlucoseStats` carries `days` and not the window it was measured over. So a sleep series of the right
*size* but the wrong *dates* — three nights a fortnight before three days of glucose — reads as fitting and
is not flagged. Catching that means carrying the glucose window on the bundle and comparing intervals,
which is a `lib/types.ts` change this ticket does not have, and the common failure is the overrun rather
than the disjoint pair. Worth a ticket if a fixture ever pairs them that way.
