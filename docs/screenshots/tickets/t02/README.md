# T02: visit-centric data model

From `bash scripts/agent-check.sh` on branch `t02-visit-data-model` (6 Playwright tests, desktop and mobile;
the desktop set is here). The ticket moves the data under every screen onto the Visit, so the screens are
expected to look exactly as they did in `docs/screenshots/tickets/t13/` — that is what these show.

| Screen | What it confirms is still coming out of the database |
|---|---|
| `desktop-provider-dashboard.png` | The practice name and the provider's name now come from `Practice` and `User`; the row is a `Visit`, with its appointment, its uploads and its intake progress |
| `desktop-provider-sour.png` | The Sour workspace for a freshly seeded practice: no summaries generated yet, same as before |
| `desktop-sweetie-start.png` | The greeting is built from the visit: the provider's name, the visit type, and the reason given at booking |
| `desktop-sweetie-done.png` | Two answers stored as `Message` rows keyed by visit, with intake progress read back from `Visit.intake` |
| `desktop-patient-summary.png` | The patient's own page, loaded by the visit token |
| `desktop-landing.png` | Unchanged |
