# T121 — a patient whose only channel is bounced, STOPped or demo-blocked is told so, not promised a code

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0; 954 unit assertions passed and
1 skipped, 250 Playwright tests passed, whole check 8m22s), in the cloud sandbox. Two facts about that
environment decide what is in these frames: **email can be sent** — `DEV_MAIL_DIR` is the backend the run's
own codes really arrive in (§11.3, T113) — and **SMS cannot**, because no origination number is configured.
So a channel that closes here closes for a reason the picture can be read for.

| File | What it shows |
|---|---|
| `desktop-verify-no-code-row.png` | The screen this ticket is about, reached from §13.4's arm: a visit at the seeded demo practice whose only contact detail is an address somebody could own, so `demoBlockReason` refuses it although the mailbox behind email would have delivered it. Nothing but the row closed this channel. T98's register — practice above the heading, the heading, and the practice again in the sentence that asks for the call — and **no code box and no Send a new code**. It names no channel, no address, and no reason: *"your email bounced"* would tell whoever holds a forwarded link that this patient has an email on file (§2.3). |
| `mobile-verify-no-code-row.png` | The same screen at 375px (§6.5). The lede wraps to three lines and the card holds the whole of it. |
| `desktop-verify-no-backend.png` | T113's arm — a number on file and no SMS backend — **and it is the same frame, pixel for pixel**, which is the assertion rather than a duplicate file. §2.3 gives the patient one sentence whichever of the three filters closed the channel, so two different visits reaching two different screens would have been the leak. `e2e/verify.spec.ts` drives both through one helper for the same reason. The wording is new: T113's sentence named the deployment (*"Messages from … aren't going out just now"*), which is false of a bounced address, so it now says only that there is no way to send the code. |
| `mobile-verify-no-backend.png` | That arm at 375px, likewise identical to the frame above it. |
| `desktop-provider-dashboard-deliveries.png` | Staff's half, on the seeded `Dana Demo` row — the row the reviewer sweep found this bug from. The pills and the amber line above are §8.3 and §8.1 as they already were (`TEXT ✓`, `EMAIL ↩`, *Email bounced · Oct 20*); what is new is the red line under them: **"No code can reach this patient, so their link will not open — call them"**. Her address is dead and her number is one nothing here can text, so §2.3's code has nothing left to travel on and the visit stops until the front desk telephones. Each line above explains one channel; this is the only one that says what they add up to. `Sam Sample`'s row below is the control — reachable through the mailbox — and has no such line. |
| `mobile-provider-dashboard-deliveries.png` | The same cell at 375px, where there is no hover and so no tooltip at all, which is why the sentence is in words under the pills rather than in a `title` (§6.5, T74's own argument for the two lines beside it). |

What the frames cannot show, and where it is asserted instead:

- **§8.1's arm on the patient side.** `e2e/verify.spec.ts` drives it on this same seeded visit — staff read
  Dana's token off `GET /api/provider` and the browser is left as a patient's — and it reaches the frame
  above. It is not screenshotted separately for the reason the two `verify-no-backend` rows make: it is the
  same screen. Nothing in the suite can write `emailUndeliverableAt` itself; SES's bounce topic needs a
  signature only AWS can produce (`e2e/notifications.spec.ts`), so the seed is where a suppressed address in
  this run comes from.
- **The route's answer.** `POST /api/verify` returns **503** with no `sent` and no channels on all three
  arms, and mints nothing — chosen on what the patient can act on rather than on which filter closed the
  channel. Asserted in the same helper.
- **The two log events.** `verify_channels_closed` for a visit the row closed, `verify_no_backend` for one
  the environment did. Identical to the caller by design; the difference is for whoever runs the deployment,
  because only one of the two is theirs to fix. Ids and a count, no address and no reason text (§10.3).
- **The rule itself**, exhaustively: `lib/notify.test.ts` on `codeReach` — a suppressed address, a `STOP`ed
  phone, a demo practice with a real destination, each with and without a backend behind what is left, and
  the precedence that keeps T113's answer from regressing through it.

One thing deliberately not said on a row: a visit with **no phone and no email at all** gets no line here.
That patient cannot be telephoned about it either, and §2.2's gap has its own screen one flow over.
