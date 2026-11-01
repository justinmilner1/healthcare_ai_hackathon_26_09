# T214 — the clinician's chart caption offers a reading only where the chart carries it

`clinicianPlaceReport` answers `matched` as soon as **one** listed rise carries a stop (`anyPlaceKnown`), so
that one branch of `clinicianChartCaption` captions two different charts: one whose labels are a mix of
places and peak numbers, and one whose labels are **all** places. The trailing clause was fixed on both:

> Shaded band is 70–180 mg/dL. Red marker is a spike. Labels, where they fit, give the place the
> patient had just left, **or the peak mg/dL where no place matched**.
>
> **Spike linked to a place**
> | When | Rise | Place |
> | Sat 8:00 AM | 96 → 214 | 37.777, -122.423 · left 10 min before |

One marker, one label, and that label is a place. "or the peak mg/dL where no place matched" is a reading
offered for labels that are not on the chart — directly above a card headed "Spike linked to a place" and a
tile reading `1 · 1 linked to a place`.

Where every listed rise matched, the sentence now ends at the place clause. Where one or more carry no place,
it offers both readings, word for word as T191 and T192 settled it.

## The mechanism

A counterpart to `anyPlaceKnown`, derived in `lib/spikePlaces.ts` beside it rather than at the call site, as
every other reading of this caption is:

```ts
export function anyPlaceMissing(spikes: Spike[]): boolean {
  return spikes.some((s) => !s.visit);
}
```

It is not that predicate's negation, and that is the point of having two. `anyPlaceKnown` is false only when
*no* rise has a place; this is true as soon as *one* lacks one. Between them they tell the three shapes of a
chart apart, and the middle one is what had no predicate:

| the listed rises | `anyPlaceKnown` | `anyPlaceMissing` | report | the labels on the chart |
|---|---|---|---|---|
| all matched | `true` | `false` | `matched` | every one a place |
| some matched | `true` | `true` | `matched` | places and peak numbers |
| none matched | `false` | `true` | `unmatched` | every one a peak number |

The first two rows are one report and two captions, which is why the branch could not be written off the
report alone.

## Why it survived five corrections to this sentence

The function's doc comment keeps a list of what it therefore does not say, and every ticket on this caption
has added an entry: not that a label is a place unless one is (T99, T184), not that every marker carries a
label, not that the markers are the week's rises when they are the largest few (T165), not that there is
more than one marker over one rise (T199), not "any of these rises" over one (T200), not a relation the
labels do not have (T191, T192). The symmetric claim to the first was the one missing — **not that some
label is a peak number when every label is a place** — and it is on the list now.

The all-matched chart is not a contrived shape: it is every visit whose listed rises all fall inside
`lib/match.ts`'s window. What kept it off the screens is that the suite's matched frames were the seeded
demo's mixed week (three placed of five), where the clause is correct. T213 committed the first all-matched
frames in the suite two commits before this ticket was filed on them.

Three unit tests had the clause baked into an all-matched expectation. T191's cross-product property was the
widest: it asserted the clause over all 255 of the 256 codes it reaches, 81 of which place every rise, so a
sentence about an empty set passed 81 times per run. It reads as an equivalence against `anyPlaceMissing`
now, which pins both directions — criterion 1 and criterion 3 — over every mix.

## §2.7 keeps its hedge, deliberately

`patientChartCaption` ends its matched branch with `, when available.` on the same unconditional footing, and
it stays. The two are not the same decision: the clinician's clause *offers a second reading* and an offer is
empty where no label is a number, while `, when available` is T204's hedge on whether the label for a
**placed** rise was *drawn*. `lib/markerLabels.ts` drops a label that would collide with a neighbouring label
or marker whatever matched, so a week with every rise placed still reaches §2.7's chart as a red dot with
nothing over it. The hedge is true at every mix including all-matched, and there is no second reading in it
to withdraw. The doc comment now says so, and a test pins the sentence identical at all-matched and at mixed.

## The four frames, both widths

| File | What to look at |
|---|---|
| `desktop-provider-sour-one-rise-placed.png`, `mobile-provider-sour-one-rise-placed.png` | §2.6's brief on the visit the ticket was filed on. The caption now ends **"give the place the patient had just left."** — no second reading — over the card headed "Spike linked to a place" whose one Place cell is a place. |
| `desktop-provider-print-one-rise-placed.png`, `mobile-provider-print-one-rise-placed.png` | §7.4's sheet, the copy carried into the room, with the identical sentence out of the one `clinicianChartCaption` the two surfaces share (T99). The spec compares it against the brief's string rather than re-deriving it. |

Compare `docs/screenshots/tickets/t213/desktop-provider-sour-one-rise-placed.png`, the same frame two
commits earlier, where the sentence carries the clause this ticket removed.

The mixed week's frames are unchanged and are not re-committed here: `e2e/flows.spec.ts` and
`e2e/print.spec.ts` read the seeded demo's caption, which still offers both readings, and
`docs/screenshots/tickets/t192/desktop-provider-print.png` is that sentence.

## Out of scope and unchanged

The `unmatched` and `no-timeline` branches (T184, T199, T200), `matchedPlaceClause`'s three relation clauses
(T191, T192), the counting T199, T200 and T213 added, the Place column's cells, the "Spikes > 180" tile and
its hint, and §2.7's caption beyond the line of doc comment recording why its hedge stays.
