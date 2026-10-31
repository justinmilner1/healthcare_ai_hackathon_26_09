# T203 — the patient's rises card is headed in the number of rises it lists

§2.7's page has two elements that name the rises it is showing, one card apart and in one frame at either
width: the caption under the "Your glucose" heading and the heading over the table those markers are listed
in. T199 taught the caption to count and left the heading a literal in the JSX, so the week with exactly one
rise over 180 read:

> **Your glucose**
> Marker shows your biggest **rise**.
> … chart with one red marker at 214 …
>
> **Your biggest rises**
> A simple timeline to help you remember what was happening.
> | When | Rise |
> | Sat 8:00 AM | 96 → 214 |

The same one rise in the singular and in the plural, one card apart, about the same red dot.

## The mechanism, which is the other half of it

The heading is not a ternary in the JSX — the construction T198 AC2, T199 AC4, T200 AC2 and T202 AC2 each
refused, and the reason this defect exists at all: the card is a client component the unit suite cannot
render, which is what `lib/spikePlaces.ts` is for. `patientRiseNoun` there is now the three words both
sentences are made of ("biggest rise" / "biggest rises", `plural` from `lib/plural.ts`), with
`patientSpikeCardHeading` beside `patientChartCaption`, whose count it has to match. The page hands both of
them `bundle.spikes` — the array `SpikeTable` draws its rows from — so the two cannot disagree about the
count again, and `lib/spikePlaces.test.ts` reads that as a property across every count from one to twelve
rather than as a list of three.

There is no branch at nought, unlike the clinician's `clinicianSpikeCardHeading`: this card is rendered only
where there is a rise to list, and what §2.7 says about a week with none is the caption's own empty-week
sentence (T199).

Out of scope and unchanged: the clinician's "Spikes over 180" heading, which names a threshold rather than a
count; the subtitle under this heading, which says nothing about how many; and the "Spikes > 180" tile.

## The one-rise page, both widths

`data/fixtures/clarity_window.csv` is the committed week with exactly one rise over 180 (96 → 214), and
`e2e/flags.spec.ts`'s one-rise test already loaded it, already asserted the singular caption and the single
row, and already named this card in its own comment. The heading assertion goes in beside them, in the frame
that spec already shoots.

| File | What to look at |
|---|---|
| `desktop-patient-summary-one-rise.png` | Both cards in one frame. The caption reads "Marker shows your biggest rise." and the card under it is now headed **"Your biggest rise"** over its one row — the pair that disagreed. |
| `mobile-patient-summary-one-rise.png` | The same two elements at the 375px §6.5 asks for. |

The plural side — a week with more than one rise, where the heading keeps the words §2.7 has always shown —
is asserted on the multi-rise patient summary in `e2e/flows.spec.ts`, whose rise count is now read off the
bundle as more than one rather than merely some.
