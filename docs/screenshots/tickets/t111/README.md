# T111 — the booking wizard says what this deployment can actually send

From `bash scripts/agent-check.sh` on the tree this ticket landed (`AGENT_CHECK_EXIT=0`, 216 passed, whole
check 6m34s), in the cloud sandbox, where no email or SMS backend is configured and the run's own config
check says so: `No email or SMS backend is configured, so invite links can only be read off the screen
(design §8)`. That is the environment the bug was about — and the one a fresh `.env` is in.

| File | What it shows |
|---|---|
| `desktop-journey-04-invite-sent.png` | §12.2's journey visit, booked on the email channel, at the wizard's third step. The lede is the sentence this ticket is about: **"Patient added. No invite sent: Sweet Spot cannot send email yet — ask whoever set it up for your office. Share the link below."** Before this ticket the same screen read "The invite is on its way by email." while, eight steps later in the same test, the dashboard cell for the same visit said email cannot be sent. §8.1's fallback is the PRIVATE SWEETIE LINK card directly under it, which was already there. |
| `mobile-journey-04-invite-sent.png` | The same screen at 375px (§6.5). The sentence wraps to three lines and the link card still holds the whole token. |
| `desktop-provider-add-visit-sent.png` | The other half: a deployment that **can** send still reads "Patient added. The invite is on its way by email." Nothing about this branch changed. What stands in for a configured deployment is `queued`/`channel` on one booking's response (`e2e/visits.spec.ts`), because a server with a live sender would have every booking in this gate attempt a real SES or SNS call — the outbound calls T94 and T110 took out of it. |
| `mobile-provider-add-visit-sent.png` | That same branch at 375px. |
| `desktop-provider-import-created.png` | §2.2's CSV import, after the commit. Under **"3 created."**: "No invites sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office. Copy each link from the dashboard instead." One line for the file and not one per row — one of the three rows asked for a text, the other two chose "Do not message" — because it is a fact about the deployment rather than about any row. |

The wording on both screens is `lib/delivery.ts`'s, the family T74 established and T110 last used: the
sender's own `email not configured: …` stays in the log for whoever runs the deployment, and the practice
is told something it can act on, naming no variable and no backend (§3.7, §10.6).

One thing deliberately left alone: the card's heading, "<name> is on the way". Its eyebrow is PATIENT ADDED
and it is about the patient keeping their appointment, not about the message — it reads the same in both
branches above, so it is not a claim that can go out of step with the send. The sentence under it is the one
that varies, and that is the one this ticket made true.
