# T135 — the import preview says what the office cannot send, before the button rather than after it

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0, 1029 unit tests with 0 failures,
265 Playwright tests passed and 11 skipped, whole check 18m14s on a slow box — build 2m02s, e2e 15m32s —
against the 2026-10-10 probe's 40s and 2m). In the cloud sandbox, where no email or SMS backend is
configured and the run's own config check says so: *"No email or SMS backend is configured: invite links can
only be read off the screen (design §8.1)…"*. That is the environment the bug was about, and the one a fresh
`.env` is in.

All three frames are the §2.2 import dialog at `IMPORT_WINDOW` (1280 × 1000), which is the window its
`max-height: 88svh` is written against (T107). `wholeRows` is asserted on every one of them, so no row is
half in the picture.

| File | What it shows |
|---|---|
| `desktop-provider-import-preview.png` | **The ticket.** The screen the decision is made on, in an office with no SMS backend, with the **Create 3 visits →** button in the same frame. Under *"3 ready to create, 2 to fix."*: **"No invites will be sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office. Create these visits and you will have to copy each link from the dashboard."** Before this ticket that line did not exist and the preview's only word on the subject was the Invite column's `Text message · Over the phone` — what the file asked for, with nothing asked about whether it could happen. Lines 3 and 4 are the `channel` column left blank: they read `Do not message · Not recorded` and add no fault, because that is the practice's own choice and not a gap in the deployment (T120). Line 4 keeps its amber row warning, which is a fact about the patient rather than about the office — the two now sit one above the other and stay different colours and different claims. |
| `desktop-provider-import-created.png` | The same file one press later, unchanged by this ticket: *"3 created."* and T111's sentence word for word — **"No invites sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office. Copy each link from the dashboard instead."** Read as a pair with the frame above, the two are one sentence in two tenses: a forecast staff can still act on by closing the dialog, then a report on rows that exist. `lib/importNote.ts` owns both and `lib/importNote.test.ts` holds each word. |
| `desktop-provider-import-preview-sendable.png` | The other half: a deployment with a sender previews *"2 ready to create."* and nothing else — no fault line, and no "cannot send" anywhere in `.import-preview`, which the test asserts rather than only counting the one element. The texted row and the "Do not message" row are both plainly **Ready**. What stands in for a configured deployment is `inviteFaults` stubbed to the empty array on the response, the way `e2e/invite.spec.ts` stands in for one and for the reason T111 gives: this gate configures no sender at all (§11.3), and a server that did would have every invite in the suite attempt a real SES or SNS call on a box with ambient AWS credentials. That the senders really do answer that way is `lib/notify.test.ts`'s to assert, on the senders themselves. |

## Why there is no 375px frame

The ticket's definition of done asks for the preview at both widths (§6.5). There is no phone frame of this
screen, and there cannot be one without changing the product: `.provider-import-button` is `display: none`
under the phone breakpoint (`app/globals.css`), because the dashboard's top bar fits one action on a phone
and importing a scheduler's CSV is desk work. `e2e/visits.spec.ts` skips the mobile project for that reason,
and it is why T107's and T111's frames of this same dialog are desktop-only too. Nothing in this ticket
changed that decision, and widening a deliberate breakpoint to satisfy a screenshot would be the tail
wagging the dog. The route itself is covered on both projects by the refusals test beside it, and the words
on both tenses are held at every width by `lib/importNote.test.ts`.

The last committed frame of this screen's preview *before* this ticket is
`docs/screenshots/tickets/t107/desktop-provider-import-preview.png` — an older tree, so read it for the
absence of the line and not for the rest.

## The wording

Both sentences are `lib/importNote.ts`'s, and the reason inside each is `lib/delivery.ts`'s, reached through
`inviteFaults` in `lib/notify.ts`: staff's words for a gap in the deployment, naming no variable and no
backend (§3.7, §10.6). The sender's own `sms not configured: …` stays in the log for whoever runs the
deployment. `lib/notify.test.ts` and `lib/importNote.test.ts` both hold the pair to that rule with the same
pattern lib/delivery.ts's own tests use, so a tenth sentence in this family cannot smuggle a setting's name
onto a practice's screen.
