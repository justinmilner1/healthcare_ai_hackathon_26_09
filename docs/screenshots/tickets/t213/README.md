# T213 — the clinician's spike card is headed in the number of rows it lists

The brief (§2.6) and the printed one-pager (§7.4) have two elements that name the rises they are showing,
one card apart and in one frame at either width: the caption under the glucose chart and the heading over
the table those markers are listed in. T199 and T200 taught the caption to count; `clinicianSpikeCardHeading`
branched at nought and at some, but not at one. So the visit whose week holds exactly one rise read:

> Shaded band is 70–180 mg/dL. Red marker **is a spike**. Labels, where they fit, give the peak mg/dL: no
> place matched **this rise**.
>
> **Spikes over 180**
> | When | Rise | Place |
> | Sat 8:00 AM | 96 → 214 | no matching visit |

— one rise in the singular and in the plural, one card apart, about the same red dot. And where that one
rise *did* match a stop, the heading was **"Spikes linked to places"**: two plural nouns over one row naming
one place.

It now reads **"Spike over 180"** and **"Spike linked to a place"**. At two rises and above both headings are
the strings T157 and T184 pinned, word for word; the nought reading stays the bare **"Spikes"** T157 chose,
which is what `plural` returns there anyway rather than a literal of its own.

## The mechanism

Both nouns go through `plural` in `lib/plural.ts`, as every other counted noun in the product does (T198) —
the spike noun *and* the place noun, because one rise is linked to one place and "Spike linked to places"
would be the bug half-fixed:

```ts
const n = spikes.length;
const spikeNoun = plural(n, "Spike");
if (clinicianPlaceReport(spikes, status) === "matched") return `${spikeNoun} linked to ${plural(n, "a place", "places")}`;
return n === 0 ? spikeNoun : `${spikeNoun} over 180`;
```

Not a ternary at the call site: both surfaces hand `clinicianSpikeCardHeading` and `clinicianChartCaption`
the same `bundle.spikes` — the array `SpikeTable` draws its rows from (`app/provider/[id]/sour.tsx:592`,
`app/provider/visit/[id]/print/page.tsx:279`) — so there is no count for the two of them to disagree about,
and `lib/spikePlaces.test.ts` reads the agreement as a property over every count from one to twelve rather
than as a list of strings. This is T203 on the patient's page, read in the clinician's register; the function
`patientSpikeCardHeading`'s own note pointed at as the one that branches at nought, without noticing it did
not branch at one.

Three of the file's cross-product properties spelled the matched reading out as `/linked to places/`, so each
of them pinned the plural over one matched rise as a side effect of asserting something else — which is how
this bug survived them. They now read a `LINKED` regex that spans both numbers, and the counting is asserted
by name instead.

## The four frames, both widths

| File | What to look at |
|---|---|
| `desktop-provider-sour-one-rise-unplaced.png`, `mobile-provider-sour-one-rise-unplaced.png` | §2.6's brief on the visit the ticket was filed on. The caption ends "no place matched **this rise**" and the card directly under it is now headed **"Spike over 180"** over its one row — `Sat 8:00 AM · 96 → 214 · no matching visit`. The two lines the ticket quoted side by side, now in one number. |
| `desktop-provider-print-one-rise-unplaced.png`, `mobile-provider-print-one-rise-unplaced.png` | §7.4's sheet — the copy carried into the room — with the identical heading, out of the one function the two surfaces share (T99, T157). |
| `desktop-provider-sour-one-rise-placed.png`, `mobile-provider-sour-one-rise-placed.png` | The matched reading, which no screen in the suite held: **"Spike linked to a place"** over one row and one place. The caption above it names the relation the one label has — "the place the patient had just left" (T191) — and the Place cell reads `37.777, -122.423 · left 10 min before`: the cafe's place id is not in `data/visits.csv`, so the stop is called by its own coordinates to three decimals, which is T62's rule and not a defect of this frame. The `1 · 1 linked to a place` tile is one card above the frame and is asserted in the spec rather than shown here. |
| `desktop-provider-print-one-rise-placed.png`, `mobile-provider-print-one-rise-placed.png` | The same matched heading on the sheet. |

## Getting the matched reading on screen

`clinicianPlaceReport` reads `matched` only where some listed rise carries a stop, and every screen in the
suite that showed that heading showed it over the seeded week's three matched rises — where the plural is
right. So the suite had the one-row reading *pinned* and not *covered*. The new pairing is
`data/fixtures/clarity_window.csv`'s single rise (96 → 214, climb from 07:00) with
`data/fixtures/timeline_android.json`, whose cafe ends at 06:50 — ten minutes inside `lib/match.ts`'s
30-minute window — so the file's one rise carries one place. Both files go in through `POST /api/upload` as a
patient's own exports do; the parsed pair is read in `lib/spikePlaces.test.ts` as well.

The phone shots are anchored with `scrollTo` rather than taken whole, which is T109's rule for the printed
sheet and what `SCREENFUL` gives the brief: the subject is the heading and the caption one card above it, and
every frame holds both.

## Out of scope and unchanged

§2.7's patient page, whose heading has counted since T203; the "Spikes > 180" stat tile and its hint, which
count already (T160, T164); the Place column's cells; and the chart caption itself, whose singular readings
T199, T200 and T191 settled and which this ticket only has to agree with.
