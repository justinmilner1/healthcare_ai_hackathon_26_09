# T57 — a phone shot is a phone screen

§12.3 takes these pictures so that the two routines can see what they built. On the mobile project
`fullPage: true` was quietly undoing that: the provider dashboard is as tall as the practice's visit
list, so by the time the phone ran it the shot was tens of thousands of pixels of three-pixel rows.
Every shot below is from the `bash scripts/agent-check.sh` run this pull request reports (178 passed,
6 skipped).

Heights are raw PNG pixels. The mobile project is a 375×667 viewport at a 2.625 device scale, so one
phone screen is 984×1751 of them. "Before" is the same check run on `main` (`e2e/` at `3ea879b`).

| File | Before | After | What to look at |
|---|---|---|---|
| `mobile-provider-dashboard-visit-statuses.png` | 30,537 | 1,751 | The ticket's worst case. `before-` is the same screen: 31 phone screens in one column, rows a few pixels tall. The shot now centres on the row the test booked and scrolls the table to the Messages column, so `Consent: Over the phone, Oct 17` — the string the test asserts — is in the picture. |
| `mobile-provider-add-visit-consent.png` | 29,689 | 1,751 | The clearest case in the issue: a shot of the add-visit dialog in which the dialog was about 3% of the image. `MODAL` now says what it is — a dialog is one viewport's worth of subject at either width — so step 3 of the wizard, the contact channel and the start of the consent question are what you see. |
| `mobile-provider-dashboard-reviewed.png` | 26,854 | 1,751 | §7.3's "shows in the dashboard". The shot is centred on `.provider-stage-cell` of the reviewed row: the green **Reviewed** pill and **by Dr. Demo Endo · Oct 17** underneath it, which is exactly what the test asserts and what no full-page shot of this screen has ever shown — the column is off to the right, not below. |
| `mobile-security-provider-dashboard.png` | 27,410 | 1,751 | The hydration walk. Its question is whether the client fetch filled the table in at all, and legible rows answer it. |
| `mobile-provider-dashboard.png` | 21,520 | 1,751 | The seeded dashboard, centred on Sam Sample's row. |
| `mobile-provider-dashboard-deliveries.png` | 24,575 | 1,751 | §8.3's delivery pills: `TEXT ✓`, `EMAIL ↩`, **Email bounced · Oct 15** and the consent line under them, on Dana Demo's row. |
| `desktop-provider-import-preview.png` | 5,726 | 720 | The desktop case the issue adds at the end, the same cause with the opposite symptom: a dialog over a very tall page, anchored at the top of the document, so the dialog's own header was cut off above the image and the first readable line was "sends them a code.", mid sentence. `before-` is that. **IMPORT A DAY / One CSV, a day of visits.** is now the top of the shot. |
| `desktop-provider-dashboard-reviewed.png` | — | 4,322 | The control: the same screen as the row above it, on the desktop project, which still shoots the whole document. No before/after to give — the desktop behaviour is unchanged, and this height is the practice's visit list on the run that wrote it, so it is a different number every run either way. That is the reason the phone could not keep shooting the page. |

## The one shot deliberately left tall

`mobile-375-patient-summary-full.png` is 6,158px and stays that way. `e2e/mobile.spec.ts` exists for
design §6.5 — the whole of a patient screen at 375px — and a patient's full week is that screen. It is
bounded by its own content rather than by the practice's visit list, so it does not grow; it is a
legible page you scroll, not a column of three-pixel rows. The comment in the spec says so. Every other
mobile shot in the suite is now under 4,000px: 1 of 89, down from 29 of 88.
