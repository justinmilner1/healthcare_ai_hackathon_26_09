# T04 screenshots

From `bash scripts/agent-check.sh` on branch `t04-job-runner`.

| File | What it shows |
|---|---|
| `desktop-provider-sour-generated.png` | The summary this ticket is about. Opening a patient with uploads and no summary now queues a `sour.run` job instead of generating inside the request; the page polls and this is what it ends on. Everything here was written by the job: the Patterns placeholder is Sour's scripted output (no key in the check run), the button has gone back to "Regenerate", and the footer carries the generated time. |
| `mobile-provider-sour-generated.png` | The same at phone width, so the wait and the result are visible there too. The stat tiles below the summary overflow their row — pre-existing, not from this ticket, and called out in the pull request. |
| `desktop-provider-dashboard.png` | The dashboard, whose Add patient and Send link now queue a `notify.invite` job. Unchanged at rest; the wording that changed is the note after a send ("Sending the link to this patient now"), which no test clicks. |
| `desktop-provider-sour.png` | The same page with nobody selected, for comparison with the generated one. Unchanged by this ticket. |
