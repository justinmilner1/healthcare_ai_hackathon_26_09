# T128 — the patient's "Where" column, where the export named nothing

From the `scripts/agent-check.sh` run that passed on this tree (exit 0, whole check 7m59s, e2e 6m40s).

The `before-` frames are the newest committed shots of the same two screens from before this ticket:
`docs/screenshots/tickets/t100/` (2026-10-20) for the desktop table and the 375px page, and
`docs/screenshots/tickets/t82/` for the 375px framing of the card. The spikes and the samples behind them
are the same in both, so the only thing that moves is the cell and the marker label.

| File | What to look at |
|---|---|
| `before-desktop-patient-summary-places.png` | The bug. Three rows of **"37.790, -122.401"** and **"37.760, -122.415"** under "Where", beside two that read "not sure", and the same two strings drawn over the chart's markers. |
| `desktop-patient-summary-places.png` | The same rises now read **"a place you went"**, muted like "not sure" beside them, and the chart's two markers carry that string instead of the lat/long. The caption above is unchanged and still true: the markers do say where the patient had just been, as much as the export knows. The time in the first column — "Sun 10:30 PM" — is what anchors the memory, which is the whole argument for dropping the coordinates. |
| `before-mobile-375-patient-summary-full.png` | The shot the ticket was reported from (§6.5). Coordinates in the chart and in all three placed rows. |
| `mobile-375-patient-summary-full.png` | The same page after. "a place you went" is sixteen characters, the longest label `components/GlucoseChart.tsx` draws without trimming, so the phone's markers carry it whole and the column does not wrap. |
| `before-mobile-patient-summary-places.png` | The card alone at 375px, before. |
| `mobile-patient-summary-places.png` | And after, where the third column has least room. |
| `desktop-provider-print.png` | **The other side of the split, unchanged.** The printed sheet for a visit with the same three uploads: `37.790, -122.401` in its Where column and over its markers, "no matching visit" on the two unplaced rows. T62 is not reverted and the clinician's surfaces are not touched — the split is one `patient` flag through `lib/spikePlaces.ts`. |
