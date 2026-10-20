# T91 — the Dexcom card offers only what the patient can press

From `bash scripts/agent-check.sh` on the tree this ticket landed. The main server of the suite has no
Dexcom credentials, which is the default offline mode the README documents and the mode the bug is about;
`e2e/dexcom.spec.ts` drives a second server on port+3 with `DEXCOM_ENV=production` and credentials, so both
sides of §9.2's switch are photographed from one run.

| File | What it shows |
|---|---|
| `desktop-dexcom-unconfigured-connect.png` | No credentials: the Dexcom card offers **Upload CSV** and nothing else. The greyed **Connect Dexcom · Demo** of `t71/mobile-375-connect-sources.png` is not rendered, and the hint under the card is still T71's "Upload your Clarity CSV export to share your last 7 days of glucose." |
| `mobile-dexcom-unconfigured-connect.png` | The same at 375px (§6.5). |
| `mobile-375-connect-sources.png` | The shot the issue cites, retaken. `e2e/mobile.spec.ts`, the same unconfigured deployment: three cards, three upload controls, no dead button. |
| `desktop-dexcom-production-connect.png` | With credentials, §9.2's other side, unchanged: a live **Connect Dexcom** beside **Upload CSV**, and "Authorize on Dexcom and return here." |
| `mobile-dexcom-production-connect.png` | And at 375px, where the two controls sit side by side in the card. |
| `desktop-journey-08-intake-connections.png` | §12.2's journey, after the patient has shared two exports on the unconfigured deployment: **CONNECTED**, "Replace file" and "Remove". The dead button that used to sit beside a card with nothing left to connect is gone. |
| `mobile-journey-08-intake-connections.png` | The same hand-off at 375px. |
| `desktop-sweetie-start.png` | The other screen this touched: the Sweetie page's amber "Try Dexcom sandbox" card is no longer rendered without credentials, where `POST /api/dexcom/demo` answers 503. The page closes up behind it. |

The lede over the cards moved with the controls. It read "Connect Dexcom or upload a file" on every one of
these screens; it now says that only where a connect control is rendered (the two production shots) and
"Upload your Dexcom export" otherwise. Neither sentence says why, which is the T71 rule `lib/dexcomHint.ts`
and `lib/dexcomHint.test.ts` keep: "not configured", "demo mode" and "credential" stay out of what the
patient reads.
