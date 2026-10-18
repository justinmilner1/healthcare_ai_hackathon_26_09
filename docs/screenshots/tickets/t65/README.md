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
ok 3 - a message that is there but will not open is news, not a claim
ok 4 - readDevMail returns the mail it can read instead of throwing on the one it cannot
ok 5 - the newest addressed mail wins, across every mailbox the walk is given
ok 6 - an address is not a pattern, and a walk that finds nothing says so
```

Put the guard back the way it was — a bare `readFileSync` in `readDevMailFile` — and three of the six are
the ticket's own failure, verbatim:

```
not ok 1 - a mail claimed between the listing and the read is skipped, and the walk goes on to find the code (T65)
  error: "ENOENT: no such file or directory, open '/tmp/devmail-walk-BeER7a/2026-10-15T15-53-32-874Z-your-sweet-spot-sign-in-link.txt'"
# tests 6
# pass 3
# fail 3
```

Test 3 is the one that passes either way and is the reason the guard is narrow: ENOENT is a claim, and
anything else — a mailbox that is there and will not open — still throws, because answering "claimed" to it
would hand a caller an older credential in silence.

`devMailbox.ts` finishes the run at 100.00% of lines, 100.00% of functions and 90.32% of branches in the
§12.1 coverage table.

## The screens, unchanged

From the `bash scripts/agent-check.sh` run that landed this ticket on `main` (187 passed, 7 skipped, 6.7m). Each of
these is a screen that only appears if one of the two readers found its message, which is why they are the
ones worth looking at for a ticket about reading the mailbox.

| File | What it shows |
|---|---|
| `desktop-provider-signin.png` | the sign-in form, where the mail `claimSignInLink` renames is sent from |
| `desktop-provider-dashboard.png` | the dashboard a claimed single-use link opened, 17 visits |
| `desktop-verify-code.png` | the code screen `latestCode` feeds (§5.3) |
| `desktop-verify-done.png` | the code accepted, the patient through to Sweetie |
| `mobile-journey-05-verify-code.png` | the same code screen inside the §12.2 journey, at phone width |

Visible in them and owned by another ticket, not a regression here: the dashboard's `Date pending` rows
(T67, #108). T53's "on the left" is gone from the greeting in `desktop-verify-done.png` — that ticket closed
between the branch's shots and these.
