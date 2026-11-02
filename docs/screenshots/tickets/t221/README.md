# T221 — the clinician's spike card claimed a link its own rows denied

The heading over the spike card on §2.6's brief and §7.4's sheet counted **both** of its nouns off
`spikes.length` — every row in the card — while the thing the place noun counts is the number of places the
card shows. Two things followed, and a card where only some rises matched showed both:

> **Spikes linked to places**
> | When | Rise | Place |
> | Sat 8:00 AM | 100 → 214 | 37.777, -122.423 · left 15 min before |
> | Sat 7:00 PM | 100 → 196 | no matching visit |
> | Sat 10:30 PM | 102 → 188 | no matching visit |

— "places" over **one** place, and "linked" asserted over two rows saying they are not. This is the same
root as T157, T198, T203 and T213 at the one count none of them had reason to look at: T157 fixed the
heading over a card where **nothing** matched and T213 taught it to count at one, but the in-between case —
**some** matched — had never been argued, and `lib/spikePlaces.test.ts:230` pinned the wrong string rather
than endorsing it.

It now reads **"Spikes over 180"**. The place noun is kept for a card every row of which is placed, and
there it counts the places: two rows both at one `Office` are **"Spikes linked to a place"**.

## The mechanism

```ts
const n = spikes.length;
const spikeNoun = plural(n, "Spike");
// The place half is asserted of every row under it, so it is offered only where every row carries a
// place — and counted off the places rather than the rows, which are different numbers (T221).
if (clinicianPlaceReport(spikes, status) === "matched" && !anyPlaceMissing(spikes)) {
  return `${spikeNoun} linked to ${plural(distinctPlaceCount(spikes), "a place", "places")}`;
}
return n === 0 ? spikeNoun : `${spikeNoun} over 180`;
```

Four readings now, not three — the table in the function's own note is the list.

| the card | heading at one row | at two or more |
|---|---|---|
| every listed rise matched a place | `Spike linked to a place` | `Spikes linked to a place`, or `… to places` by how many places |
| some matched, the rest reading `no matching visit` | — | `Spikes over 180` |
| rises, no place to report against them | `Spike over 180` | `Spikes over 180` |
| no rises at all | — | `Spikes` |

## Why the mixed card gets the neutral subject

The ticket offered three readings and asked for the choice to be argued. The other two each break
something. A heading **counting only the matched rises** would print `Spike linked to a place` over a card
of two rows — the drift T213 closed, reintroduced. A heading **naming the mix** would restate in a vague
"some" what the two elements beside it already say exactly: the stat tile hint counts them
(`clinicianSpikePlacesHint`, "3 linked to a place") and the caption carries the mix itself ("or the peak
mg/dL where no place matched", T214). The row says a thing once — the T170 split — so the heading falls
silent rather than becoming the third element about it. `desktop-provider-print.png` below is the whole
argument in one picture: heading, tile and caption together, with only the heading gone quiet.

It also leaves the pair T157 set up stronger than it found it. The heading names places exactly where the
caption beside it **ends at its place clause** instead of offering the peak reading as well — one pair of
predicates behind both elements, where the heading read the report alone before. `lib/spikePlaces.test.ts`
asserts that as an equivalence in both directions rather than as a list of strings, through a `namesPlaces`
helper the three cross-products share.

## The eight frames, both widths

| File | What to look at |
|---|---|
| `desktop-provider-sour-one-placed-of-three.png`, `mobile-…` | The sharp case on §2.6's brief, from this ticket's fixture: **"Spikes over 180"** over three rows, one placed and two reading `no matching visit`. The caption one card above is exact about that mix, and the chart labels show it — one place label, two peak numbers (196, 188). |
| `desktop-provider-print-one-placed-of-three.png`, `mobile-…` | The same card on §7.4's sheet, out of the one function the two surfaces share (T99, T157). `compact` drops the relation suffix, which is SpikeTable's and not this ticket's. |
| `desktop-provider-sour-chart-caption-placed.png`, `mobile-…` | The mild case — the seeded demo week, which is the frame the bug was filed from. Three of five rises placed at two distinct places (`Office`, `Office`, `Home`) and two reading `no matching visit`. It read "Spikes linked to places"; "places" was at least true of what was shown, and the link was still asserted of all five rows. |
| `desktop-provider-print.png`, `mobile-…` | The whole sheet for that same week, which is where the design decision is legible: the **`top 5 shown · 3 linked to a place`** tile, the caption carrying "or the peak mg/dL where no place matched", and the heading now silent between them. Nothing a clinician could read off the old heading has been lost from the page. |

The places read as coordinates to three decimals on the sharp-case frames and on the sheet because those
visits have no hand-labelled `visits.csv` beside their Timeline, which is T62's rule and not a defect of
these frames.

## Getting the sharp case on screen

No committed pairing produced one placed rise among several: `clarity_window.csv` holds exactly one rise, so
with a Timeline it is wholly placed or wholly unplaced, and the seeded week is the mild mix. §12.1 asks for
a fixture, so `data/fixtures/clarity_three_rises.csv` is this ticket's — three rises over 180 on
2026-09-19, spaced so that `timeline_android.json`'s cafe (ending 06:50, fifteen minutes before the first
onset) is the only stop inside `lib/match.ts`'s 30-minute window, the office and the pizzeria being more
than thirty minutes from the other two onsets and overlapping neither. The three are spaced past
`detectSpikes`'s one-hour merge, so they stay three. Both files go in through `POST /api/upload` as a
patient's own exports do; the parsed pair is read in `lib/spikePlaces.test.ts` too.

## Out of scope and unchanged

`lib/match.ts` and `spikeVisitRelation` — which rises match, and the `after`/`during`/`arrived` words beside
them, were right and are untouched. §2.7's patient card: `patientSpikeCardHeading` has no place noun ("Your
biggest rises", T203) and `patientChartCaption` hedges a mix with "when available", so it has none of this
fault; a test asserts that rather than leaving it to prose (criterion 5). The `Spikes > 180` tile and its
hint, the Place column's cells, and the chart caption itself are all unchanged — this ticket only had to
stop disagreeing with them.
