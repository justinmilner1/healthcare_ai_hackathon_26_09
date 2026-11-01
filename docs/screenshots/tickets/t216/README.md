# T216 — the Sour panel's no-bundle branch stops naming a span it cannot read

`app/provider/[id]/sour.tsx`'s `!bundle` branch is the one state §2.6's panel knows nothing in. It read:

```tsx
<p>{loading ? "Sour is reading the week…" : "Select a patient summary."}</p>
```

"the week" is a claim about the span of the patient's data, made where the span is unreadable: the branch is
taken *because* `bundle` is null, so there is no `bundle.stats.days`. When the bundle arrived holding one
day, the header and the chart heading one card down said `1 day` (`countOf(st.days, "day")`) and this line
had already said otherwise.

## The remedy was chosen a year ago, one file away

`app/patient/[id]/page.tsx`'s `!bundle` branch is the same branch on §2.7 and carried the same defect through
T100, T114, T116 and T123. T132 fixed it on a rule its comment still states: there is nothing here to derive
a span from and **none should be added** — drop it, and take a word that is true before any data has
arrived. `"Sweetie is getting your check-in ready…"`.

So the clinician's half says **"Sour is reading the visit…"**. "The visit" is the clinician surface's own
noun for the unit — `visitLabel`, `visitNotStarted`, and `summaryListHeading`'s own "This visit" in the
sidebar beside it — and it is true the moment the branch is reachable, because `loading` is only ever set by
a `load(visitId)` for a visit the page has already selected. It claims nothing about what is inside that
visit, which is the whole of what this branch cannot know.

A derived span was not an option and a fallback was not either: `spanNoun` takes the number this branch does
not have, and `st?.days ?? 7` is the same presumption with extra steps.

## Where the wording lives now

`lib/sourState.ts`, beside the panel's other state-dependent sentences (`narrativeNote`,
`askSourPlaceholder`, `askSourClosedNote`, `summaryListHeading`, `waitingOnPatientNote`) and for the reason
T153 and T156 gave for those: a claim about the page, written as a literal in JSX, where what it describes
branches. Here the unit suite can read it, which is what criterion 4 asks for.

```ts
export function sourPanelEmpty(loading: boolean): string {
  return loading ? "Sour is reading the visit…" : "Select a patient summary.";
}
```

Both halves, not just the one that changed. `"Select a patient summary."` is correct and criterion 2 says it
must not move, so moving the pair into `lib/` is also what makes that assertable: `lib/sourState.test.ts`
pins it to the word, and a reword of it now fails a test rather than passing unnoticed.

The unit tests hold the new wording the way `lib/plural.test.ts` holds the derived spans — as the rule and
not only the literal. Any unit of time put back fails, as does any numeral, and a cross-product asserts that
no span `spanNoun` can produce for 0, 1, 2, 3, 7, 14 or 30 days appears in either string.

## The frames

| File | What to look at |
|---|---|
| `desktop-provider-sour-panel-loading.png`, `mobile-provider-sour-panel-loading.png` | The state the ticket was filed on: a visit selected, its bundle still in flight. **"Sour is reading the visit…"** — no span. The sidebar heading over it reads THIS VISIT (`summaryListHeading`, T156), which agrees: one row, no summary on it. |
| `desktop-provider-sour-panel-unselected.png`, `mobile-provider-sour-panel-unselected.png` | The other half of the same branch, unchanged: **"Select a patient summary."** under a SUMMARIES heading and "No summaries yet." Criterion 2, on screen. |

The loading frame is held rather than raced: `e2e/flows.spec.ts` stalls `GET /api/patient/` on a promise the
test resolves itself, so the shot is of a state the page really passes through and not of a timing accident
(the same device the patient twin uses, and the reason neither depends on a clock a slow box could outrun —
T95). Releasing it resolves the same navigation into the brief, which the test then asserts, so the frame is
a stage of this page and not a branch nothing reaches.

## Also: a CSS comment that preserved the removed wording

`app/globals.css`'s `.patient-page-state` comment still quoted *"Sweetie is getting your week ready…"* — the
string T132 deliberately took out — as the sentence its type size was right for. The selector is right; the
quotation was a year out of date and read as a licence to put the span back (criterion 3). It now quotes
what the page renders, and names the second card it styles: the summary page's unknown-link card uses the
same selector, which "the loading card and nothing else" did not account for.

## Out of scope and unchanged

Every rendered span on either surface, all of which are already correct and derived: the panel header's
`countOf(st.days, "day")`, the chart heading's `Glucose, last {countOf(st?.days ?? 7, "day")}`, and §2.7's
`spanNoun`, `daySpan` and `spanAtAGlance` sites (criterion 6). `lib/uploads.ts`'s WHOOP hint asks for an
export covering the last week rather than describing one, and stays. T132's own wording and its test are
untouched.
