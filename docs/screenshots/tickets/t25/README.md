# T25 — fixtures and unit tests for every lib module

T25 changes no screen. It adds `data/fixtures/`, unit tests for the `lib/` modules design §12.1 names, and a
coverage table in the check script's output. The only non-test change is in `lib/notify.ts`, where the four
message bodies moved out of the send functions into pure template builders so a test can read them; what goes
on the wire is unchanged. These six screens are the whole e2e capture on this branch, here to show that.

| File | Screen |
|---|---|
| `desktop-landing.png` | `/` |
| `desktop-provider-dashboard.png` | `/provider` (via `/demo`) |
| `desktop-provider-sour.png` | `/provider/<id>` |
| `desktop-sweetie-start.png` | `/s/<token>` on open |
| `desktop-sweetie-done.png` | `/s/<token>` after intake wraps |
| `desktop-patient-summary.png` | `/patient/<token>` |

Both flows run end to end: the dashboard lists the seeded patient with its data chips, Sweetie asks the first
question and reaches "Your check-in is complete" at 100%, and the patient summary loads its empty-data card,
which is right for the E2E patient — it has no uploads. `desktop-provider-sour.png` is the "Select a patient
summary" state for the same reason: the e2e run creates no summary. Both match the T13 set.

Two things in these shots are open bugs on `main`, not this branch's doing: the dashboard's VISIT column and the
patient summary's first chip both print the visit type's id (`follow_up`) instead of its label, which is #44.

## What the deliverable actually looks like

The real output is the unit step. `bash scripts/agent-check.sh` on this branch:

```
== unit
> sweetspot@0.1.0 test:coverage
...
# tests 98
# pass 98
# fail 0
# start of coverage report
# -----------------------------------------------------------------------------------
# file         | line % | branch % | funcs % | uncovered lines
# -----------------------------------------------------------------------------------
# lib          |        |          |         |
#  dexcom.ts   |  84.82 |    95.08 |   75.76 | 30 53-68
#  email.ts    |  72.88 |    86.21 |   81.25 | 17-18 40-44 51-59
#  glucose.ts  |  98.26 |    96.30 |  100.00 | 83-84
#  llm.ts      |  61.19 |    85.71 |   53.33 | 22-23 39-43 46-48 50-65
#  location.ts |  98.80 |    90.16 |  100.00 | 38
#  log.ts      |  96.10 |    90.77 |   87.88 | 56-60 109-111
#  match.ts    | 100.00 |    95.65 |  100.00 |
#  notify.ts   |  86.11 |    89.29 |   70.59 | 14-15 56-64 69-72 92-95 101
#  sleep.ts    | 100.00 |    97.14 |  100.00 |
#  sms.ts      |  73.77 |    86.21 |   81.25 | 18-20 47 50-61
#  sour.ts     |  96.96 |    88.55 |   93.62 | 29-31 160-162 226-228
#  sweetie.ts  |  69.18 |    85.98 |   83.02 | 32-33 129-155 182-241 245 249 254-256
# -----------------------------------------------------------------------------------
# all files    |  86.10 |    90.51 |   86.14 |
# -----------------------------------------------------------------------------------
# end of coverage report
```

The five modules this ticket is about — glucose, location, match, sleep, sour — are at 97% of lines or better.
What is left uncovered elsewhere is the half of each module that talks to something outside the process: the
Twilio, SNS, SES and Resend calls in `sms.ts` and `email.ts`, the Bedrock call in `llm.ts`, and the two model
calls (`extract`, `speak`) in `sweetie.ts`. Those belong to the e2e suite and to T26, not to a unit test with a
stubbed network. `bundle.ts`, `db.ts` and `sourRun.ts` need a database and have no row in the table because no
unit test imports them; the e2e suite covers them through the routes.

See `data/fixtures/README.md` for what each fixture holds and why.
