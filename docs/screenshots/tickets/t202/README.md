# T202 — the sustained-high safety flag reports its one run instead of electing it

The red block §2.6 puts at the top of the clinician's brief, and §7.4 reprints on the sheet, announced a
superlative over a set of one. On `data/fixtures/clarity_sustained_high.csv` — 36 readings with exactly one
run above 250 mg/dL, the fixture the suite already uploads — it read:

> Above 250 mg/dL for an hour or more on 1 occasion (**longest** 100 min from Sun, Sep 20, 7:35 PM, peak 291).

The count agreed; the parenthetical after it did not. `longest` is `runs.reduce(...)`, a superlative over
`runs`, and the sentence has just said `runs` holds one element — the parenthetical exists to pick the worst
out of several, and over one there is nothing to be longest among. It now reads **"on 1 occasion (100 min
from …, peak 291)."**; at two occasions and above it keeps the string it has always had, word for word, which
`lib/sour.test.ts` arranges a second run to read.

These are the **deterministic** flags: design §7 and `AGENTS.md` ("deterministic safety flags from
`lib/sour.ts`, never from the model") make them code-generated precisely so a clinician can trust them, and
§2.6 puts them at the top in red. So the one sentence in the product that must not overstate was overstating.

## The mechanism, which is the other half of it

Both deterministic flags wrote their count with a ternary beside the sentence — the construction T198 AC2,
T199 AC4 and T200 AC2 each refused, and the reason this defect reads the way it does: a hand-rolled
agreement covers the noun it is glued to and leaves the rest of the sentence nobody's decision, so the
superlative in the parenthetical was never anybody's. Both now agree through `plural`/`countOf` in
`lib/plural.ts`, the noun and the parenthetical together, and the sidebar sub-line on the same surface
(`app/provider/[id]/sour.tsx`) moves with them.

The low flag's `lowest` is correct at any count and is unchanged: it ranges over `lows`, the readings, while
the count in front of it is of distinct local dates — different sets, so one day does not imply one reading.

## The two clinician surfaces, both widths

| File | What to look at |
|---|---|
| `desktop-provider-sour-flags.png`, `mobile-provider-sour-flags.png` | §2.6's brief. The red block headed "Glucose safety flags (computed from the readings, not by the model)" holds one bullet, reading "…on 1 occasion (100 min from …, peak 291)." with no "longest" in it, under the intake flag and above the Summary card. |
| `desktop-provider-print-flags.png`, `mobile-provider-print-flags.png` | §7.4's sheet carrying the identical sentence. The spec compares the sheet's list with the brief's own strings rather than re-deriving them, so the two surfaces cannot say different things (T99). |

Both pairs come from `e2e/flags.spec.ts`, which is where the two flag blocks were already asserted against
each other; the shots are the ones that spec already takes, anchored as T107 and T109 left them.
