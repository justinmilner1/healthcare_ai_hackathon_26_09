# T181 — the import preview names the channel a row chose and cannot send on

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where no email or
SMS backend is configured: that is the environment the bug was reported in, and the one a fresh `.env` is in.

All three frames are the §2.2 import dialog at `IMPORT_WINDOW` (1280 × 1000), the window its
`max-height: 88svh` is written against (T107), with `wholeRows` asserted so no row is half in the picture.
The file in the first two is `e2e/visits.spec.ts`'s six-row day; it gained line 5 for this ticket.

| File | What it shows |
|---|---|
| `desktop-provider-import-preview.png` | **The ticket.** Line 5 — *CSV Texted*, an address on file and **Text message** in the Invite column — now carries **"A text message needs a mobile number."** beside the row it is true of. Before this ticket that row was `Ready` with nothing under it: `warningsFor` fires only when *both* fields are blank, so a row with one of them and the other channel chosen passed the preview silently and the first anyone heard of the gap was the dashboard's delivery cell, minutes later, with the row already written (§8.3). The sentence is `channelNeeds`'s (`lib/visitIntake.ts`), which is the clause the wizard's step 3 forecast already reads — so one missing field is not worded two ways across §2.2's two ways of creating a visit. |
| `desktop-provider-import-created.png` | **The same line one press later.** *"4 created."*, and line 5's warning is word for word what the preview showed. The dialog renders the preview block in both tenses, so the row's own line has to survive the press the way the tally's does. |
| `desktop-provider-import-preview-sendable.png` | **The half that keeps the rule honest.** Two reachable rows — a texted one with a mobile number, and one with a blank `channel` column that asks for no send at all — and neither grows a line. A preview that warned about everything would meet criterion 1 and say nothing; this is the frame that shows it does not. |

Read the first two against `docs/screenshots/tickets/t180/desktop-provider-import-preview.png` and
`…-created.png` — the same dialog, the same file plus one row — for exactly what this ticket added.

## The three shapes, in one frame

`desktop-provider-import-preview.png` holds the whole rule, which is why it is one picture and not three:

- **Line 4**, *CSV Unreachable*, neither field: `warningsFor`'s line and **nothing under it**. That row's
  link does not open at all, which is the larger fact and is already named with its remedy; a second
  sentence about the same empty cell would be the T170 split that T170, T173 and T176 each spent a ticket
  undoing. Criterion 4 is this row being unchanged.
- **Line 5**, *CSV Texted*, one field and the other channel: the new line, and only it.
- **Lines 2 and 3**, reachable and *Do not message*: nothing.

## Why `warningsFor` was not widened (criterion 3)

`warningsFor` is also step 3's second line in the booking wizard, printed under `bookingPlan`'s forecast
(`app/provider/dashboard.tsx`), and that forecast already says the chosen channel's missing field once. Two
sentences about one field on that step is exactly the split this family of tickets keeps closing. The
sentence is owed to the **import preview**, which has no forecast behind it — so it is `csvRowWarnings` in
`lib/visitIntake.ts`, called only by `parseVisitCsv`, with the reasoning written at it. The step 3 frames in
`docs/screenshots/tickets/t176/` are the ones this ticket must not have changed, and it does not touch them.

## Why there is no 375px frame

Criterion 7 asks for the preview and the created states at both widths. There is no phone frame of this
screen, and there cannot be one without changing the product: `.provider-import-button` is `display: none`
under the phone breakpoint (`app/globals.css`), because the dashboard's top bar fits one action on a phone
and importing a scheduler's CSV is desk work. `e2e/visits.spec.ts` skips the mobile project for that reason,
which is why T107's, T111's, T135's, T170's and T180's frames of this same dialog are desktop-only too.
Nothing in this ticket changed that decision, and widening a deliberate breakpoint to satisfy a screenshot
would be the tail wagging the dog. The route is covered on both projects by the refusals test beside it, and
the sentence itself is held at every width by `lib/visitIntake.test.ts`, which asserts it against
`channelNeeds` rather than against a literal.

## The wording

`channelNeeds` (`lib/visitIntake.ts`), unchanged and now with a second caller. Staff's words: the missing
cell is the front desk's own, and the sentence names no backend, no variable and no credential (§3.7,
§10.6). The deployment's own gap and §8.1's fallback are the tally line's subject, one block above —
`importInviteNote` (`lib/importNote.ts`), untouched here, so this ticket adds no third sentence to that
dialog, which is what T181 and T180 each asked of whichever landed second.
