# T96 — the unconfigured brief stops inventing a practice setting

From `bash scripts/agent-check.sh` on the tree this ticket landed, in the cloud sandbox, which has no
`OPENAI_API_KEY`. That is the state the bug was about and the state the demo and both routines run in
(§6.3, §11.3): Sour saves every number it computed and the two narrative sections come back empty, so the
note under the chip is on screen in every run.

Old sentence, on all four of these screens before this ticket:

> The assistant is not enabled for this practice, so the numbers are complete but no patterns or questions
> were written. Your practice administrator can turn it on.

New sentence, from the same one function (`lib/sourState.ts`):

> Assistant not configured: the numbers are complete; patterns and questions were not generated. No practice
> setting turns this on — ask whoever set Sweet Spot up for your office.

| File | What it shows |
|---|---|
| `desktop-journey-12-sour-brief.png` | The clinician's one-pager at the end of `e2e/journey.spec.ts` (§7.2). The READY chip, then the amber line in its new wording, over complete numbers — 97% in range, avg 124, GMI 6.3% — and Patterns and Ask the patient reading "Not generated.". The old line sent this clinician to Settings; `Practice` has `name`, `retentionDays` and `isDemo` and the settings page offers the first two, so there was nothing there to find. |
| `desktop-journey-15-print-sheet.png` | The sheet that goes into the visit (§7.4), same visit, printed after sign-off. §6.3's "one sentence that should read the same in both places" — the words are identical to the screen above because both read `narrativeNote` out of `lib/sourState.ts`. The sheet puts it under the numbers and the screen over them, which is why neither says "above" or "below". |
| `desktop-provider-print.png` | `e2e/print.spec.ts`'s own sheet, where this ticket added the assertion that the note is there, says the numbers are complete, names whoever set Sweet Spot up, and does not say "administrator" or "turn it on". Nothing asserted the sheet's copy of the note before. |
| `mobile-provider-sour-generated.png` | The brief at 375px (§6.5). The new sentence is longer than one phone line and wraps to four inside the amber band, with no clipping and no overflow. |

The phrase "ask whoever set Sweet Spot up for your office" is not new wording invented here: it is what
`lib/delivery.ts` already tells staff about a sender nobody has configured, so the practice reads the same
person whichever thing the deployment is missing. Neither note names a variable, which is what T63 (#99)
removed and §3.7/§10.6 keep removed — model configuration is the deployment's and SSM Parameter Store's,
never a practice's.
