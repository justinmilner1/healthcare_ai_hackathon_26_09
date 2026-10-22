# T122 — the booking wizard's heading says what happened, not what T111 ruled out

From `bash scripts/agent-check.sh` on the tree this ticket landed (`AGENT_CHECK_EXIT=0`, 963 unit tests, 250
Playwright tests, whole check 7m54s), in the cloud sandbox, where no email or SMS backend is configured and
the run's own config check says so: `No email or SMS backend is configured: invite links can only be read off
the screen (design §8.1)`. That is the environment the bug was about — and the one a fresh `.env` is in.

| File | What it shows |
|---|---|
| `desktop-journey-04-invite-sent.png` | §12.2's journey visit, booked on the email channel, at the wizard's third step. The heading is this ticket: **"Journey Patient mvk04p6o is ready for Sweetie."** over "Patient added. No invite sent: Sweet Spot cannot send email yet — ask whoever set it up for your office. Share the link below." Before this ticket that heading read "<name> is on the way." — a promise of motion in the largest type on the card, over a sentence retracting it. §8.1's fallback, the PRIVATE SWEETIE LINK card, is what "ready for Sweetie" is about: the link is there to be handed over. |
| `mobile-journey-04-invite-sent.png` | The same card at 375px (§6.5). The longer heading wraps to three lines and the link card still holds the whole token above the fold. |
| `desktop-provider-add-visit-unsent.png` | The same branch on the wizard's default channel — booked on text **and** email, with a backend behind neither — so the sentence names no channel: "Sweet Spot cannot send this message yet". New frame (`e2e/visits.spec.ts`), because the heading is now part of what that test reads back. |
| `mobile-provider-add-visit-unsent.png` | That card at 375px. |
| `desktop-provider-add-visit-sent.png` | The other half, unchanged by this ticket: a deployment that **can** send still reads **"Configured Patient mvk068filzo is on the way."** over "Patient added. The invite is on its way by email." What stands in for a configured deployment is `queued`/`channel` on one booking's response (T111's stub), because a server with a live sender would have every booking in this gate attempt a real SES or SNS call. |
| `mobile-provider-add-visit-sent.png` | That same branch at 375px. |

Both lines come out of one call now — `bookedOutcome` in `lib/booking.ts`, branching once on the `queued`
that POST /api/book answers — the way `lib/plural.ts` owns the span noun for the four patient-path sites
(T114). The component holds no wording of its own, so the heading cannot be changed without the sentence it
has to agree with.

T111's own README closes by leaving this heading alone, on the reading that "<name> is on the way" is about
the patient keeping their appointment rather than about the message. On the screen it does not read that way:
it sits directly above a sentence about the invite, under a green tick, in a card whose last element is the
link to hand over because nothing was sent. The reviewer sweep of 2026-10-22 filed it off the committed
screenshot above. `lib/booking.test.ts` holds both lines to one rule — nothing on an unsent card reads as
motion — across every named row of `data/fixtures/visit_import.csv`.
