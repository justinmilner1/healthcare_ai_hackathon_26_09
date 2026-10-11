# T03: routes and pages on the Visit model

From `bash scripts/agent-check.sh` on branch `t03-visit-refactor` (10 Playwright tests, desktop and mobile).
The ticket changes which id every request carries, not what the screens say, so they should look like
`docs/screenshots/tickets/t02/` — with two deliberate differences, marked below.

| Screen | What it confirms |
|---|---|
| `desktop-provider-dashboard.png` | Rows are visits: the dashboard reads `visits` from `GET /api/provider?id=`, and the counts, which have always counted visits, now say "visits" |
| `desktop-provider-sour.png` | **New:** the one-pager itself, reached by the `?visit=<id>` deep link from the summary email and generated through `POST /api/sour { visitId }`. The earlier tickets' screenshot was the page shell, taken before the first fetch returned |
| `mobile-provider-sour.png` | The same one-pager at phone width. The stat tiles used to be squeezed into the strip beside "Time in range" and clipped; the row now wraps |
| `mobile-provider-dashboard.png` | The visit rows and the renamed counts on a phone |
| `desktop-sweetie-start.png` | Unchanged: the greeting still comes from the visit behind the token |
| `desktop-sweetie-done.png` | Unchanged: messages and intake still stored against the visit |
| `desktop-patient-summary.png` | `/patient/<token>` still resolves to the visit and renders its week |
