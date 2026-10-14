# T15 screenshots

From `bash scripts/agent-check.sh` on branch `t15-sour-job-state`.

| File | What it shows |
|---|---|
| `desktop-provider-sour-generated.png` | The seeded patient once the `sour.run` job has reported back: the chip under the brief header reads **Ready**, with the time the summary was written. Before this ticket the page could only infer "nothing yet" from a missing summary. |
| `desktop-provider-sour-ready.png` | The same state reached the long way round, in the test that uploads a Dexcom export to a new patient and lets the queue summarize it — so this one is the chip after a run the suite watched happen. |
| `desktop-provider-sour-stale.png` | A WHOOP export arrived after the summary was written, so the fingerprint no longer matches (§7.1): **Out of date**, the sentence saying why, and Regenerate still reachable. Regenerating from here writes a genuinely new summary rather than returning the saved pair. |
| `mobile-provider-sour-generated.png` | The chip at 375px. It wraps rather than pushing the row sideways, and adds no horizontal scroll. |

The failed state is not here because nothing in the suite can make the scripted runner fail on demand without
a test-only code path; every transition that leads to it, including the reason text and the retry, is asserted
in `lib/sourState.test.ts` and `lib/jobs.test.ts` instead.
