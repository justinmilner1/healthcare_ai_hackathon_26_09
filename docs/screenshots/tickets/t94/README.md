# T94 — an AWS credential is not an SMS backend

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are ambient and no SMS backend is configured. That is the
environment the bug was about: `smsProvider()` read the credential as "SNS is configured" and the gate
published every invite to AWS.

| File | What it shows |
|---|---|
| `desktop-provider-dashboard-demo-messages.png` | `e2e/demo.spec.ts`'s two booked visits, both `channel: "sms"`. The **Demo Reserved Number** row is the one this ticket is about: `TEXT –` (skipped, nothing to retry) and, under it, the staff line T74 owns — "Sweet Spot cannot send texts yet — ask whoever set it up for your office". Before this ticket that row read "The text did not go out" against a red `TEXT ✕`, because SNS had been reached and had answered `The security token included in the request is invalid`. |
| `mobile-provider-dashboard-demo-messages.png` | The same at 375px (§6.5), where there is no hover and the line under the pill is the only thing staff get. |
| `desktop-provider-dashboard-deliveries.png` | `e2e/notifications.spec.ts`: §8.3's seeded rows, unchanged by this ticket. Dana Demo still reads `TEXT ✓` and `EMAIL ↩` with "Email bounced · Oct 18" — a message that left and came back keeps its own wording and its own mark. |

The wording on these screens is `lib/delivery.ts`'s, not `lib/sms.ts`'s: the sender's own `SMS not configured:
…` stays in the log and on the row for whoever runs the deployment, and the practice is told something it can
act on (T74). What T94 changed is which of that module's two sentences applies — "cannot send texts yet"
rather than "the text did not go out" — because a backend is no longer chosen, reached, or retried on the
strength of a credential that says nothing about SMS.
