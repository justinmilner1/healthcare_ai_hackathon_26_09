# T200 — the unmatched caption counts the rises its own clause is about

T199 made the marker half of the clinician chart caption agree with the number of markers and left the half
after the colon a fixed plural. So a visit whose week holds **one** rise that matched no place read:

> Shaded band is 70–180 mg/dL. Red marker **is a spike**. Labels, where they fit, give the peak mg/dL: no
> place matched any of **these rises**.

— the same one rise in both numbers, eleven words apart, in one sentence pair. It now reads **"no place
matched this rise."**; at two rises and above the clause is the string T184 and T191 pinned, word for word.

## Getting the branch on screen

`clinicianPlaceReport` returns `unmatched` only where a Timeline **was** shared and nothing in it matched, so
the reading needs a pairing `data/fixtures/` did not hold: `clarity_window.csv`'s single rise (96 → 214,
07:00 to 08:00) with the new `timeline_no_match.json`, whose three stops each fall outside `lib/match.ts`'s
window — a gym ending an hour before the climb, and the office and the pizzeria both starting after the peak.
That is why T199's own screenshots could not show the defect: its one-rise brief shares no Timeline and so
takes the `no-timeline` branch, whose string carries no such clause at all.

## The two clinician surfaces, both widths

| File | What to look at |
|---|---|
| `desktop-provider-sour-one-rise-unplaced.png`, `mobile-provider-sour-one-rise-unplaced.png` | §2.6's brief. The caption under "Glucose, last 1 day" ends **"no place matched this rise."** over a chart drawing **one** marker (labelled `214`), above a card headed "Spikes over 180" with one row — `Sat 8:00 AM · 96 → 214 · no matching visit`. The Place column is there, which is what says a lookup was run and found nothing (T82, T184). |
| `desktop-provider-print-one-rise-unplaced.png`, `mobile-provider-print-one-rise-unplaced.png` | §7.4's sheet carrying the identical sentence, out of the one `clinicianChartCaption` the two surfaces share (T99). The spec compares it with the brief's own string rather than re-deriving it. |

The phone shots are anchored with `scrollTo` rather than taken whole, which is T109's rule for the printed
sheet and what `SCREENFUL` gives the brief: the subject is the sentence, and both frames hold it with the
chart and the rises card under it.
