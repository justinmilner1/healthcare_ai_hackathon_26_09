# T205 — the patient's sleep card says recovery only where the export carries it

§2.7's card under "Your sleep" was subtitled **"Nightly sleep and recovery from your connected data."** with
nothing in it conditional on whether the week had a recovery score in it. Recovery is optional in the data —
`SleepNight.recovery` is `number | undefined` (`lib/types.ts`) — and `parseWhoopCsv` matches its columns
loosely on purpose (`lib/sleep.ts`: "Column names vary by export; match loosely"), so an export whose header
names no recovery column leaves **every night of that upload** without one. `data/fixtures/whoop_alt_headers.csv`
is that export: its header is `Date,Sleep duration (min),Sleep performance %`, and `lib/sleep.test.ts` has
pinned the `recovery: undefined` result since T25.

Over that upload the card read:

> **Your sleep**
> Nightly sleep **and recovery** from your connected data.
> … two columns of hours. Hovering one: `Asleep: 6.8 h` …
> **Table ▸**
> | Night | Asleep | **Recovery** |
> | 2026-09-19 | 6.8 h | **—** |
> | 2026-09-21 | 5.5 h | **—** |

Nothing inside the card carried a recovery score. The tooltip's suffix is already conditional and drops out
(`components/SleepChart.tsx`), the columns plot `hours` alone, and the table's Recovery column was two rows of
em dash — so the subtitle was the only element on the screen that mentioned the word, and the one element the
data could not support.

## The clinician's twin already hedged it

Both clinician surfaces hang the recovery line off a null check and omit it when there is none
(`app/provider/[id]/sour.tsx`, `app/provider/visit/[id]/print/page.tsx`):

```tsx
<StatTile label="Sleep" value={st.sleepAvgHours.toFixed(1)} unit="h/night"
          hint={st.recoveryAvg !== null ? `recovery ${st.recoveryAvg}%` : undefined} />
```

`recoveryAvg` becomes `null` in `lib/bundle.ts` by filtering the nights that carry a number — which is the
predicate this ticket needed and which §2.7 did not consult.

## The wording, and where it is decided

`lib/sleepRecovery.ts`, beside the predicate, rather than as a literal in the JSX (T198 AC2, T199 AC4,
T200 AC2, T202 AC2, T203 AC2, T204 AC2) — which is also why this one was never caught: there was nothing in
`lib/` for the unit suite to call.

| | |
|---|---|
| `recoveryScores(sleep)` | the scores the nights actually carry. `computeStats` in `lib/bundle.ts` now takes `recoveryAvg` off **this**, so `recoveryAvg === null` and `anyRecoveryKnown` are one question asked once (AC2, the `anyPlaceKnown` lesson of T82). `lib/bundle.test.ts` pins the equivalence. |
| `anyRecoveryKnown(sleep)` | `some`, not `every`: a mixed week may still say recovery, because there is a score on the card to read. |
| `sleepRecoveryColumn(sleep)` | whether the table draws its **Recovery** column. The same predicate as the subtitle, so the card cannot say the word over a table with no column for it. |
| `patientSleepCardSubtitle(sleep)` | **"Nightly sleep and recovery from your connected data."** with a score, **"Nightly sleep from your connected data."** without — the same sentence with and without the clause it cannot support, rather than two sentences a reword could pull apart. |

The recovery branch is §2.7's existing copy, unchanged (AC4). Out of scope and untouched: both clinician
surfaces, which already omit the hint correctly; the tooltip's suffix, which was already conditional; and
`parseWhoopCsv` itself, whose loose matching is the behaviour this reports on rather than a bug.

## The column, not just the sentence

AC3: on a week with no score the **Recovery** column is not drawn at all. A column header is itself a claim
that the data has that field — what T82 settled for the rises table's Where column — and a column of em dash
reports nothing but its own absence while costing a 375px phone a third of its width (§6.5). On a mixed week
the column stays, and the em dash goes back to meaning *this night* rather than *this export*.

## Both shapes, both widths

`e2e/flows.spec.ts` drives §2.7 with `data/fixtures/whoop_alt_headers.csv` as the WHOOP upload — the first
time the running product has been driven with it — beside a second test on `data/whoop_sample.csv`, which is
the week the subtitle was always right about. `e2e/charts.ts`'s `ASLEEP` pattern keeps its **required**
recovery suffix for the two samples it was written against (AC6); the unscored upload gets
`ASLEEP_NO_RECOVERY`, its own expectation, beside it.

| File | What to look at |
|---|---|
| `desktop-patient-summary-sleep-no-recovery.png` | The card over the export with no recovery column. The subtitle reads "Nightly sleep from your connected data." and the Table disclosure under the columns is **Night / Asleep** — no third column, no em dashes. |
| `mobile-patient-summary-sleep-no-recovery.png` | The same card at the 375px of §6.5, where the dropped column is the width it gives back. |
| `desktop-patient-summary-sleep-recovery.png` | The direction that must not move (AC4). `data/whoop_sample.csv` scores every night, so the subtitle is the sentence §2.7 has always shown and the Recovery column is there with percentages in it. |
| `mobile-patient-summary-sleep-recovery.png` | And that card at 375px, with its three columns. |
