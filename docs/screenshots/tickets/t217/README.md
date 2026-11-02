# T217 — the a11y narrative frame stops showing a week's patterns over a one-day visit

`desktop-a11y-summary-narrative.png` and `mobile-a11y-summary-narrative.png` are the only frames in the
suite that hold both of §2.7's narrative cards. They read:

```
What your day showed
A few patterns worth noticing together.
  1  Your readings stayed between 70 and 180 for most of the week.
  2  Three of your four overnight highs came after dinners out past 8pm.
  3  Mornings after nights under six hours ran about 20 mg/dL higher.
```

The heading is derived and was right — `spanNoun(stats.days)` over a visit holding one day. Every bullet
under it described a different week.

## It was the fixture, and the product was never wrong

The three sentences are `NARRATIVE_PATTERNS` in `e2e/patient.ts`, patched onto the response by
`patchNarrative` because this suite has no model gateway and `degradedPair` writes `patterns: []` (§6.3,
§11.3). The product could not emit them over this visit: `lib/prompts.ts` tells the model *"The data covers
the ${spanNoun(days)} and nothing more, so never describe it as a longer span than that."*

T206 wrote the set for `e2e/flows.spec.ts`, whose visit is `data/dexcom_clarity_sample.csv` — a real seven
days, where "most of the week" is true. T208 gave it a second reader in `e2e/a11y.spec.ts`, whose visit is
a tenth of that. One span-bearing fixture, two visits of different spans.

## What that visit actually holds

`clarity_window.csv` is 84 readings inside **one calendar day**, and inside that, one morning:

| | |
|---|---|
| Window | 2026-09-19, 06:00 → 12:55 |
| The rise | 98 → **214**, climbing from 07:00, peaking at 08:00 — the single rise the chart draws |
| The dip | down to **48** just before 11:00, back near 100 by noon |
| Sleep | `whoop_cycles.csv`'s three nights — 7.3h/68%, 5.3h/41%, 7.7h/74% |

So the old bullets were wrong three ways, and one of them could not be made right by any rewording: the
three WHOOP nights fall **after** the glucose window, not before it, so there is no "morning after a short
night" in this data at all. That is the pairing this pair of fixtures cannot make.

## The remedy

Criterion 2 asks for a fix that cannot drift back, and rules out editing the three strings in place —
which would leave the next spec to inherit them the same way. So:

**The narrower visit gets a set of its own.** `ONE_DAY_NARRATIVE_PATTERNS` says only what that page shows
and names no span:

```ts
"Your readings climbed from 98 to 214 mg/dL between 7 and 8 in the morning.",
"They dipped to 48 mg/dL just before 11, then settled back near 100.",
"The night you slept 5.3 hours scored your lowest recovery, 41%.",
```

The 5.3h night is the one the Sleep card direct-labels (`SleepChart` labels the shortest and longest), and
its 41% is the Recovery column of the same card's table — so each claim is one the frame itself carries.

**The shared set keeps its words** — `flows.spec.ts`'s visit is the one it was right for, and criterion 4
says that spec does not change — and its comment now states the seven-day span it presumes, so the third
reader knows before it is the third bug (criterion 3).

**The span is asserted, not just fixed.** `expectNoWiderSpan` (`e2e/patient.ts`) decides which words are
too wide off the same day count the heading is drawn from, so it and the page cannot disagree: "week" is
honest at seven days and not at one, plural "days" at two and not at one, a month at neither. The a11y
test reads `days` off the bundle and pins it at 1 first, so widening the fixture fails on that line and
says why.

This is the assertion the frame was missing. Everything these cards were held to — `expectOrderedNarrative`,
the axe pass, T210's contrast check — is about markup and order, and the words were whatever the caller
passed. That is why a week over a day survived to be caught by a reviewer reading a PNG.

## The frames

| File | What to look at |
|---|---|
| `desktop-a11y-summary-narrative.png` | **"What your day showed"** over three bullets that are all about that day. Bullet 2's dip to 48 is the fall the chart draws; bullet 3's 5.3h is the labelled short night on the Sleep card immediately to its left — heading, bullets and the card beside them now agree. |
| `mobile-a11y-summary-narrative.png` | The same cards at 375px (§6.5), where each bullet wraps to two lines and the numeral column stays aligned. Both narrative cards and the questions card under them, unchanged in structure. |

Both are `SCREENFUL` anchored on the patterns card, as T208 took them.

## What this does not assert

The guard catches the **span** claim — "the week" over a day — because span is derived from a number the
page already computes, so the assertion can be exact. It does **not** check counts: "your four overnight
highs" over a visit with one rise would still pass it. Holding counts mechanically would mean parsing
number-words against `spikeTotal` and the night count, which is brittle enough to be worse than nothing.
Those rest on the fixture being written for its visit and saying so — which is what the two comments in
`e2e/patient.ts` are for.

## Out of scope and unchanged

`e2e/flows.spec.ts` and its seven-day visit (criterion 4). `NARRATIVE_QUESTIONS`, which names no span and
is shared by both specs — which is why there is one set of those and two of the patterns. Every rendered
span on the page, all of which were already derived and already correct: this ticket never touched `lib/`
or `app/`, because nothing on a patient's screen was wrong.
