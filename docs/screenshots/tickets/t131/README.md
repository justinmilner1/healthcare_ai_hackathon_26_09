# T131 — the invite card stops promising an email, and stops pointing at a sign-in that errors

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0, 1011 unit tests with 0 failures, 256 Playwright
tests, whole check 7m41s, build 33s), in the cloud sandbox. All four frames are from the suite's sixth web
server (`UNSENDABLE_PORT` in `playwright.config.ts`): no email backend **and** no `DEV_MAIL_DIR`, which is
the state a fresh `.env` is in and the only state in which §2.1's staff onboarding dead-ends. Every other
server in the suite names a mailbox, which is why this card went unchallenged — `canSendOrMailbox()` is true
on all of them, so the honest branch had no screen anybody could look at.

The practice is a fresh one (`Unsendable Endo`), not the seeded demo: §13.4 closes a demo practice's channels
on its own, and a card that is honest for two reasons at once proves neither of them.

| File | What it shows |
|---|---|
| `desktop-provider-settings-invite-unsendable.png` | The hint above **Invite someone**, before the admin does anything: *"Sweet Spot cannot send email yet — ask whoever set it up for your office. You can add someone and set their role, but nothing reaches them and they cannot sign in until it is fixed."* Before this ticket that line was the literal *"They get an email asking them to sign in with this address. Nothing in it signs anyone in — the one-time link comes to their own inbox."* — on this exact deployment. The red left rule is the new `.settings-invite-hint-blocked`, the same aside shape as §13.4's demo note one card over, in red rather than amber because this one *is* something wrong. |
| `mobile-provider-settings-invite-unsendable.png` | The same hint at 375px (§6.5), three lines, inside the card. |
| `desktop-provider-settings-invite-unsendable-sent.png` | After inviting a colleague as clinician: *"…@unsendable-endo.com was added with that role, but they cannot sign in yet: Sweet Spot cannot send email yet — ask whoever set it up for your office."* The sentence this replaced ended *"Ask them to sign in with that address"*, and on this deployment that is a dead end — `sendVerificationRequest` throws with nothing to send through and `/provider/signin` answers `?error=` (`lib/auth.ts`, T113), while `POST /api/practice/users` hands back no link to forward either. `e2e/teamInvite.spec.ts` step 4 walks that refusal rather than taking the new wording's word for it. |
| `mobile-provider-settings-invite-unsendable-sent.png` | That note at 375px. The address is one unbreakable token and wraps inside the box rather than widening the card (T101's lesson, which this screen learned the hard way). |

Both sentences come from one call each on one value — `inviteHint` and `invitedNote` in `lib/teamInvite.ts`,
branching on `canSendOrMailbox()` — the way `lib/booking.ts` owns the two lines of the wizard card (T122) and
`lib/inviteNote.ts` the two notes under the dashboard's invite buttons (T129). The component holds no wording
of its own. `canSendOrMailbox()` and not `emailConfig()`, because a checkout naming `DEV_MAIL_DIR` really can
deliver both the nudge and the magic link, to a file.

The invariant is asserted as data rather than as prose: every line carries `claimsEmail` and `offersSignIn`,
and `lib/teamInvite.test.ts` walks all four lines the card can show at both values of the question — nothing
may claim a send or offer a sign-in where nothing can be mailed, and the staff sentence is
`lib/delivery.ts`'s `cannotSendYet("email")` on every one of them, so no variable, backend or credential
reaches a practice's screen (§3.7, §10.6).

The sentence appears twice in the second pair of frames, once in the hint and once in the note. That is
deliberate: the note is `role="alert"` and is announced on its own, so it has to stand without the hint above
it.
