# T106 — the degraded-mode frames, taken after the transcript has stopped moving

From `bash scripts/agent-check.sh` on the tree this ticket landed (the `after-` shots) and from the same two
specs re-run on the tree immediately before it (the `before-` shots), both in the cloud sandbox. The two
`sweetie-degraded` frames come off the second Playwright web server, the only one with a model gateway
configured and unreachable, which is the one place either routine can *see* §6.3: the amber "assistant is
unavailable" note and the scripted question continuing under it.

The defect was never in the page — the poll `expectTranscriptUncut` runs settles on this tree and on the one
before it — it was in *when* the shutter opened. `toContainText` is satisfied as soon as the words are in the
DOM; the region then glides to them, and a programmatic smooth scroll is not a CSS transition, so
`shot()`'s `animations: "disabled"` (T77) does not freeze it. How much of the glide was left when the file
was written is therefore a property of the box. These `before-` shots were taken on a fast one (whole check
7m30s), and only the 375px frame still caught it; the reviewer's run of 2026-10-19 caught both.

| File | What it shows |
|---|---|
| `before-mobile-sweetie-degraded.png` | The bug. The region is mid-glide: the greeting is sliced through its glyphs at the top of it, and the scripted follow-up the test had just asserted — "Since you last saw the doctor, what's …" — is one line deep with the rest under the composer, "More below ↓" over it. The frame named for "the questions continue" does not show the question continuing. |
| `after-mobile-sweetie-degraded.png` | The same screen with the wait in front of the shot. The amber note and the whole of the scripted question are in one frame, which is the two things §6.3 and §11.3 claim together. The greeting is above the top of the region, which is the patient having read on, not a cut (T83). |
| `before-desktop-sweetie-degraded.png` | The desktop frame on this box, which landed before the shutter: whole greeting, the patient's answer, the whole scripted question. Kept so the pair is honest — at 1280px on a fast box there was nothing to see, and the frame that reproduced is the phone's. |
| `after-desktop-sweetie-degraded.png` | The same, now guaranteed rather than lucky. Visually identical to the shot beside it. |
| `after-mobile-sweetie-before-reload.png` | One of `e2e/durability.spec.ts`'s five transcript shots, which got the same wait. The card that ends the check-in is the newest thing in the region and is whole in the frame, with the answer above it. |
