# T35 — the runbook's remaining procedures

T35 changes no screen: the deliverable is `docs/RUNBOOK.md`, with the alarm table moved out of
`docs/DEPLOY.md` and two rows corrected in `docs/COMPLIANCE.md`. So these are not shots of something new.
Each one is a screen a procedure in that page tells an operator to go and look at, read back from the
`bash scripts/agent-check.sh` run this pull request reports — evidence that the instruction lands somewhere
real rather than somewhere the design imagined.

| File | The procedure it belongs to |
|---|---|
| `desktop-provider-dashboard-deliveries.png` | **Handle a bounce or a complaint**, step 2: "tell the practice, so a person fixes the address". The Messages column is where a suppressed patient is visible, and `Email bounced · Oct 14` on the Dana Demo row is what the webhook wrote after SES came back. Nobody is emailed about this; somebody has to be looking at this column. |
| `desktop-provider-delete-confirm.png` | **Handle a deletion request** — the staff action itself (§10.5), and the reason the runbook says the app *is* the procedure. Everything the purge removes is named before it happens, and the patient's name typed out is the confirmation, because the mistake worth guarding against is deleting the row above the one you meant. The button stays inert while the typed name is wrong, which is what this shot catches. |
| `desktop-provider-dashboard-after-deletion.png` | The same dashboard afterwards: 13 visits where there were 14, and the row is no longer offered. This is step 1 of the sequence in the runbook — `deletedAt` set immediately, before the job that does the rest. |
| `desktop-provider-audit-deletion.png` | **Handle a deletion request**, "confirm it finished": `/provider/audit` filtered to `Patient data deleted`. One row, who asked, and the counts the runbook says to read — `visits: 1`, `uploads: 1`, `summaries: 2`, `objects: 1` and, the one to read twice, `orphans: 0`. A missing row here is the `job-failed` path instead. |
| `desktop-health-degraded.png` | **What each alarm means** — the first command three of the six alarms start with. `GET /api/health` separates the dependencies in one call: `db: ok`, `storage: ok`, `model: down / circuit_open`, which is exactly the shape of a `model-degraded` page or a revoked `OPENAI_API_KEY`. (`"detail":"local"` on storage is this sandbox having no bucket, not a deployment.) |
| `desktop-sweetie-degraded.png` | The claim the `model-failures` and `model-degraded` sections make about urgency: patients are not stuck. The gateway is unreachable, the banner says the assistant is unavailable, and the scripted questions keep coming (§6.3, §11.3) — so these two alarms are a call to look, not a call to wake anybody. |

The "button on the left" wording in the last one is open bug T53, not a regression here.
