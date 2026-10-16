# T37 — the hackathon leftovers

T37 is a removal ticket, so most of its diff is invisible: rules no element wears, exports nothing
imports. What *is* visible is the framing. Three footers still told every reader the product was a
demo, and the landing page signed itself "Healthcare AI Hackathon" — the string T36 found and left
here on purpose. Every shot below is from the `bash scripts/agent-check.sh` run this pull request
reports (178 passed).

| File | What to look at |
|---|---|
| `desktop-landing.png` | The footer now reads **Sweet Spot · Diabetes visit preparation / Not medical advice**. The `.home-dev` developer-notes block whose stylesheet rules went with this change belonged to this page; there has been no such block in the JSX for a while, which is how its five rules came to be dead. |
| `mobile-landing.png` | The same page at 375px, where the 580px rule hides the footer's second span. That rule is older than this ticket and still hides exactly one span; what it hides is now the caveat rather than the demo claim, which is worth knowing but is not a change this ticket makes. |
| `desktop-provider-dashboard.png` | **Verify all AI-generated summaries**, with "Demo only ·" gone from in front of it. The caveat a clinician needs is the one that stayed. Also the proof that nothing in the table lost its styling: the stage pills and the delivery pills are composed at runtime (`provider-stage-${tone}`, `provider-delivery-${status}`), so they were checked by hand against the stylesheet rather than by a grep for a literal class name. |
| `desktop-provider-settings-demo.png` | Why the blanket footers could go at all. §13.4 makes demo-ness a flag on a practice, and this is where it is said: the `DEMO PRACTICE — SYNTHETIC DATA` pill and the note explaining what it changes — no retention sweep, no alarms, nothing sent to an address that is not a reserved one. A footer on every screen saying the whole product is a demo says less than this, and would be false the first time a real practice pilots (§1). |
| `desktop-patient-intake-uploads.png` | The patient's data panel, which is where the dead `.sandbox*` rules in `intake.module.css` used to draw a Dexcom sandbox card. The sandbox is a `DexcomDemoLink` in the panel now (§9.2) — "Connect Dexcom · Demo", top right of the Dexcom card — and the card those five rules styled has not existed for some time. The footer here keeps the sentence a patient should read and drops "Demo experience ·". (The `!TRY AGAIN` pill is open bug T49 and the Dexcom "not configured yet" line is T71; neither is a regression here.) |
| `mobile-patient-intake-uploads.png` | The same panel at 375px: the three source cards still carry their tone colours, which come from `styles[source.tone]` — `rose`, `charcoal` and `blue` read as unused by any literal search and are live. |
| `desktop-provider-signout.png` | The one check that needed a screenshot rather than a test. `.ss-button-sour` shared its declarations with `.sour-theme .ss-button-primary`; only the dead selector came off the two rules, so this button — the sour theme's primary — has to look exactly as it did. It does. |
