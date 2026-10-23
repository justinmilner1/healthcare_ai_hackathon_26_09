# T132 — the last four patient strings that named a span the data does not support

From `bash scripts/agent-check.sh` on the tree this ticket landed (exit 0, 1012 unit tests with 0 failures
and 1 skipped, 260 Playwright tests, whole check 7m49s, build 32s, e2e 6m31s), in the cloud sandbox with no
Docker daemon and the Playwright CDN blocked — the pre-installed Chromium at
`/opt/pw-browsers/chromium_headless_shell-1194` stands in, which the script arranges itself.

Both frames are the connect step **before anything is uploaded**, which is the state all three of this
screen's strings are written against and the state a patient always arrives in. The deployment has no Dexcom
credentials — the default the check script, the README and the demo all run in — so the Dexcom card is on
its `!configured` branch, which is the one whose sentence this ticket changed.

The loading card (site 1) is not photographed. It is transient by nature, which is exactly how it outlived
four tickets: the comment above the patient-summary shot in `e2e/flows.spec.ts` records a loose text check
matching the spinner and the screenshot being of it. It is held by an assertion instead, and that assertion
stalls `GET /api/patient/<token>` on a promise the test resolves rather than racing it.

| File | What it shows |
|---|---|
| `desktop-connect-step-no-span.png` | The step at 1280px. The heading is **"Bring your data into focus."**, which was *"Bring the last 7 days into focus."* — the largest type on the step, rendered before a single file exists. Under the Dexcom card: **"Upload your Clarity CSV export to share your glucose readings."**, which was *"…to share your last 7 days of glucose."* The WHOOP card reads **"Sleep, recovery, and strain"**, which was *"Sleep, recovery, and strain from the past week"*. The Dexcom and Timeline descriptions are untouched and are what the WHOOP line is now parallel with: they name what is in the file and no range. |
| `mobile-connect-step-no-span.png` | The same step at 375px (§6.5), whole page. All three strings wrap inside the column with no horizontal scroll, and the Dexcom hint sits under its card on two lines. |

## Why "your data" and not a number

None of the four sites has a day count in scope and none gained one. Every source on this step is a file the
**patient** chooses the range of: Clarity exports whatever window they pick, `parseClarityCsv`
(`lib/glucose.ts`) keeps every `EGV` row it is handed, and `data/fixtures/clarity_window.csv` — 84 readings
inside one morning — is a supported upload the old sentence described wrongly. `lib/whoop.ts` clips nothing
either, and `SleepNight[]` has no span requirement. So the wording is T123's: say what sharing does, not how
much of it to expect.

`lib/dexcomHint.ts`'s OAuth branch keeps its "last 7 days" and is the one span in the module that stays. It
is a fact about what the *connection* fetches — `lib/dexcom.ts` requests
`{ start: Math.max(first, end - 7 * 86400000), end }`, pinned by `lib/dexcom.test.ts` — not a presumption
about a file the patient picks. That distinction is the rule itself, so it carries a comment saying so and
the span sweep in `lib/dexcomHint.test.ts` excludes it **by the condition that reaches it** and asserts it as
an equality, rather than skipping it and letting it drift into any span at all.

## What these frames also show, which the ticket did not list

The art column on this step reads **"Your week, / in one picture."** (`app/s/[token]/intake/page.tsx:419`).
It is in neither the ticket's four sites nor its "Out of scope, deliberately" list, so it was left alone
rather than swept up — but it is visible in both frames and worth a decision rather than another sweep. At
1280px it is now the largest text on the screen, set bigger than the heading this ticket just fixed; at
375px it is the first thing the patient reads, above the fold and above the panel. Unlike `app/page.tsx:45`
("7 days of context" on the landing page, which the ticket excluded as copy about the product), this one is
possessive and addressed to a particular patient, on a panel where they have shared nothing yet.

The new spec in `e2e/connections.spec.ts` therefore names its three strings one by one instead of sweeping
the frame for `/week/i` the way the setup-complete assertion above it does. A frame-wide negative here would
quietly settle a question nobody has ruled on.

**Settled in T136 (#207).** The decision went the way the rule points: the headline now reads "Your data, /
in one *picture.*", and `e2e/connections.spec.ts` carries the frame-wide `not.toContainText(/week/i)` over
`main` as well as the three named strings. The frames above are this screen before that change; the ones
under `docs/screenshots/tickets/t136/` are after it. Nothing on the connect step names a span any more, so
this is not a question for another sweep to re-find.
