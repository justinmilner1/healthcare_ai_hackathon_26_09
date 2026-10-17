# T54 — the seeded demo visit records all four §2.2 fields

`scripts/seed.ts` set the contact channel and the recorded consent but not `visitType` or `reason`, so the
one visit a human demo and the staging practice (§13.1, §13.2) are shown first was the only visit in the
workspace demonstrating `visitLabel`'s fallback instead of design §2.2. These shots are from the
`bash scripts/agent-check.sh` run this pull request reports.

| File | What it shows |
|---|---|
| `desktop-provider-dashboard.png` | §2.2 on the dashboard. Sam Sample's row, at the foot of the table, reads `Follow-up · my numbers keep going high…` where it read the bare `Visit` fallback before. The `Demo Real Number` and `Demo Reserved Number` rows above it still read `Visit`: those are booked by `e2e/demo.spec.ts` with no type, and are the fallback doing its job — which the ticket asks be left alone. |
| `desktop-provider-sour.png` | The same two fields reaching Sour. The brief header reads `Follow-up · Monday, Oct 19 · 7 days · 2,016 readings · Dexcom · Timeline · WHOOP`, with `Called about: my numbers keep going high overnight and I don't know why` beneath it. (The "set OPENAI_API_KEY" line in Patterns is open bug T63, not this change: the check script runs with no model key by design.) |
| `mobile-provider-sour.png` | §6.5, the same header at 375px. The meta line wraps onto two lines and the `Called about:` line onto two, with nothing overflowing or truncated. |

The mobile dashboard is deliberately not here: that PNG is the ~21,800px-tall artifact open bug T57 is
about, and shows nothing legible. The desktop shot carries the same assertion.

`e2e/flows.spec.ts` now asserts the seeded row and the brief header the way it already asserted the booked
row beside them, so the demo data cannot drift back to the fallback unnoticed.
