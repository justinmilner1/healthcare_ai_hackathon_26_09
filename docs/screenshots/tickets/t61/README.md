# T61 — the filtered audit shot

`*-provider-audit-visit.png` is the shot the ticket is about: the trail filtered to one visit's id.

| | Before (issue #95) | After |
|---|---|---|
| `mobile-provider-audit-visit.png` | 1082 × 80,149 — the whole practice's trail, 100 unfiltered rows, with this visit's id in the filter box | 984 × 1,751 — one phone screen of `6 of 6 shown`, every row this visit's |
| `desktop-provider-audit-visit.png` | 1280 × 1,152 — correct, and the only reason the bug was invisible on this project | 1280 × 1,152 — the filter value and all six rows |
| `mobile-provider-audit-deletion.png` | 984 × 4,360 — the same full-page phone shot in `e2e/deletion.spec.ts`, over the §12.3 size gate | 984 × 1,751 — `2 of 2 shown`, both rows the deletion |

The phone shots bring the entries to the top of the viewport before shooting, because a filtered page is
still 2,800 CSS pixels once the six stacked filter fields above the rows are counted — four screens of
scrolling to reach the thing the shot is of.
