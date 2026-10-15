# T32 — demo mode practices

Design §13.4: "a flag on a practice that marks it synthetic; demo practices are excluded from retention
sweeps and alarms and are never emailed real addresses."

Two of the three have a screen, and both are here. The sweep is nightly and has no screen at all — it is
asserted in `lib/retentionStore.test.ts` against a real database — and the alarm label is a field on a log
line, asserted in `lib/demo.test.ts` and `lib/log.test.ts` and documented in `docs/LOGGING.md`.

| File | What it shows |
|---|---|
| `desktop-provider-settings-demo.png` | the seeded practice's settings: the `DEMO PRACTICE — SYNTHETIC DATA` pill under the name, and the note inside the practice card saying what the flag changes. The flag is read-only — there is no control that sets it, because an admin turning it on would be turning their own retention sweep off |
| `mobile-provider-settings-demo.png` | the same at 375px: pill and note both fit, nothing overflows |
| `desktop-provider-dashboard-demo-messages.png` | §13.4's address rule as staff see it. Two visits booked into the demo practice: `+1 650 555 2345` is a number that could be somebody's, so its invite is `TEXT –` (skipped) with *Demo practice: only test addresses are messaged* under it; `+1 650 555 0135` is in the NANP's fictitious range, so its invite is attempted like any other (`TEXT …` queued, `TEXT ✕` where this sandbox's ambient AWS credentials made SNS refuse it) |
| `mobile-provider-dashboard-demo-messages.png` | the same rows at 375px |
| `desktop-demo-signed-in.png` | `GET /demo` with `DEMO_SIGN_IN=1` (the e2e server on port+4): the dashboard, signed in as the seeded demo provider, with no link to read out of a mailbox. Auth.js does the signing in — the link is minted instead of emailed, and is one-use like any other |
| `mobile-demo-signed-in.png` | the same at 375px |

The two dashboard shots are viewport rather than full page: a `fullPage` shot of the dashboard is ~20,000
pixels tall on the phone profile and shows a reviewer nothing, which is the open bug T57. The row the test
booked is scrolled to the middle of the screen instead.
