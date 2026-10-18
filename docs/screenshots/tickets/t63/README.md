# T63 — Sour degrades as page state, not as a pattern

From the `npm run agent:check` run of this branch, which has no model key — the mode the bug lives in
(design §6.3, §11.3). What to look for in each.

| Shot | What it shows |
|---|---|
| `desktop-provider-sour-ready.png` | The clinician's one-pager. The READY chip, then one quiet amber line: "The assistant is not enabled for this practice, so the numbers are complete but no patterns or questions were written. Your practice administrator can turn it on." Patterns and Ask the patient read "Not generated." rather than carrying the sentence as a finding. Before this ticket the first pattern was "LLM not configured: set OPENAI_API_KEY to generate patterns and questions." |
| `mobile-provider-sour-ready.png` | The same screen at 375px (§6.5). The note wraps to three lines above the summary card; nothing scrolls sideways. |
| `desktop-provider-print.png` | §7.4's sheet. The same sentence, in the same words, above the two columns it explains — the numbers, the spike table and the charts print exactly as before. |
| `desktop-journey-10-patient-summary.png` | §2.7, the patient's own summary of the same week. "What your week showed" and "Things you might ask your doctor" are simply absent, the way they already were for an empty pair — no placeholder row, and nothing on the page names a variable. Your sleep spans the row it used to share with the patterns card. |

The clinician's other branch — a key is configured but the gateway is unreachable — keeps its own wording
("Model gateway unavailable … Retry in a minute.") and its null fingerprint, so a retry really retries. It
has no screenshot here because the suite's degraded server (port 3101) drives Sweetie rather than Sour;
`lib/sourRun.test.ts` and `lib/sourState.test.ts` cover it.
