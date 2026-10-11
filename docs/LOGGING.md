# Logging

Fulfils design §10.3 (logging hygiene) and §11.1 (structured JSON logs to CloudWatch with request ids).

Application logs carry no names, phone numbers, email addresses, chat messages, summaries, visit reasons, or
link tokens. Reads of patient data are not recorded here at all; that is the audit log's job (§10.2, T12).

## The shape of a line

One JSON object per line, on stdout for `debug`/`info` and stderr for `warn`/`error`:

```json
{"time":"2026-10-10T18:04:11.902Z","level":"info","event":"upload_stored","requestId":"f1c2…","route":"POST /api/upload","patientId":"ckx…","uploadId":"cl0…","kind":"dexcom","rows":2016,"bytes":184233}
{"time":"2026-10-10T18:04:12.004Z","level":"info","event":"request","requestId":"f1c2…","route":"POST /api/upload","method":"POST","status":200,"durationMs":338}
```

Never more than one line per event, and never a multi-line value: CloudWatch treats each line as one event,
and a stack trace split across lines becomes unsearchable.

## How to log

```ts
import { log, withRoute } from "@/lib/log";

async function postHandler(req: Request) { … }
export const POST = withRoute("POST /api/upload", postHandler);

log.info("upload_stored", { patientId, uploadId, kind, rows: parsed.length });
log.error("sour_chat_failed", { visitId, error: e });
```

`withRoute` wraps every route under `app/api/**` and `app/demo`. It:

- reuses the caller's `x-request-id` only when it is already the shape we mint — a UUID — and otherwise
  mints a fresh one (see **A caller cannot write to your logs** below);
- puts that id in an `AsyncLocalStorage` context, so every `log.*` call made anywhere inside the request
  carries `requestId` and `route` without being passed them;
- writes one `request` line with the method, status, and duration when the handler returns, or a
  `request_failed` line when it throws;
- returns the id to the client as `x-request-id`, which is the thing a support request quotes.

A unit test asserts that every `route.ts` goes through it.

## The allow-list

`ALLOWED_FIELDS` in `lib/log.ts` is the complete set of field names that reach the log. Anything else is
dropped, and only the *name* appears, under `droppedFields`:

```ts
log.info("invite_sent", { patientId: "p_1", name: "Jane Doe", email: "jane@example.com" });
// {"event":"invite_sent","patientId":"p_1","droppedFields":["email","name"]}
```

So a mistake costs a missing field in a dashboard, not a disclosure, and the drop is visible rather than
silent. The list holds request plumbing (`requestId`, `route`, `method`, `status`, `durationMs`), opaque
database ids (`patientId`, `visitId`, `uploadId`, `jobId`, …), operational facts (`kind`, `count`, `rows`,
`bytes`, `attempt`, `sent`, `provider`, `channel`, `model`, …), and scrubbed failures (`error`, `stack`,
`code`).

Two rules for changing it:

- **Never add** a field that can hold a name, a phone number, an email address, a patient message, a summary,
  a visit reason, or a link token. A test fails on those names, and on duplicates.
- Database ids are fine. They are meaningless without the database, and they are what ties a log line to the
  audit record for the same event.

### A caller cannot write to your logs

`requestId` is allow-listed, and the `x-request-id` header is client-controlled, so it is the one field
through which a stranger's text could ride into a log line — once, then on *every* line of that request.
Stripping punctuation is not enough: `Jane Doe` survives as `JaneDoe`, and a phone number is already
hex-clean. So a caller's id is reused only when it matches the UUID shape the app itself mints, and anything
else is discarded in favour of a fresh one. Correlating a request across services costs the caller one UUID.

The same reasoning applies to any value that arrives as free text in a request body. `POST /api/book` takes
`visitType` as an unvalidated string, so the booking log passes it through `knownVisitType()` first, which
returns one of the ids in `VISIT_TYPES` or `"other"`. And `loadSourContext()` accepts either a patient id or a
link token, so the Sour route logs the *resolved* `patient.id`, never the string the caller sent. Before
adding a field, ask where its value comes from: an allow-listed name on an attacker-controlled value is not a
protection.

### Scrubbing

`error` and `stack` are free text, so they go through `scrub()`, which replaces email- and number-shaped
substrings with `[email]` and `[number]` and caps the length. That is what makes it safe to log a Prisma or
SES error that quotes the address it failed on.

One exception: identifiers are written through unchanged. `scrub()` reads a run of digits and hyphens as a
phone number, which corrupts them — it mangled one minted `requestId` in four (`d1e1ec17-9580-4837-8dc0-…`
came out as `d1e1ec[number]dc0-…`, which no longer matched the `x-request-id` the caller was handed) and
about one database id in 6,100 the same way, so the query at the bottom of this page returns nothing for
those requests and a mangled `patientId` points at no patient. An identifier carries nothing to take out, so
the fields in `ID_FIELDS` — `requestId` and the database ids — skip scrubbing *when the value is one of the
two formats this app mints*: a Prisma cuid (`c` plus 24 lowercase alphanumerics) or the UUID
`requestIdFrom` enforces. Anything else in one of those fields is scrubbed as usual.

The narrowness is the point. A charset check would have been enough to protect the ids, but `415-555-0132`
and `4155550132` are made of identifier characters too, so a future lookup that logged an unresolved id
straight from a request body would have printed a phone number that `scrub()` redacts today. Neither format
above can be a phone number. When you add an id field, add its format here rather than widening the pattern.

## Enforcement

- `npm run lint` fails on `console.*` anywhere in `app/`, `lib/`, or `components/` (`no-console` in
  `eslint.config.mjs`). `lib/log.ts` is the one exemption, plus tests and the developer-only scripts in
  `scripts/` and `e2e/`, which never see production data.
- `npm test` (`lib/log.test.ts`) asserts that non-allow-listed fields are dropped, that `scrub` removes
  addresses and numbers, that the allow-list holds no PHI-shaped field name, that request ids propagate, that
  a hostile `x-request-id` (`Jane Doe`, an address, a phone number) is replaced by a fresh UUID, and — by
  scanning the source — that no application file calls `console.*` or writes to `process.stdout` directly.
  `lib/sweetie.test.ts` covers `knownVisitType`.

## How CloudWatch receives these logs

Nothing in the app ships logs. Writing to stdout and stderr is the whole integration:

- **Production and staging.** The app runs on Amplify Hosting's SSR compute (§3.1). Amplify forwards whatever
  the server process writes to stdout/stderr to CloudWatch Logs in the same AWS account, under the log group
  Amplify creates for the app (`/aws/amplify/<appId>`), one stream per compute instance. No agent, no log
  driver, no `CloudWatchLogsClient` in the request path — which also means a CloudWatch outage cannot fail a
  request.
- **Retention and alarms** are set on that log group by the CDK stack (§3.6, T29/T30), not by the app.
- **Alarms** (§11.1) read these logs as metrics. Because every line is JSON with a stable `level` and `event`,
  CloudWatch metric filters key off the fields directly, e.g. 5xx rate from
  `{ $.event = "request" && $.status >= 500 }`, job failures from `{ $.event = "job_failed" }`, model timeout
  rate from `{ $.event = "model_timeout" }`. Those filters and their SNS topic belong to the infrastructure
  tickets; this document is the contract they rely on.
- **Local development.** The same lines go to the terminal. `npm run dev | npx pino-pretty` is a convenient
  reader, but nothing in the app depends on it.

To follow one request end to end, take the `x-request-id` from the response and run, in CloudWatch Logs
Insights:

```
fields @timestamp, level, event, status, durationMs
| filter requestId = "f1c2…"
| sort @timestamp asc
```
