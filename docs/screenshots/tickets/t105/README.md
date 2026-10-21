# T105 — Sweetie's opening message fits the phone transcript

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, which has no
`OPENAI_API_KEY` — the mode the demo and both routines run in (§6.3, §11.3), so the opener here is the one
`greeting()` writes rather than anything a model said.

Two `before-` shots, from the two trees this ticket was filed against. `before-mobile-375-sweetie-first-question.png`
is `docs/screenshots/tickets/t83/after-mobile-375-sweetie-first-question.png`, the state T83 left. The sandbox
demo card is on it, which is the 251px transcript §6.5 and the ticket both quote; the suite's own
configuration has no Dexcom, so every other shot here has no card and a 323px region. That is why the gate on
the message is written as the message's own height (`OPENING_BUBBLE_ROOM`, 221px — the 251px region less its
30px of padding) rather than as "nothing is scrolled out of sight": the budget stays the §6.5 figure whatever
chrome sits above the conversation. `before-mobile-375-sweetie-more-to-read.png` is the first draft of the
scroll cue, which the review of #176 sent back.

| File | What it shows |
|---|---|
| `before-mobile-375-sweetie-first-question.png` | The bug the ticket was filed for. Fourteen lines of one bubble in a 251px region: the message starts at its first word and runs off the bottom, under the composer, ending mid-glyph with ~63px unread and nothing on the screen saying so. |
| `after-mobile-375-sweetie-first-question.png` | The same screen on this tree. Eight lines, 181px, the whole of it in the region with room under it — her name, the practice, the visit type, the three optional buttons, "two questions", "talk or type", and the first question, all still there. No cue, because nothing is hidden. Byte-identical to the shot the first draft took: nothing here changed in this round. |
| `before-mobile-375-sweetie-more-to-read.png` | The first draft's cue, and both faults the review found in it. It is announcing a message with nothing below it — all ~15px past the fold are the bubble's padding, its border and the last line's own leading — and the pill is sitting across "what y|ou'd", mid-word, on the second-to-last line. |
| `after-mobile-375-sweetie-padding-past-the-fold.png` | That same state on this tree: the 272-character recorded reason, fifteen lines, the last of them (“like from this visit?”) whole on the screen, the bubble's chrome under the composer — and no cue, because no word is hidden. |
| `after-mobile-375-sweetie-more-to-read.png` | The case the cue *is* for, which the suite had no test for: a reply long enough to put whole lines under the composer. The region lands on the top of the message (T83), and "More below ↓" is a band under the region rather than a pill over it — the last line on the screen is whole and the cue is not on top of anything. |
| `after-mobile-375-sweetie-answered.png` | Mid-conversation, which is what the cue must *not* clutter: the patient has answered, older messages are above the top of the region, the newest is whole on the screen, no band. Byte-identical to the first draft's shot. |
| `after-desktop-sweetie-start.png` | Desktop, unchanged in layout — byte-identical to the first draft's shot, which is the §6.5 claim that none of this reaches the wider screen. The shorter opener reads as one paragraph beside a sidebar that already says "Two quick questions, one at a time. Sharing health data is optional." |

The opener can still be pushed past the region by a long enough practice name or recorded reason, and what
the model writes back is bounded by nothing at all — which is why the cue exists rather than only the shorter
words. What the unit test in `lib/sweetie.test.ts` holds is the message the product writes for itself: the
seeded demo, a booked visit with a reason, and a visit without one, each with and without glucose already in,
all under ten lines.
