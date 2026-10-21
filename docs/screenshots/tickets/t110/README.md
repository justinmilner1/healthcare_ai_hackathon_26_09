# T110 — an AWS credential is not an email backend

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are ambient and no email backend is configured. That is the
environment the bug was about: `emailProvider()` read the credential as "SES is configured", `viaSes` then
refused on the missing `EMAIL_FROM` under the name of a backend nothing had reached, and the invite job was
retried against it — 7 `job_retry` lines across 4 `notify.invite` jobs in the run the ticket was filed from.
This run has **zero**.

| File | What it shows |
|---|---|
| `desktop-journey-11-clinician-dashboard.png` | §12.2's journey visit, booked on the email channel, as the clinician first sees it. The MESSAGES cell is the one this ticket is about: `EMAIL –` (skipped, nothing to retry) and, under it, the staff line T74 owns — "Sweet Spot cannot send email yet — ask whoever set it up for your office". Before this ticket the same cell read `EMAIL ✕` and "The email did not go out", which was false: no client was ever built and nothing was reached. |
| `mobile-journey-11-clinician-dashboard.png` | The same cell at 375px (§6.5), where there is no hover and the line under the pill is the only thing staff get. The shot is anchored on the cell rather than the row for that reason: the table is wider than the screen, and a row anchored on itself leaves this column off the right-hand edge. |
| `desktop-provider-dashboard-deliveries.png` | `e2e/notifications.spec.ts`: §8.3's seeded rows, unchanged by this ticket. Dana Demo still reads `TEXT ✓` and `EMAIL ↩` with "Email bounced" and the date — a message that left and came back keeps its own wording, its own mark and its own message id. That is the half of the pair this ticket did **not** touch. |

The wording on these screens is `lib/delivery.ts`'s, not `lib/email.ts`'s: the sender's own
`email not configured: …` stays in the log and on the row for whoever runs the deployment, and the practice
is told something it can act on (T74). What T110 changed is which of that module's two sentences applies —
"cannot send email yet" rather than "the email did not go out" — because a backend is no longer chosen,
reached, or retried on the strength of a credential that says nothing about email.
