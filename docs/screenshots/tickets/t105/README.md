# T105 — Sweetie's opening message fits the phone transcript

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, which has no
`OPENAI_API_KEY` — the mode the demo and both routines run in (§6.3, §11.3), so the opener here is the one
`greeting()` writes rather than anything a model said.

The `before-` shot is not from this run: it is `docs/screenshots/tickets/t83/after-mobile-375-sweetie-first-question.png`,
the state T83 left and the state this ticket was filed against. The sandbox demo card is on it, which is the
251px transcript §6.5 and the ticket both quote; the suite's own configuration has no Dexcom, so the `after-`
shots have no card and a 323px region. That is why the gate on the message is written as the message's own
height (`OPENING_BUBBLE_ROOM`, 221px — the 251px region less its 30px of padding) rather than as "nothing is
scrolled out of sight": the budget stays the §6.5 figure whatever chrome sits above the conversation.

| File | What it shows |
|---|---|
| `before-mobile-375-sweetie-first-question.png` | The bug. Fourteen lines of one bubble in a 251px region: the message starts at its first word and runs off the bottom, under the composer, ending mid-glyph with ~63px unread and nothing on the screen saying so. |
| `after-mobile-375-sweetie-first-question.png` | The same screen on this tree. Eight lines, 181px, the whole of it in the region with room under it — her name, the practice, the visit type, the three optional buttons, "two questions", "talk or type", and the first question, all still there. No cue, because nothing is hidden. |
| `after-mobile-375-sweetie-more-to-read.png` | The case the cue is for: a visit whose recorded reason is 272 of the 280 characters `MAX_REASON` allows, which the first question quotes. The region lands on the top of the message (T83) and "More below ↓" sits at the bottom-right, over a line's ragged end rather than across the middle of the last readable one. |
| `after-mobile-375-sweetie-answered.png` | Mid-conversation, which is what the cue must *not* clutter: the patient has answered, older messages are above the top of the region, the newest is whole on the screen, and there is no pill. |
| `after-desktop-sweetie-start.png` | Desktop, unchanged in layout. The shorter opener reads as one paragraph beside a sidebar that already says "Two quick questions, one at a time. Sharing health data is optional." |

The opener can still be pushed past the region by a long enough practice name or recorded reason — the third
shot is exactly that — which is why the cue exists rather than only the shorter words. What the unit test in
`lib/sweetie.test.ts` holds is the message the product writes for itself: the seeded demo, a booked visit
with a reason, and a visit without one, each with and without glucose already in, all under ten lines.
