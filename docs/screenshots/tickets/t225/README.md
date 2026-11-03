# T225 — "Summaries ready" read "ready to review" over a count of 0, in the only accented card

The practice overview's third tile printed its detail from an inline ternary in
`app/provider/dashboard.tsx`:

```tsx
detail={reviewed ? `${reviewed} reviewed` : "ready to review"}
```

`reviewed` is `0` on any practice where no clinician has signed a summary off, which includes every
practice where no `sour.run` has ever finished — so the ternary fell to its second branch and the card read

```
SUMMARIES READY
0
ready to review
```

§2.6 is the section that sends a clinician to the brief when a summary is ready. At zero there is no brief
to send them to, so this is not a wording slip: it is the dashboard telling a clinician to go and read
something that does not exist.

Two things made it worse than the wrong words.

**The accent was ungated.** `accent` was a bare prop where the sibling tile's is `danger={flagged > 0}`, so
on a dashboard with nothing in it the one card picked out in yellow — the only thing on the screen drawing
the eye — was the one making the false claim. `Metric` applies it as `provider-metric-accent`.

**The module that owns this rule recorded the tile as safe.** `lib/dashboardTiles.ts`'s header enumerated
three detail lines that "read correctly at every `n`" and named `${reviewed} reviewed` among them. That is
true of the branch it names and says nothing about the branch beside it in the same ternary, so a reader of
the module — including the ticket that would have fixed this — was told there was nothing here to fix. T198
had derived the "Needs attention" line into that module for exactly this class of bug and left this tile
inline.

## What changed

`summariesReadyDetail(ready, reviewed)` joins `needsAttentionDetail` in `lib/dashboardTiles.ts`. Three
branches, in the order the number above them decides:

| `ready` | `reviewed` | the line | why |
|---|---|---|---|
| 0 | 0 | `nothing summarized yet` | The register of the sibling's "nothing flagged": no claim, and no noun, because zero is not a count of anything. "yet" is the one word this zero state has that the sibling's does not — a flag is not expected to arrive and a summary is, which is what the hero one card up already promises ("Sour will light up when a summary is ready"). |
| 1 | 0 | `summary to review` | §2.6's reading, agreeing with the `1` drawn above it. |
| 2+ | 0 | `summaries to review` | Through `plural` in `lib/plural.ts`, which carries the irregular form — "summarys" is what a hand-spelled ternary prints. |
| any | 1+ | `${reviewed} reviewed` | §7.3's reading, untouched. A participle naming its own number, so it needs no noun inflected and reads the same at one as at ten. |

Zero is tested first and wins outright. `reviewed` cannot exceed `ready` in the data — a review hangs off a
summary — but the branch order is what makes that a property of the function rather than a thing to trust:
a line reading "2 reviewed" under a printed `0` would be exactly the disagreement T169 and T198 are about,
and `lib/dashboardTiles.test.ts` asserts it cannot happen.

`accent={ready > 0}` in the component, matching the sibling's `danger={flagged > 0}`.

The module header now enumerates the **two** lines that really are safe at every `n` — "in this workspace"
and "sharing data or chatting" — and describes this tile as the second of the two with a counted branch.

## The frames

Both at 1280px and 375px (§6.5, §12.3), on the brand-new practice of `e2e/roles.spec.ts`: an admin who has
just signed in, nothing booked, nothing summarized. That is the state the ticket reproduces and the state
both of the PNGs it was filed from were taken in.

| | |
|---|---|
| `desktop-provider-dashboard-summaries-zero.png` | The "Practice overview" row on a desk. All four tiles read `0`, and none of them is accented or in danger colours: `in this workspace`, `sharing data or chatting`, **`nothing summarized yet`**, `nothing flagged`. The two zero states sit beside each other, which is the contrast the bug report was read off — "Needs attention" had been getting this right since T198 and its neighbour had not. |
| `mobile-provider-dashboard-summaries-zero.png` | The same row at 375px, where the tiles stack and the line has the full width of the card. |
| `desktop-provider-dashboard-nothing-ready.png` | The whole empty dashboard on a desk — the frame the ticket cited as evidence, now with the corrected tile in it. The hero's "Sour will light up when a summary is ready." and the tile under it no longer contradict each other about whether anything is ready. |
| `mobile-provider-dashboard-nothing-ready.png` | Its phone half: one screenful from the top, so this is the hero rather than the tiles. |
| `desktop-provider-dashboard-needs-attention.png` | The same row on the seeded demo practice, where the branch this ticket had to leave alone is on screen: **`SUMMARIES READY / 25 / 1 reviewed`**, §7.3's wording unchanged — and the card *is* accented, because `ready` is 25. That is the other half of criterion 5: gating the accent on the count had to leave it on where the count is real. "Needs attention" beside it reads `5 / safety flags to review` in its danger colours, T198's branch, also unchanged. T198's own frame, reused here as this ticket's regression evidence. |
| `mobile-provider-dashboard-needs-attention.png` | Its phone half, the same two readings stacked. |

## What the suite can see now

`lib/dashboardTiles.test.ts` holds all three branches, zero included, as it already did for
`needsAttentionDetail` — plus the two assertions that are about the pair rather than either function:
neither tile's zero line contains a digit, and `ready === 0` beats a `reviewed` count that could not be
there.

`e2e/roles.spec.ts` reads the rendered tile on the brand-new practice: the `0`, the line under it, the
absence of `provider-metric-accent`, and the sibling at its own zero in the same frame. That is the half no
assertion could reach before — the tile's `small` is a text node nothing in the suite read, which is why a
false claim survived in a screenshot both routines open every run.

## Out of scope and unchanged

§7.3's `${reviewed} reviewed` wording, which was always right and criterion 4 asks for verbatim. The
`.sour-sidebar-label` on the summaries page, which is a different component on a different surface and says
"Summaries ready" about a list it actually has (`e2e/flows.spec.ts`). The other three tiles' detail lines.
