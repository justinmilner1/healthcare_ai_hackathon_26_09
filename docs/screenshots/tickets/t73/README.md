# T73 — the caveat a phone never got

All three footers were a two-span flex row that hid `span:last-child` below 680px, and on all three the
second span is the clinical caveat. The patient's intake page is the one that mattered: §6.5 makes it mobile
first and §2.3 hands the patient their link by text, so the phone is the device this flow is lived on, and it
was the one width that never said **Not medical advice**.

Every shot below is from the `bash scripts/agent-check.sh` run this ticket landed on (190 passed, exit 0).
The mobile shots are a screenful each with the footer scrolled into it (T57), not a whole page.

| File | What to look at |
|---|---|
| `mobile-375-footer-intake.png` | The footer that mattered most, at 375px: the strapline on one line and **Not medical advice** centred on a second. It wraps now instead of disappearing. |
| `mobile-375-footer-landing.png` | The landing page at 375px. **Sweet Spot · Diabetes visit preparation** and **Not medical advice** both fit on one line at this width, centred. |
| `mobile-375-footer-provider.png` | The dashboard at 375px, with **Verify all AI-generated summaries** — the instruction §2.6 holds a clinician to — beside the workspace name. |
| `desktop-patient-intake-uploads.png` | The same intake page at 1280px, unchanged: both spans, pushed to the two edges by the base `space-between`. |
| `desktop-landing.png` | The landing page at 1280px, unchanged for the same reason. |
| `desktop-journey-11-clinician-dashboard.png` | The dashboard at 1280px, unchanged. |

The desktop three are here as the control: every rule this ticket changed lives inside
`@media (max-width: 680px)`, so a wide viewport should look exactly as it did before, and these show that it
does.

`e2e/mobile.spec.ts` now asserts the caveat on all three rather than leaving it to these PNGs — the bug
survived T23's mobile pass and T37's rewrite of that very span because nothing measured it.
