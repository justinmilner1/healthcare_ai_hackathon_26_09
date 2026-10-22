# T119 — the whole-rows gate, judged against the frame the shot will hold

> `wholeRows` judges a full-page shot against the window, so it fails frames that are whole. — #190

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox: 942 unit tests,
19 infra, 234 e2e passed with 10 skipped, whole check 7m39s on a box whose build measured 35s against the
2026-10-10 probe's ~40s warm — this run is not a slow box, so the figures are about the tree.

**There is no before/after pair of `desktop-provider-sour-flags.png`, and that is the finding.** The ticket
asked for one "if the frame changes at all". It does not change, and cannot: `wholeRows` is an assertion
that reads `getBoundingClientRect()` and never touches the page, so neither what is captured nor how much of
it is captured depends on it. The frame is 1280 × 1676 before this ticket and 1280 × 1676 after, re-measured
here by regenerating the shot from `9635d37` (the commit before the first of T119's) and from the landed
tree in the same session. Only the *verdict* on that frame changed, which is why the evidence for the fix is
the fixture below rather than a photograph of the brief.

| File | What it shows |
|---|---|
| `desktop-provider-sour-flags.png` | The clinician's brief, the frame the old gate could refuse. Both flag blocks are whole, red, above the Summary card — and the intake banner the shot is *anchored* on sits a third of the way down the image rather than at its top edge, because scrolling cannot change a full-page frame. That is the bug in one picture: the helper was asking whether a row had fallen off an edge this capture does not have. `e2e/flags.spec.ts` now names both blocks in `wholeRows`, the anchor included, instead of only the block below it. |
| `desktop-shot-wholerows-fullpage-straddle.png` | The new fixture in `e2e/shot.spec.ts`, 1280 × 980 at the desktop project's 720px window. The peach row is `#straddle`: 60px of it above the fold, 20px below, and the capture holds all 80. This is the shot the pre-fix helper refused — `"across the window's bottom edge" 60 of 80px in frame` — and the one it now passes. Above it, inside the `overflow-y: auto` scroller, `#clipped` is cut at the scroller's own edge: the half of the check `fullPage` does not touch, and still a failure in every capture there is. |
| `mobile-shot-wholerows-fullpage-straddle.png` | The same fixture at 375px (984 × 2433 at the phone's 2.625 device scale), so the geometry is pinned at both window heights rather than at the desktop's only. The spacer above `#straddle` is sized in `vh` for exactly that reason, and `beforeEach` asserts the 60/20 split rather than assuming it. |

What these are evidence for: that the gate now refuses the two frames that really do cut a row and accepts
the one that does not. What they are not evidence for: the sub-pixel scroll rounding in T108's report, which
is box-dependent — on this container the brief's anchor lands on or below the window's top edge and the
pre-fix helper passed `e2e/flags.spec.ts` with the anchor named. That is why the regression test is a
fixture page with a row on the fold by construction, and not the product screen that happened to expose it.
