# T14 screenshots

From `bash scripts/agent-check.sh` on branch `t14-retention-and-deletion`. Every one of these was produced by
doing the thing rather than by posing for it: `e2e/deletion.spec.ts` books a visit as the signed-in admin,
verifies the patient's link with the six-digit code from their own inbox (T08), uploads a Dexcom export over
it, generates the summaries (T15), and then deletes the patient from the row on the dashboard.

The patient details are the suite's own and the ids are cuids from a throwaway database — which is the point
of the last assertions in that spec: the name, the phone number, the address, the invite token and the
filename appear in none of these tables and in none of the CSV the Export button hands over.

The nightly sweep (§10.4) has no screen. It is a job, and what it does to a visit is asserted visit by visit
in `lib/retentionStore.test.ts` against a real database.

| File | What it shows |
|---|---|
| `desktop-provider-delete-confirm.png` | §10.5's confirmation, with the wrong name typed in. The dialog says what goes — check-in answers, the chat, every uploaded file, the summaries written from them, the Dexcom connection, the patient's own contact details — and what stays, which is the record that it happened. `Delete permanently` is disabled until the typed name matches the row's, and the server decides by the same function (`lib/retention.ts` `confirmsDeletion`), so the two cannot drift apart. |
| `mobile-provider-delete-confirm.png` | The same at phone width: the dialog is 520px at most, so it fits the viewport with the backdrop's gutter and nothing scrolls sideways. |
| `desktop-provider-dashboard-after-deletion.png` | The dashboard with that patient's row gone. Their visit rows are deleted outright — there is no patient left for the appointment to belong to — so the only thing in the app that still refers to them is the audit row below. The remaining rows are the other specs' patients, since the run shares one practice. |
| `mobile-provider-dashboard-after-deletion.png` | The same at phone width. |
| `desktop-provider-audit-deletion.png` | The audit page filtered to `Patient data deleted` (§10.2). One row: the time, the staff member who asked for it — a person, not the job that carried it out — the patient id it was done to, and a detail that is all counts (`visits`, `uploads`, `turns`, `summaries`, `objects`, `dexcom`). How much went, never what it was (§4.8). |
| `mobile-provider-audit-deletion.png` | The same row stacked into labelled lines. |
