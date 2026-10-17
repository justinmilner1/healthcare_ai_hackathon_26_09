# T53 — the opener names the upload button instead of placing it

The bug was one sentence of Sweetie's opening message: *"add your Dexcom export with the button on the
left"*. §6.5 designs the intake page for 375px, and at that width the three upload controls are a row
**above** the transcript, so the first instruction a patient reads pointed at nothing. These shots are the
same message at both widths, from the `bash scripts/agent-check.sh` run this pull request reports.

| File | What it shows |
|---|---|
| `mobile-journey-07-sweetie-greeting.png` | 375px, §6.5. The greeting now reads "add your Dexcom export with the **Dexcom** button", and the button it names is in the pink panel directly above the bubble, labelled `Dexcom`. Nothing in the sentence claims a side. |
| `mobile-sweetie-start.png` | The same screen from `sweetie.spec.ts`, scrolled to the first question. It is the shot the issue cited as evidence: the Dexcom, Timeline and WHOOP controls in a row above the conversation, never to its left. |
| `desktop-journey-07-sweetie-greeting.png` | 1280px. The upload panel *is* on the left here, and the new wording is still true — naming the control works at both widths, which is the point. The faded bubble is the mid-transition capture of open bug T77, not this change. |
| `desktop-sweetie-start.png` | The same greeting with the transition settled, so the whole sentence is legible in one piece. |
| `desktop-sweetie-degraded.png` | §6.3, the scripted path with the model gateway down. This is the shot `docs/screenshots/tickets/t35/README.md` flagged as carrying the bug; the scripted offer now names the Dexcom button too, so both paths say something true. |

`lib/sweetie.test.ts` holds the wording the same way it holds the rest of the opener, and a second test reads
`lib/sweetie.ts` to keep any placement — the prompt `speak()` hands to the model included — from coming back.
