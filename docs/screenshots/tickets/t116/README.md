# T116 — the setup-complete step offered to show a week to a patient who shared nothing

From the `bash scripts/agent-check.sh` run that passed (exit 0, 218 Playwright tests) on the tree these
commits landed as. The pair to read first is the two `-empty` shots: they are the frame the ticket was filed
against, and the thing to check in them is a negative — that nothing on the card offers data.

| File | What it shows |
|---|---|
| `desktop-connect-done-empty.png` | §2.5, step 2 with nothing shared. The four strings the ticket named now follow `hasConnections`: the bubble reads "Nothing shared yet. We can still talk it through.", the lede "You haven't shared any data, so there's nothing to show you yet…", the primary button "Chat with Sweetie" and the hint "A short chat still gives your clinician something to work from." The row between them is T84's, unchanged. Before this ticket the same frame said "Your week is ready to view", "Go straight to your week", "View my week" and "Your shared data stays saved" around that same "No data connected yet". |
| `mobile-connect-done-empty.png` | The same at 375px (§6.5). The hint still sets on one line and the lede on four; the two actions that lead somewhere real — the chat, now the primary, and "Back to connections" — are both above the fold of the card. |
| `desktop-connect-done-connected.png` | The other half of the acceptance criteria: with one source shared the step is word for word what it was. "Your week is ready to view.", "Go straight to your week…", "1 data source connected", "View my week", "Skip the questions. Your shared data stays saved.", and the chat back in the secondary row as "Chat with Sweetie instead". |
| `mobile-connect-done-connected.png` | And that state at 375px, framed identically to the empty one, so the pair is a before-and-after of one card rather than two different screens. |
| `mobile-375-connect-done.png` | The third frame the change lands in: `e2e/mobile.spec.ts` walks the connect flow without sharing anything, so its step-2 shot is the empty state too and used to carry the same promise. Shown here so the §6.5 pass and the §2.5 fix are known to agree. |

The span wording in the connected shots is deliberately untouched. T114 (#185) moved "your week" onto
`spanNoun` at the three sites that know how many days arrived; this step runs before any of that is
computed, so it keeps the wording it has always had rather than guessing a span. The empty state does not
name a span even to deny it — step 2 has no other use for the word, which is why
`e2e/connections.spec.ts` can assert the absence of "week" over the whole frame instead of string by string.
