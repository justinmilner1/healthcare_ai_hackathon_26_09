# T144 — the upload target, removed

The point of this ticket is that **nothing a patient sees moves**, so these five shots are evidence of an
absence. Taken by `bash scripts/agent-check.sh` on the tree that landed (exit 0; 271 Playwright passed, 11
skipped; 1062 unit of 1063; infra ok; restore drill ok).

Four of them are **byte-identical** to the same files committed under `docs/screenshots/tickets/t139/`,
which were taken before this change:

```
$ cmp e2e/screenshots/desktop-sweetie-start.png docs/screenshots/tickets/t139/desktop-sweetie-start.png
$ cmp e2e/screenshots/desktop-sweetie-done.png  docs/screenshots/tickets/t139/desktop-sweetie-done.png
$ cmp e2e/screenshots/mobile-375-sweetie-answered.png docs/screenshots/tickets/t139/mobile-375-sweetie-answered.png
$ cmp e2e/screenshots/mobile-sweetie-done.png   docs/screenshots/tickets/t139/mobile-sweetie-done.png
```

| File | What it shows |
|---|---|
| `desktop-sweetie-start.png` | The greeting. The Dexcom, Timeline and WHOOP controls are in the panel beside the conversation, where §2.5 puts them. |
| `desktop-sweetie-done.png` | The whole conversation: question → question → wrap. No turn offers an upload, which is what the removed code would have written. |
| `mobile-375-sweetie-first-question.png` | The same greeting at 375px, with the three controls stacked **above** the transcript — why Sweetie's prompt names a control and never places one (§6.5). |
| `mobile-375-sweetie-answered.png` | Mid-conversation at 375px: the second question, not an upload offer. |
| `mobile-sweetie-done.png` | The wrap at phone width. |

What is **not** here, deliberately: a shot of the `sandboxPatient === true` branch that `SANDBOX_CONNECT_HELP`
used to duplicate. The suite has no sandbox-patient chat spec — that branch needs `DEXCOM_ENV=sandbox` and
the dedicated demo patient — so the ticket asked for a unit test instead, and
`lib/sweetie.test.ts` holds `app/s/[token]/page.tsx`'s branch to naming the Connect Dexcom sandbox link. That
is the same gap `docs/screenshots/tickets/t139/README.md` reported for the upload turn, and the reason this
ticket exists: a screen that cannot be photographed because the turn never happens.
