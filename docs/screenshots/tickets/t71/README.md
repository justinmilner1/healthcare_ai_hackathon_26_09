# T71 — the Dexcom card's hint

From the `scripts/agent-check.sh` run on the tree this ticket landed, with no Dexcom credentials set: the
default offline mode, which is the state the bug is about.

| Screenshot | The hint under the Dexcom card | What it shows |
|---|---|---|
| `mobile-375-connect-sources.png` | "Upload your Clarity CSV export to share your last 7 days of glucose." | Nothing shared yet, at 375px. The sentence that replaced "Dexcom connection is not configured yet. CSV upload is still available outside demo mode." next to a working Upload CSV button. |
| `desktop-journey-08-intake-connections.png` | "Your Clarity CSV is in. Upload a newer export any time to replace it." | The journey's patient has just shared their Clarity export. The hint follows the **CONNECTED** pill and the "2016 RECORDS SECURELY ADDED" above it instead of contradicting them. |
| `mobile-journey-08-intake-connections.png` | the same sentence | The shared state at 375px: two lines, nothing clipped. |
| `desktop-patient-intake-uploads.png` | the same sentence | `e2e/uploads.spec.ts`, which now asserts both hints — the invitation before the upload and the acknowledgement after it. |

Not a regression here, and not this ticket: the **Connect Dexcom · Demo** button on the first shot is
disabled, because the demonstration needs the credentials this deployment does not have. The hint no longer
explains it, and nothing else does.
