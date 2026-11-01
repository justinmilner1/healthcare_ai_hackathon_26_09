# T211 — the typing indicator sat at the bottom of the card instead of under the message it answers

T209 moved the indicator out of the `role="log"` transcript and into a row under it, which is right and is
what that ticket asked for: a live region nested in a live region leaves "announced once or twice" to the
screen reader. This ticket is only about where the dots then landed on screen.

`.sweetie-messages` was `flex: 1`, so the scrolling region grew to fill the conversation column however
little was in it — and every row under the region is pinned to the composer by that growth. On a desktop
with two messages in the thread, which is the common case for the indicator since it is most often up on the
patient's **first** reply, the dots stood about 180px below the message they were answering with blank card
in between, and read as a different piece of furniture rather than as Sweetie answering (§2.5).

The region is `flex: 0 1 auto` now: the growth is gone and the shrink is kept, so it is its content's height
until its content outgrows the column and then `min-height: 0` plus `overflow-y` make it the scrolling box it
always was. The slack goes to the bottom of `.sweetie-transcript`, which keeps its own `flex: 1` — so the
composer does not move, and §6.5's floor (`TRANSCRIPT_ROOM`, `e2e/mobile.ts`) is still read off that wrapper
rather than off the region inside it.

## The second drift, which the ticket did not know about

The ticket says the gap "does not arise" at 375px, and about the *vertical* gap it is right: the phone's
transcript is full, so the dots were already under the patient's message. What was wrong there instead was
the horizontal gutter. The region and the slot each carried their own copy of `clamp(20px, 4.5vw, 55px)`,
which agreed at desktop widths — and at 375px the region's own override took its padding down to 13px while
the slot kept the clamp's 20px floor, so Sweetie's typing avatar stood **7px further in** than Sweetie's
message avatar directly above it. Compare `mobile-a11y-sweetie-typing.png` here against `../t209/`'s: the
two avatars are one column now. The gutter is `--sweetie-gutter`, declared once on `.sweetie-transcript` and
inherited by both, so the two cannot drift apart again.

## What separates the dots from the message

The region's own `padding-bottom` — 22px, 15px at 375px — and nothing else, because the slot has no top
padding of its own. That padding is the breathing room the transcript already keeps under its newest message
when it scrolls, so there is no second number here to keep in step with it. `e2e/a11y.spec.ts` asserts the
placement that way rather than against a figure of its own: the slot's top edge is within 2px of the last
message's bottom plus that padding, at either width, whatever the stylesheet sets it to. The ~180px gap
fails it by either reading, and so would a slot that drifted back down to the composer.

## The frames

| File | What to look at |
|---|---|
| `desktop-a11y-sweetie-typing.png` | The fix, and the frame the bug was found in. The dots are directly under "Evenings are the bad ones, mornings are fine.", avatar beside them, with the blank card **below** them instead of between. Everything else is pixel for pixel `../t209/desktop-a11y-sweetie-typing.png`, where the same dots sit at the bottom of the card just above the composer. |
| `mobile-a11y-sweetie-typing.png` | The same state at the 375px of §6.5. The vertical placement was already right here; what changed is the gutter — the typing avatar is now in the same column as the one on Sweetie's opening message, 7px left of where `../t209/mobile-a11y-sweetie-typing.png` has it. |
| `desktop-sweetie-start.png` | Nothing in flight, one message in the thread: no slot, no row, no permanent gap over the composer. `.sweetie-typing-slot:empty { display: none }` still gives the pixels back, and the screen is the one it was — the conversation was drawn from the top of the region before this ticket too, so taking the region's growth away moved nothing a patient sees here. |
| `desktop-sweetie-done.png` | A thread long enough to scroll, finished. The closing card is hard against the composer with no slack between them: when the content outgrows the column the region shrinks to fit exactly as it did, and the slack this ticket moved does not exist to move. |
| `mobile-375-sweetie-more-to-read.png` | §6.5 and T105's cue, unchanged. A message too tall for the phone's region, the region full, "More below ↓" its own row between the region and the composer, no horizontal scroll. The cue only ever appears in the state where the region is at its maximum height, so `flex: 0 1 auto` cannot reach it. |

## What this ticket did not change

The ARIA, which is the whole of T209 and the thing a fix for a layout bug is most likely to undo. The
indicator is still a `role="status"` with its words in its content and in its name, and still outside every
live region: the assertions T209 added in `e2e/a11y.spec.ts` are untouched, including the walk up
`xpath=ancestor::*[@aria-live or @role='log' or @role='status'][1]` that expects nothing. Nothing in
`app/s/[token]/page.tsx` moved but a comment — the fix is one property on the region above the slot.
