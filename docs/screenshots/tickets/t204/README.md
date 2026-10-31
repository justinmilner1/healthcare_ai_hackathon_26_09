# T204 — the patient's chart caption says which labels got drawn

§2.7's caption under "Your glucose" promised that the markers show the patient's biggest rises **and where
they were around then**, with nothing in it about a label that did not fit. `lib/markerLabels.ts` drops a
label that would collide with a neighbouring label or with any marker on the chart and keeps the bare dot
(T23, T197), so a rise that *was* matched to a place could reach that chart as a red dot with nothing over
it — and the patient had no way to read that as anything but a rise with no place:

> **Your glucose**
> Markers show your biggest rises and where you were around then, when available.
> … five red dots. Four labelled `206`, `202`, `a place you went`, `a place you went`.
> The fifth, at Sun 22:30, carries none …
>
> **Your biggest rises**
> | When | Rise | Where |
> | Sun 10:30 PM | 107 → 214 | **a place you went** |

The table one card below says that rise's place *is* known. Its label was dropped because
`a place you went` is sixteen characters and the `202` label sits 44px to its left. Nothing else on that page
could correct the sentence: `SpikeTable` is `compact` here and drops the relation suffix, so the caption was
the only element saying what a label is.

## Why `anyPlaceKnown` could not see it

That predicate — the one the Where column reads (T82) — answers whether a **place is known**, which is what
the sentence's `, when available` hedges. Whether the label for a known place was **drawn** is a second
question, and the one state this ticket is about is exactly the state the sentence had no words for. The
clinician's twin has hedged it since T99, in four words of its own (`Labels, where they fit,` in
`clinicianChartCaption`), and `lib/markerLabels.ts` opened by quoting those words as the promise all three
captions make. Two of the three made it.

## The wording, and where it is decided

`patientChartCaption` in `lib/spikePlaces.ts` — beside the clause T193 derives and the noun T203 counts, not
a ternary in the JSX (T198 AC2, T199 AC4, T200 AC2, T202 AC2, T203 AC2):

> Markers show your biggest rises. **The labels that fit** say where you were around then, when available.

§2.7's second person rather than the clinician's four words, and it counts the labels it is about the way the
sentence in front of it counts the markers — the half T200 had to come back for one caption down, where a
clause after the comma stayed plural over a single rise. At one rise: "The label that fits says …".

The clause is on the place branch alone. With no place known every label is a peak reading, which this
sentence deliberately says nothing about, so `Markers show your biggest rises.` is unchanged; and over no
rises at all there is no label to describe, so `NO_RISES_TO_MARK_PATIENT` is unchanged too. Out of scope and
untouched: the clinician's two surfaces, the dropping of labels itself (T23, T197 — `SpikeTable` carries
every rise, labelled or not, which is why the chart may drop one), `patientSpikeCardHeading` and the Where
column.

## The mixed-places week, both widths

`data/timeline_sample.json` over `data/dexcom_clarity_sample.csv` with no hand labels is the pairing where
every placed stop is the sixteen-character `a place you went`, and `e2e/flows.spec.ts`'s mixed-places test
already asserted — in `expectMarkerLabelsClearOfMarkers(..., { someDropped: true })` — that this page draws
fewer labels than markers at 375px. The caption assertion goes in beside that call, in the frame that spec
already shoots.

| File | What to look at |
|---|---|
| `desktop-patient-summary-places-caption.png` | The caption and the five dots in one frame. The sentence now reads "… **The labels that fit** say where you were around then, when available." over a chart where the `Sun 10:30 PM` dot carries no label. |
| `mobile-patient-summary-places-caption.png` | The same pair at the 375px of §6.5, where the narrower plot keeps fewer labels still — the frame the ticket was filed from. |
| `desktop-patient-summary-places.png` | The rises table under it, anchored on `.patient-spikes`: the `Sun 10:30 PM` row's Where cell reads `a place you went`, which is what makes the unlabelled dot a dropped label and not a missing place. |
