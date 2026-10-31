# T206 — §2.7's two narrative cards count what is under them

The last pair of subtitles on the patient's summary that were literals in the JSX, and both were written
for a plural the data need not have (`app/patient/[id]/page.tsx`):

> **What your week showed**
> A **few** patterns worth noticing **together**.
> ① Your readings stayed between 70 and 180 for most of the week.

> **Things you might ask your doctor**
> Bring **these** into your visit, or use **them** as a starting point.
> ① Should I keep the same evening dose?

Both cards render on `length ?`, so each is on screen from **one** item upwards.

## One is what §7 asks for

`lib/prompts.ts` bounds both arrays at **1 to 3** and `lib/sourRun.ts` clamps with `clean(…, 3)`; nothing
raises the floor above one. More than that, the clinician prompt *instructs* the model to return a single
pattern in a named case — "If the data is unremarkable, say so in one pattern rather than inventing one."
So the single-pattern card is the **well-controlled week**, the best outcome §7 has to report, and it was
the one §2.7 described least accurately. That is T199's reasoning about the empty chart caption, one card
up the same page.

## Why nothing had caught it

With no model gateway `degradedPair` (`lib/sourRun.ts`) writes `patterns: []` and `questions: []` for both
audiences, so **neither card had ever been drawn** by a test or appeared in a committed screenshot — at any
count. `e2e/flows.spec.ts:884` says so in as many words. The four frames here are the first of either card.

## The wording, and where it is decided

`lib/patientNarrative.ts`, off the same array the list maps, with the agreement coming from `plural()` in
`lib/plural.ts` rather than a spelled-out branch — the shape `patientChartCaption` and
`patientSpikeCardHeading` already use two cards up this page (T203, T204).

| | one item | two or three |
|---|---|---|
| `patientPatternsSubtitle(patterns)` | A pattern worth noticing. | A few patterns worth noticing together. |
| `patientQuestionsSubtitle(questions)` | Bring this into your visit, or use it as a starting point. | Bring these into your visit, or use them as a starting point. |

"Together" is a relation that needs two things to hold between, so at one it is absent rather than
softened: the rest of each sentence is the same sentence at either count, which is what keeps a later
reword of one branch from leaving the page speaking in two voices. Both of the questions card's pronouns
agree, not just the first — T200's bug was a sentence fixed before the comma and left plural after it.

Out of scope and untouched (AC6): the clinician's brief and the printed sheet, whose `Patterns` and
`Questions` headings make no claim about how many there are. The two headings over these cards are left
alone for the same reason — "What your week showed" counts nothing, and "Things you might ask your doctor"
is a bare plural noun naming the section, the same shape as the clinician's own two.

## The frames

The run behind each page is a real `sour.run`, asserted to have saved the empty-narrative pair this suite
can produce; `page.route` then puts the narrative on it on the way to the browser, patching those two
arrays and nothing else — so every number, rise and chart in the frame is the saved summary's own.

| File | What to look at |
|---|---|
| `desktop-patient-summary-narrative-one.png` | Both cards in one frame over one item each: "A pattern worth noticing." above a single bullet, "Bring this into your visit, or use it as a starting point." above a single numbered line. |
| `mobile-patient-summary-narrative-one.png` | The same pair at the 375px of §6.5, where each sentence sits directly above the one item it counts. |
| `desktop-patient-summary-narrative-three.png` | The direction criteria 1 and 2 promise not to move: at three, §2.7's own wording — "A few patterns worth noticing together." and "Bring these into your visit, or use them as a starting point." |
| `mobile-patient-summary-narrative-three.png` | And that pair at 375px. |
