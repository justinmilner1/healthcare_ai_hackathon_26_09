# T82 — the patient's "Where" column

From the `scripts/agent-check.sh` run that passed on this tree (whole check 6m30s, 196 e2e tests).

| File | What to look at |
|---|---|
| `desktop-patient-summary-no-places.png` | A patient who shared Dexcom and no Timeline. "Your biggest rises" is **When and Rise**; there is no third column. The caption over the chart reads "Markers show your biggest rises." and stops there. |
| `mobile-patient-summary-no-places.png` | The same screen at 375px (§6.5), framed on the card. Two columns, no horizontal scroll. |
| `desktop-patient-summary-places.png` | A patient who did share a Timeline. The column is drawn, three rows carry a place and the two the matcher could not place read **"not sure"** in muted text — not "no matching visit". The caption promises places again. |
| `mobile-patient-summary-places.png` | The mixed table at 375px, where a third column has least room. |
| `desktop-journey-10-patient-summary.png` | §12.2's patient, who declines the Timeline — the screen the ticket was reported from. Five rows of "no matching visit" before, When and Rise now. |
| `desktop-journey-12-sour-brief.png` | The clinician's brief for **that same week**, unchanged: "Place / no matching visit" on all five rows. The two pages read the same spikes and are deliberately not written alike. |
