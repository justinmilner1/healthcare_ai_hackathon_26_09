# T182 — step 3 stops heading a withdrawal with a promise

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, where no email or
SMS backend is configured (§11.3). That is what makes the gate able to photograph this bug at all: with no
sender behind either channel, a patient whose only detail is a mobile number has nowhere for a six-digit
code to arrive, which is the second of the two ways §8.1's handover stops being a way in.

All four frames are §2.2's booking wizard on step 3, `MODAL` (one viewport's worth of dialog at either
width), with `wholeRows` asserted so no sentence is half in the picture.

| File | What it shows |
|---|---|
| `desktop-provider-add-visit-no-contact-heading.png` | **The ticket.** The three paragraphs in the order a front desk reads them, now saying one thing: **"Ready to go on file."**, *"Saving creates the patient and their private Sweetie link."*, *"Nothing is sent, and handing the link over will not get this patient in either."* Until this ticket the first of them was **"Ready for the handoff."** — the largest type in the column, promising what the two under it withdraw. |
| `mobile-provider-add-visit-no-contact-heading.png` | The same step at 375px (§6.5). The phone needs its own frame: the four channel cards sit between the lede and the note, so no one phone screen holds all three paragraphs, and the pair this ticket is about is the two the committed T173/T177 frame leaves out. |
| `desktop-provider-add-visit-no-sender-for-code.png` | **The second way to have nowhere to send a code**, and the one a pilot is actually in: a mobile number on file and no SMS backend behind it. Same heading, over the deployment's own reason — *"No invite will be sent: Sweet Spot cannot send texts yet — ask whoever set it up for your office."* — which is still marked as somebody's to fix. The reason is withdrawn from nothing; only the remedy was (T175). |
| `mobile-provider-add-visit-step3-scroll-top.png` | **The half that keeps the rule honest.** The reachable patient's step, at the same width and the same anchor, word for word as it was before this ticket: **"Ready for the handoff."** over *"… which you hand over yourself."* A heading that said less to everybody would satisfy the rule and say nothing; this is the frame that shows it does not. |

Read the first against `docs/screenshots/tickets/t177/desktop-provider-add-visit-no-contact-default.png` —
the same dialog, the same booking, one ticket earlier — for exactly what changed: that frame is where this
ticket was found, and its heading is the line this one replaced.

## Why "Ready to go on file."

It is the forecast tense of what the success card's panel already says one press later — *"The visit is on
file."* (`bookedOutcome`, T177) — so the step and the card are one claim in two tenses, the way the lede and
the note have been since T173. It states what pressing the button really does and stops: the reason is
`warningsFor`'s, three lines below on the same step, and the remedy is the note's, so a third line about one
fact would be the thing every ticket in this family was filed about (T140, T168, T170, T173, T175, T177).

## The panel beside the form

`WIZARD_SIDE_COPY[2]` — **SEND THE INVITE** / *"One secure link. No patient account needed."* — is unchanged,
which this ticket decided rather than left. The eyebrow is a label for the *step*, the way **START WITH A
PERSON** labels step 1 for a patient already on file, and the step is where the channel and the consent are
chosen, including the choice to send nothing. The sentence under it is true of every link this product makes,
including one no code can open. Neither is a claim about the booking on screen, and the claims that are are
`bookingPlan`'s. `app/provider/dashboard.tsx` carries that reasoning where the constant is.
