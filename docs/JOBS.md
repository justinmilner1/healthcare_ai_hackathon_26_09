# Background jobs

Everything that is slow or can fail on its own runs as a row in `Job`, not inside the request that asked for it
(design §3.4, §4.9). Today that is Sour and the two notifications; retention and patient deletion join later.

| Kind | Enqueued by | Does |
|---|---|---|
| `sour.run` | the turn that wraps intake (`/api/sweetie`), the Generate button (`/api/sour`) | `runSour`: both summaries, visit → `summary_ready`, then queues `notify.summary` |
| `notify.invite` | adding a patient with consent (`/api/book`), Send link (`/api/invite`) | the presigned `/s/<token>` link by SMS and email |
| `notify.summary` | `runSour`, once both summaries are saved | "your summary is ready", a link each to the clinician and the patient |

Why a table and not an awaited call: two model calls and an SES round trip made a patient or a clinician wait
for something they were not reading, and a crash or a redeploy mid-request lost the work with nothing left to
say it was owed. A job row says what to do, when it may run, how often it has been tried and why it last
failed, so the work survives the process and a clinician can see where it got to.

**No payload holds PHI.** Every payload is `{ visitId }`; the handler reads the visit back. The row outlives
the request, so nothing in it may be a name, a phone number, an address or clinical text (§10.3). `lastError`
is scrubbed by the same function the logger uses.

## Who drains the queue

```
JOBS_SECRET set     -> "scheduled": something outside the app calls POST /api/jobs/run
JOBS_SECRET unset   -> "inline": the request that enqueues drains the queue after its response
JOBS_RUNNER=...     -> forces either, whatever the secret says
```

In AWS, EventBridge Scheduler calls the route once a minute with `Authorization: Bearer $JOBS_SECRET` (§3.6).
Without the secret the route answers 503 rather than falling open, because that route is public and the secret
is the whole door. Local development, the demo and the e2e suite have no scheduler, so they take the inline
path: the job row is still the unit of work, with the same attempts and the same idempotency, but the drain
happens in Next's `after()` once the response has gone out. By hand:

```bash
npm run jobs:drain              # run everything due now
npm run jobs:drain -- --list    # show the queue, run nothing
npm run jobs:drain -- --watch   # keep draining every 5s
curl -X POST localhost:3000/api/jobs/run -H "Authorization: Bearer $JOBS_SECRET"
```

## Attempts, backoff, idempotency

Three attempts (`MAX_ATTEMPTS`), waiting a minute and then five minutes between them (`BACKOFF_MS`), then the
job is `failed` with the error kept. The attempt is counted at claim time, in the same statement that marks the
row `running`, so a runner that dies mid-job spends an attempt instead of being retried forever. Two runners
never take the same row: the claim is `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.

A runner that dies does not take the job with it. The claim only ever takes `queued` rows, so each drain first
reaps any row left `running` for longer than `STUCK_AFTER_MS` (15 minutes — generously longer than any handler
takes, because reclaiming a job that is in fact still running would send the same message twice): one with
attempts left goes back on the queue after a backoff and keeps its key, and one that has spent all three is
`failed` with the key released. Without that, a redeploy or a frozen Lambda would strand the row for good —
never retried, never `failed`, and still holding the `idempotencyKey`, so every later request for the same
work would dedupe onto a job that can never finish.

`idempotencyKey` collapses duplicate work **while it is in flight**: as long as a job with that key is queued
or running, a second enqueue joins it, so a double-clicked Send link sends once and an intake that wraps while
the clinician is already pressing Generate runs Sour once. The key is released when the job reaches `done` or
`failed`, because a clinician asking later for a fresh summary, or staff resending a link an hour later, is
real new work.

That leaves the other half of §7.1 — unchanged inputs return the existing summary — to Sour, where it belongs,
because it is a question about the data and not about the queue. `lib/sourInput.ts` fingerprints what a
summary is made from (the structured intake, the notes rendered from it, the visit type and reason, and every
upload by id and row count) and `runSour` stores that fingerprint on both `Summary` rows. A later run that
hashes to the same thing returns the saved pair: no second pair of rows, no second pair of model calls, and no
second "your summary is ready" email about a summary the clinician was already told about. The fingerprint
also carries whether the narrative came from the model, so configuring `OPENAI_API_KEY` invalidates the "LLM
not configured" placeholder instead of serving it for ever; a placeholder written while a *configured* gateway
was down is stored with a null fingerprint and is never reused at all.

## Adding a kind

1. Add the name to `JOB_KINDS` in `lib/jobs.ts`.
2. Add a handler to `handlers` in `lib/jobHandlers.ts`. Throwing is how a job asks to be retried; returning is
   success. Take `{ visitId }` (or another opaque id) and read the rest from the database.
3. Enqueue it from the route that wants it, and `nudge(after)` so local development still runs it.

A kind with no handler is not silently dropped: the job fails with `no handler for job kind ...`, three times,
and the reason is on the row.

## Where to look when something did not happen

`npm run jobs:drain -- --list` first: the status, the attempt count and `lastError` of each row say whether the
work was queued, is waiting out a backoff, or gave up. The log lines are `job_enqueued`, `job_deduped`,
`job_done`, `job_retry`, `job_failed` and `sour_reused`, each with `jobId` and `kind` (docs/LOGGING.md).

The clinician sees the same state without a terminal (§7.2). `GET /api/patient/[id]` carries the newest
`sour.run` job for the visit (`latestJobForVisit`, read back through the payload because the idempotency key
is released exactly when the state gets interesting), `lib/sourState.ts` turns it into the chip under the
brief header — queued, running, failed with the reason, ready, or out of date — and the retry on a failed job
posts to `/api/sour` again, which is new work because the failure released the key.
