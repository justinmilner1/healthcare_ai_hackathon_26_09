# T13 — structured logging with a PHI allow-list

T13 changes no screen. These are the six screens the e2e suite captures on this branch, every one of them
fed by API routes that now go through `withRoute`; they are here to show that wrapping the routes changed
nothing a patient or a clinician sees.

| File | Screen |
|---|---|
| `desktop-landing.png` | `/` |
| `desktop-provider-dashboard.png` | `/provider` (via `/demo`) |
| `desktop-provider-sour.png` | `/provider/<id>` |
| `desktop-sweetie-start.png` | `/s/<token>` on open |
| `desktop-sweetie-done.png` | `/s/<token>` after intake wraps |
| `desktop-patient-summary.png` | `/patient/<token>` |

Retaken in review after `main` was merged into this branch, so they come from the production-build server and
from the e2e waits T01 fixed: every screen here is loaded rather than a shell. `desktop-patient-summary.png`
is the loaded empty-data card, which is correct for the E2E patient — it has no uploads. The earlier set, taken
before that merge, caught the dashboard and the summary mid-fetch.

## What the logs actually look like

The real deliverable is not a screen. Booking a patient called **Jane Doe**, with the email
`jane.doe@example.com`, the phone `+1 415 555 0132` and the reason *"mornings running high"*, then sending
Sweetie the message *"Burrito at Chipotle Tuesday, felt dizzy after. Reach me at 415-555-0132."*, then a
failed and a successful Dexcom upload, then a request with a bad token, produces exactly this:

```json
{"time":"2026-10-10T20:47:39.510Z","level":"info","event":"request","requestId":"ad78c170-1b60-4b57-ad28-2bd38455b47d","route":"GET /api/health","method":"GET","status":200,"durationMs":132}
{"time":"2026-10-10T20:47:54.349Z","level":"info","event":"request","requestId":"8b43aba1-901e-42d9-82dd-3242941bfd48","route":"GET /api/provider","method":"GET","status":200,"durationMs":8}
{"time":"2026-10-10T20:47:57.836Z","level":"info","event":"patient_created","requestId":"cb8eefd6-da8c-4d36-919c-d1300d50a0b2","route":"POST /api/book","patientId":"cmv2v8w2d00017dyqoi71y9pu","providerId":"cmv2v3ne600007daiblxlczm4","visitType":"follow_up"}
{"time":"2026-10-10T20:47:57.838Z","level":"info","event":"invite_sent","requestId":"cb8eefd6-da8c-4d36-919c-d1300d50a0b2","route":"POST /api/book","patientId":"cmv2v8w2d00017dyqoi71y9pu","channel":"sms","sent":false,"error":"SMS not configured (set Twilio or AWS keys)"}
{"time":"2026-10-10T20:47:57.838Z","level":"info","event":"invite_sent","requestId":"cb8eefd6-da8c-4d36-919c-d1300d50a0b2","route":"POST /api/book","patientId":"cmv2v8w2d00017dyqoi71y9pu","channel":"email","sent":false,"error":"email not configured (set RESEND_API_KEY or AWS keys)"}
{"time":"2026-10-10T20:47:57.839Z","level":"info","event":"request","requestId":"cb8eefd6-da8c-4d36-919c-d1300d50a0b2","route":"POST /api/book","method":"POST","status":200,"durationMs":68}
{"time":"2026-10-10T20:47:58.892Z","level":"info","event":"request","requestId":"61906556-cdab-44bd-8be0-c30abf62a98e","route":"POST /api/sweetie","method":"POST","status":200,"durationMs":35}
{"time":"2026-10-10T20:47:59.661Z","level":"warn","event":"upload_empty","requestId":"0a8115ac-0778-418b-89f2-4ecf47da9afc","route":"POST /api/upload","patientId":"cmv2v8w2d00017dyqoi71y9pu","kind":"dexcom","bytes":9}
{"time":"2026-10-10T20:47:59.662Z","level":"info","event":"request","requestId":"0a8115ac-0778-418b-89f2-4ecf47da9afc","route":"POST /api/upload","method":"POST","status":422,"durationMs":10}
{"time":"2026-10-10T20:47:59.729Z","level":"info","event":"upload_stored","requestId":"7a0d9ac2-1b12-4f61-ac6f-9ba6c9b4f43e","route":"POST /api/upload","patientId":"cmv2v8w2d00017dyqoi71y9pu","uploadId":"cmv2v8xk600077dyqnl3fowpz","kind":"dexcom","rows":2016,"bytes":138371}
{"time":"2026-10-10T20:47:59.745Z","level":"info","event":"request","requestId":"7a0d9ac2-1b12-4f61-ac6f-9ba6c9b4f43e","route":"POST /api/upload","method":"POST","status":200,"durationMs":46}
{"time":"2026-10-10T20:47:59.792Z","level":"info","event":"request","requestId":"a7ebf280-0b58-437a-9148-f6010a5e7e3b","route":"GET /api/sweetie","method":"GET","status":404,"durationMs":3}
```

Not one of those names, numbers, addresses, or words appears anywhere in the server's output: a grep for
`Jane|Doe|jane.doe|example.com|555|0132|Chipotle|dizzy|burrito|mornings running high` over the whole log
returns nothing. Every line of one request shares a `requestId`, and the client got that same id back in the
`x-request-id` response header.

See `docs/LOGGING.md` for the allow-list, the scrubbing rules, and how these lines reach CloudWatch.
