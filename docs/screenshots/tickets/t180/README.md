# T180 — the import dialog stops offering a handover over a row it also says will not open

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0; unit `# pass 1277 / # fail 0`,
infra `# pass 19 / # fail 0`, `293 passed` with 11 skipped and no serial re-run, `restore: ok`; whole check
15m14s — build 1m16s, e2e 13m12s — against the 2026-10-10 probe's 40s and 2m). In the cloud sandbox, where
no email or SMS backend is configured: that is the environment the bug was reported in, and the one a fresh
`.env` is in.

All three frames are the §2.2 import dialog at `IMPORT_WINDOW` (1280 × 1000), the window its
`max-height: 88svh` is written against (T107), with `wholeRows` asserted so no row is half in the picture.

| File | What it shows |
|---|---|
| `desktop-provider-import-preview.png` | **The ticket, first half.** The same frame the bug was filed from, now agreeing with itself. The intro ends *"…and a row with a blank `channel` is created without an invite."* — the clause T170 left on it, "hand those patients the link yourself", is gone. The tally line reads **"No invites will be sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office. Handing the link over will not get this patient in either."** Line 4 keeps its amber warning unchanged (*"…the six-digit code their link needs has nowhere to go and the link will not open"*). Three sentences about this file, and none of them now offers a link another one says will not open. Before this ticket the first two both offered it. |
| `desktop-provider-import-created.png` | **Second half: the same three lines one press later.** *"3 created."* over the committed tense — **"No invites sent: … Handing the link over will not get this patient in either."** — and the identical row warning. Both tenses move together, which is what `importInviteNote` owning the pair is for; `lib/importNote.test.ts` holds each word of both. |
| `desktop-provider-import-preview-sendable.png` | **The other direction, and the half of criterion 1 only a configured office can show.** A deployment with a sender previews *"2 ready to create."* with no tally line at all — so the intro is the whole of what this module puts on the screen, and it now offers nothing. That is the case the intro's clause was wrong in even before any deployment gap: a row with nothing on file reaches it in an office with both backends, with nothing else on screen to correct it. What stands in for a configured deployment is `inviteFaults` stubbed to the empty array on the response, for the reason T111 and T135 give: this gate configures no sender (§11.3), and a server that did would have every invite in the suite attempt a real SES or SNS call on a box with ambient AWS credentials. |

## Why the line reads as a withdrawal here and not as "some"

`handover` has three values, because the sentence is per import and the answer is per row. On this file all
three creatable rows are rows no code can reach — the texted one has a mobile number in an office with no
SMS backend, and the two blank-`channel` rows ask for nothing — so the one reason present speaks only for
rows the handover is not a way in for, and the line withdraws it. A file where a reason's rows are mixed
gets the reason and no remedy clause at all; `lib/importNote.ts`'s comment at the branch states the rule and
why neither two-value rule is honest, and `lib/notify.test.ts` and `lib/importNote.test.ts` hold all three
arms. The remedy itself has not moved: it is **Copy intake** on every dashboard row, where §8.1's fallback
lives for every patient it opens for.

## Why there is no 375px frame

Criterion 8 asks for the preview and the created states at both widths. There is no phone frame of this
screen, and there cannot be one without changing the product: `.provider-import-button` is `display: none`
under the phone breakpoint (`app/globals.css`), because the dashboard's top bar fits one action on a phone
and importing a scheduler's CSV is desk work. `e2e/visits.spec.ts` skips the mobile project for that reason
— the run's own log shows both import specs as `- 301 [mobile]` and `- 302 [mobile]`, skipped — and it is
why T107's, T111's, T135's and T170's frames of this same dialog are desktop-only too. Nothing in this
ticket changed that decision, and widening a deliberate breakpoint to satisfy a screenshot would be the tail
wagging the dog. The route is covered on both projects by the refusals test beside it, and the words of both
tenses are held at every width by `lib/importNote.test.ts`.

The frames of this screen immediately *before* this ticket are
`docs/screenshots/tickets/t170/desktop-provider-import-preview.png` and `…-created.png` — read those two
against the two here for exactly what changed.

## The wording

Every sentence is `lib/importNote.ts`'s; the reason inside each is `lib/delivery.ts`'s, reached through
`inviteFaults` in `lib/notify.ts`; and the clause that withdraws the offer is `NO_HANDOVER_SENTENCE`, the
same constant the booking step, the success card and the three notes under a dashboard row end on (T173,
T175, T176, T179). Staff's words throughout, naming no variable and no backend (§3.7, §10.6) — held to that
by the same pattern lib/delivery.ts's own tests use, over all three handover arms rather than only the one
that offers.
