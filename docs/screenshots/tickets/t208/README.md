# T208 — §2.7's two narrative cards are one ordered list, announced once

The two cards T206 first put in a frame, read this time as a screen reader resolves them
(`app/patient/[id]/page.tsx`). Both draw a numeral down their left edge; both suppress the list marker that
would otherwise draw one (`list-style: none`, the shared `.patient-pattern-list, .patient-question-list`
rule in `app/globals.css`). So each card had **two** numbers available to the accessibility tree and had to
expose exactly one — and each was wrong in its own direction:

| | before | what was wrong |
|---|---|---|
| **What your week showed** | `<ul>` + `<span>{index + 1}</span>` | The markup said the order does not matter over content §7 orders. `lib/prompts.ts` asks for these "most important first", `lib/sourRun.ts` keeps them that way, and the page draws 1, 2, 3. |
| **Things you might ask your doctor** | `<ol>` + `<span>{index + 1}</span>` | The number was said twice: the `<ol>` carries the position *and* the span was in the tree. "list, 3 items — item 1, **1**, Should I keep the same evening dose?" |

Both are `<ol>` now, and the chip in each carries `aria-hidden="true"`: the position is in the tree once, by
the list, and the numeral stays in the picture for the eye. `app/globals.css` records that the marker
suppression and the `aria-hidden` are one decision, so a later edit cannot take half of it.

## Why §12.5 had not caught it

`e2e/a11y.spec.ts`'s "the patient summary passes axe, empty and full" is the §12.5 check for §2.7, and its
own comment listed what it covered: charts, the spike table, the sleep panel, the week's numbers. **Neither
narrative card was in that list, because neither was on the page.** Both render on `length ?`, the suite has
no model gateway, and `degradedPair` (`lib/sourRun.ts`) writes `patterns: []` and `questions: []` — so axe
had never read either card, at any count, on any run.

It reads both now, over a page built the way T206's test builds one: a real `sour.run` saves the pair this
suite can produce, asserted empty, and only `patterns` and `questions` are patched onto the bundle on its
way to the browser (`patchNarrative`, `e2e/patient.ts`, now shared by both specs). Every number, flag and
chart in the frames below is the saved summary's own.

## What is asserted, because axe has no rule for either half

A `<ul>` whose order is meaningful is valid markup, and a numeral said twice is valid markup read badly.
`expectOrderedNarrative` (`e2e/patient.ts`) names both, for each card:

- one `<ol>` on the card and no `<ul>` — the **element**, not the role, because `<ul>` and `<ol>` both
  resolve to `role=list` and which element it is *is* the thing this covers;
- one item per entry, a numeral drawn per item, and the first of them visible — `aria-hidden` changes what
  is announced and nothing about what is drawn;
- every chip out of the accessibility tree;
- and the tree itself, as an aria snapshot: one `listitem` per item, announced as its own sentence with no
  numeral in front of it.

Checked by removing the `aria-hidden` and re-running: the run fails on "the patterns card: every numeral is
out of the accessibility tree", resolving 3 elements where it wants 0.

## The frames

| File | What to look at |
|---|---|
| `desktop-a11y-summary-narrative.png` | The page axe reads, with both cards on it: "What your day showed" over three bullets and "Things you might ask your doctor" over three numbered lines, each chip a numeral in its own pill. This is the frame §12.5 now judges. |
| `mobile-a11y-summary-narrative.png` | The same pair at the 375px of §6.5, where each numeral sits beside the sentence it belongs to and the list wraps to two lines without the chip moving. |
| `desktop-patient-summary-narrative-three.png` | Criterion 3's evidence, taken by T206's own test and unchanged by this ticket: the same card at the same count, to be compared with `docs/screenshots/tickets/t206/` beside it. |
| `mobile-patient-summary-narrative-three.png` | And that comparison at 375px. |

The two `narrative-three` frames are the before-and-after of what is **drawn**: this ticket changed what is
announced, so they read identically to T206's. Compared side by side, the only difference in either pair is
the footer's "Generated Oct 31, 2:45 PM" against this run's "6:48 PM" — every card, chip, numeral and line
break is in the same place. The `a11y-summary-narrative` pair is the new evidence: the first frame of either
card taken on a run where axe looked at it.

## One thing out of scope, noted rather than fixed

The chip's own colours are `--sweetie-dark` (`#e74568`) on `--sweetie-soft` (`#fff0f4`), which
`lib/contrast.ts` measures at **3.49:1** — below the 4.5:1 WCAG 2.1 AA asks of text that size (8px, weight
750, so not "large"). axe does not report it, with or without the `aria-hidden`: the run above passed the
§12.5 call both times, and the failure that stopped the second one was this ticket's own assertion. So it is
not something T208 either introduced or hid. Fixing it would change what is drawn, which acceptance
criterion 3 of this ticket forbids, so it is left alone and written down here and on the issue for whoever
judges it as its own ticket.
