# T65 — the mailbox walk that could not be read

T65 changes no screen. It changes who throws when a file in the local mailbox moves: `e2e/patient.ts`'s
`latestCode` read a listed name with no guard while `e2e/auth.ts` was renaming sign-in mails out of the same
directories, so an ENOENT over somebody else's message failed a spec that was only waiting for a six-digit
code. So the evidence is in two parts: the race, run on purpose in a unit test, and the screens these helpers
drive, showing that the suite still gets through both doors.

## The race, run on purpose

`lib/devMailbox.test.ts` does not wait for the race — it stages it. `findDevMail` lists every name before it
reads any of them, so a `pick` callback invoked on the first message can claim a later one, exactly as
`claimSignInLink` does, and the walk then reaches a name whose file has gone:

```
ok 1 - a mail claimed between the listing and the read is skipped, and the walk goes on to find the code (T65)
ok 2 - a mail that vanishes reads as absent, not as an error
ok 3 - readDevMail returns the mail it can read instead of throwing on the one it cannot
ok 4 - the newest addressed mail wins, across every mailbox the walk is given
ok 5 - an address is not a pattern, and a walk that finds nothing says so
```

Against the unguarded read these are the ticket's own failure, three times over:

```
error: "ENOENT: no such file or directory, open '/tmp/devmail-walk-gEmrn5/2026-10-15T15-53-32-874Z-your-sweet-spot-sign-in-link.txt'"
# tests 5
# pass 2
# fail 3
```

`devMailbox.ts` finishes the run at 97.83% of lines and 100% of functions in the §12.1 coverage table.

## The screens, unchanged

From the `bash scripts/agent-check.sh` run that landed this ticket on `main` (178 passed, 6 skipped, 5.5m). Each of
these is a screen that only appears if one of the two readers found its message, which is why they are the
ones worth looking at for a ticket about reading the mailbox.

| File | What it shows |
|---|---|
| `desktop-provider-signin.png` | the sign-in form, where the mail `claimSignInLink` renames is sent from |
| `desktop-provider-dashboard.png` | the dashboard a claimed single-use link opened, 17 visits |
| `desktop-verify-code.png` | the code screen `latestCode` feeds (§5.3) |
| `desktop-verify-done.png` | the code accepted, the patient through to Sweetie |
| `mobile-journey-05-verify-code.png` | the same code screen inside the §12.2 journey, at phone width |

Things visible in them that are open bugs owned by other tickets, not regressions here: Sweetie saying the
upload button is "on the left" (T53) and the dashboard's `Date pending` rows (T67).
