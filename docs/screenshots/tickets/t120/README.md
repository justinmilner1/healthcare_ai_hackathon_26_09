# T120 — the Send link buttons say what this deployment can actually send

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0, 946 unit assertions and 246
Playwright tests passed, whole check 7m37s), in the cloud sandbox, where no email or SMS backend is
configured and the run's own config check says so: `No email or SMS backend is configured: invite links can
only be read off the screen (design §8.1)`. That is the environment the bug was about — and the one a fresh
`.env` is in.

| File | What it shows |
|---|---|
| `desktop-provider-row-invite-not-sent.png` | The dashboard row after **Send link**. The note under the buttons is the sentence this ticket is about: **"No invite sent: Sweet Spot cannot send this message yet — ask whoever set it up for your office. Use Copy intake to give them the link."** Before this ticket it read **"Sending now"**, while the MESSAGES cell on the same row — three columns to the left, in the same frame — already said Sweet Spot cannot send email yet (T110). One visit, two stories. §8.1's fallback is **Copy intake**, the first button on the row the note names. |
| `mobile-provider-row-invite-not-sent.png` | The same row at 375px (§6.5). The table is `min-width: 1120px` inside a horizontal scroller, so the frame is anchored on the note's own column; the note wraps to four lines and all of it is readable. |
| `desktop-sour-invite-not-sent.png` | The second surface, which is a different page and was making the same claim: **"No invite sent: Sweet Spot cannot send this message yet — ask whoever set it up for your office. Share the link directly: http://localhost:3100/s/…"**. It read "Sending the link to this patient now" before. This screen already shared the link, which is why it keeps it inline instead of pointing at a button. |
| `mobile-sour-invite-not-sent.png` | That screen at 375px. The sentence wraps to three lines and the whole token is on screen under it. |
| `desktop-provider-row-invite-sending.png` | The other half: a deployment that **can** send still reads **"Sending now"**. Nothing about that branch changed. What stands in for a configured deployment is `queued` on one invite's response (`e2e/invite.spec.ts`), because a server with a live sender would have every invite in this gate attempt a real SES or SNS call — the outbound calls T94 and T110 took out of it. The MESSAGES cell in this frame still says Sweet Spot cannot send email yet, and that is the stub talking rather than the bug: the cell beside it is reporting the environment the gate really runs in. No real deployment shows both. |
| `mobile-provider-row-invite-sending.png` | That same branch at 375px. |

The wording on both screens is `lib/delivery.ts`'s, the family T74 established and T110 and T111 last used:
the sender's own `email not configured: …` stays in the log for whoever runs the deployment, and the practice
is told something it can act on, naming no variable and no backend (§3.7, §10.6).

Two things the pictures do not show, both asserted in `e2e/invite.spec.ts` instead:

- A visit booked on **Do not message** reads differently — "no consent to message this patient", the sentence
  `POST /api/book` has said since T111 and which now lives beside the rest of the staff-readable refusals so
  that both routes quote one copy of it. A practice that chose to message nobody is not a deployment that
  cannot, and only one of those two is anybody's to fix.
- The `notify.invite` job is still enqueued in every one of these cases, so the visit's delivery rows are
  still written and §8.3's MESSAGES cell does not fall silent about a channel. What changed is only what
  staff are promised.

One thing deliberately left alone: `inviteSendability` answers whether there is a sender behind the channel
at all, and it is not a prediction that the message arrives. A suppressed address, a STOP, or a demo practice
closes a channel on facts that live on the row rather than in the environment, and those stay the delivery
row's to report (§8.3) — which is why the demo practice's own "only test addresses are messaged" is still in
the MESSAGES cell of these frames and not in the note.
