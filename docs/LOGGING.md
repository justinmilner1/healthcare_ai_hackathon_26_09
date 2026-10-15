# Logging

Fulfils design §10.3 (logging hygiene) and §11.1 (structured JSON logs to CloudWatch with request ids).

Application logs carry no names, phone numbers, email addresses, chat messages, summaries, visit reasons, or
link tokens. Reads of patient data are not recorded here at all; that is the audit log's job (§10.2, T12) — see docs/AUDIT.md.

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
- turns an `HttpError` (`lib/httpError.ts`) into the response the guard asked for and writes the access line
  at `warn` under the guard's own event name instead of `request` — `request_unauthenticated`,
  `request_forbidden`, `visit_not_in_practice`, `user_not_in_practice`. There is still exactly one access line
  per request; a refusal is an answer the route meant to give, not a crash, so no `request_failed` and no
  stack. The alarm for a burst of refusals keys off those event names;
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
`bytes`, `attempt`, `sent`, `provider`, `channel`, `model`, `role`, `capability`, …), and scrubbed failures
(`error`, `stack`, `code`).

`role` and `capability` are there for the refusal lines above. Both are closed vocabularies out of
`lib/access.ts` — one of three role names, one of seven capability names — so neither can carry a person's
anything; a guard's other fields (`userId`, `practiceId`) are opaque ids, and an address passed to one is
dropped by name like anywhere else.

`demo` is §13.4's label: `true` on a line this request or job could attribute to a practice marked `isDemo`,
and absent everywhere else. It is a boolean about a practice, not about a person, and it exists so the alarm
filters can leave synthetic work out — see **How CloudWatch receives these logs** below for the filters and
for where the flag is set.

`scope`, `limit` and `retryAfter` are there for the `rate_limited` line a refused public route writes
(§5.4, `lib/ratelimit.ts`): which key was spent — `ip` or `visit`, a two-word vocabulary — the ceiling, and
the seconds until the window resets. The **address is not a field and must not become one.** An IP identifies
a person about as well as a phone number does, so what the log says is that an address-keyed window was spent,
which is all an alarm on a flood needs; the visit id beside it is an opaque id like any other.

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
  a hostile `x-request-id` (`Jane Doe`, an address, a phone number) is replaced by a fresh UUID, that a
  guard's 403 is one `warn` access line with the role and capability and no address on it, and — by
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
- **Demo practices are excluded from the alarms** (§13.4), and this is where that exclusion lives. There is
  nothing in CloudWatch an application can exempt itself from, so the app *labels* instead: every line it can
  attribute to a practice marked `isDemo` carries `demo: true`. Each of §11.1's three alarm filters adds
  `$.demo NOT EXISTS` — so job failures become `{ $.event = "job_failed" && $.demo NOT EXISTS }`, and the 5xx
  and model-failure filters likewise. The filters themselves are in `infra/lib/sweetspot-stack.ts` (`alarms()`)
  and `infra/test/stack.test.ts` asserts them. A synthetic visit whose summary run fails then wakes nobody,
  while the same failure in a real practice still does.

  The one alarm that still counts a demo practice's lines is `llm_circuit_opened`: the model circuit is one
  per process rather than one per practice, so whichever request tripped it, every patient on the deployment
  is now reading scripted replies (§6.3, §11.3). Excluding it would hide a real outage behind a synthetic
  visit.

  The label rides the request rather than the call site (`markDemo` in `lib/log.ts`, reached through
  `markDemoPractice` wherever a practice row is in hand), which is what gets it onto the lines no demo-aware
  code writes: `request_failed` comes from
  `withRoute` and `job_failed` from the job runner, and neither has a practice in hand. One call at the point
  a practice *is* in hand covers everything after it — `lib/visit.ts`, which every patient route and every
  visit-shaped job resolves a visit through, the two job handlers that have no visit, and `lib/teamStore.ts`.
  Each job is drained inside its own child context (`runInChildContext`), so one demo visit's label stops at
  the end of its own job instead of marking everything else in that drain.

  What is *not* labelled is a line from a request that never touched a practice — an unauthenticated 500 on a
  public page, say. Those are counted, which is the right way round: the point of the exclusion is that
  synthetic data does not page anyone, not that a deployment stops reporting what is broken.
- **Local development.** The same lines go to the terminal. `npm run dev | npx pino-pretty` is a convenient
  reader, but nothing in the app depends on it.

To follow one request end to end, take the `x-request-id` from the response and run, in CloudWatch Logs
Insights:

```
fields @timestamp, level, event, status, durationMs
| filter requestId = "f1c2…"
| sort @timestamp asc
```
