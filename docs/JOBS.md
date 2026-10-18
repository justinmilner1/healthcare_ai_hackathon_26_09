# Background jobs

Everything that is slow or can fail on its own runs as a row in `Job`, not inside the request that asked for it
(design §3.4, §4.9). Today that is Sour, the three notifications, the nightly retention sweep and patient
deletion.

| Kind | Enqueued by | Does |
|---|---|---|
| `sour.run` | the turn that wraps intake (`/api/sweetie`) when the readings are in, a completed Dexcom import (`/api/dexcom/callback`, or a Clarity export through `/api/upload`) when the intake is done, the Generate button (`/api/sour`) | `runSour`: both summaries, visit → `summary_ready`, then queues `notify.summary` |
| `notify.invite` | adding a patient with consent (`/api/book`), a CSV import (`/api/visits/import`), Send link (`/api/invite`) | the presigned `/s/<token>` link, on the channels the visit consented to (§2.2); what each channel did is recorded on the visit (§8.3) |
| `notify.code` | opening a patient link (`/api/verify`), and the Resend button on the code screen | the six-digit verification code by SMS and email (§2.3, §5.3). The code is minted *by the handler*, so the payload is a visit id and the plaintext is stored nowhere |
| `notify.summary` | `runSour`, once both summaries are saved | "your summary is ready", a link each to the clinician and the patient |
| `patient.delete` | the Delete data button on the dashboard (`/api/deletion`) | §10.5: one patient's data end to end — every visit, the stored objects behind their uploads, their Dexcom tokens, and their own name and contact details. Payload `{ patientId, requestedBy }`, and the audit row names the person who asked |
| `retention.sweep` | the runner itself, once in twenty hours (`scheduleRetentionSweep`) | §10.4: every practice's visits past its own `retentionDays` lose their intake, notes, messages, uploads and summaries. The `Visit` row stays, marked `retentionSweptAt`. Then §10.5's leftovers: every prefix on `StorageOrphan` is asked about again (T70). Payload is empty, or `{ practiceId }` to sweep one practice |

Why a table and not an awaited call: two model calls and an SES round trip made a patient or a clinician wait
for something they were not reading, and a crash or a redeploy mid-request lost the work with nothing left to
say it was owed. A job row says what to do, when it may run, how often it has been tried and why it last
failed, so the work survives the process and a clinician can see where it got to.

**Who queues Sour, and when (§7.1).** The Generate button queues whatever the state is — a clinician asked
for it. The two patient-side triggers are each other's mirror image, and `lib/sourQueue.ts` holds both the
idempotency key and the rule: the wrapping turn queues a run when the visit already has Dexcom data, and a
completed import queues one when the intake is already done. A summary needs both halves and either can be
the last to arrive, so whichever lands second is the one that queues — exactly once, with no trigger needing
to know about the other. Data that arrives mid-intake queues nothing: summarizing there would write a brief
from half an interview, move the visit to `summary_ready` while the patient is still answering, and email the
clinician about a summary the wrapping turn is about to replace. An import also deletes the visit's saved
summaries, which is a separate promise — never show an older narrative against newly imported readings — and
the queued run is what puts a current one back without a clinician opening the page to pay for it.

**No payload holds PHI.** Every payload is `{ visitId }` — or, for `patient.delete`, a patient id and the
opaque user id of whoever asked; the handler reads the rest back. The row outlives the request, so nothing in
it may be a name, a phone number, an address or clinical text (§10.3). `lastError` is scrubbed by the same
function the logger uses.

**Where "nightly" comes from.** §3.4 gives the app one clock: EventBridge calling `POST /api/jobs/run` every
minute. That route asks `scheduleRetentionSweep` on every tick, which queues a `retention.sweep` only if none
has been queued in the last twenty hours — so the sweep is nightly with no second schedule to create, and an
environment without one still sweeps. The guard is the last sweep's `createdAt` and not its idempotency key,
because the key is released the moment the job finishes, which for this job is seconds later.
`npm run jobs:drain` asks the same thing, so a local database sweeps when somebody drains the queue.

**Deleting is idempotent, and the bytes go by prefix.** Both deletion jobs can be retried, which §3.4 will do
three times: the sweep skips what it has marked, and the purge works from whatever is still there and reports
nothing when there is nothing left. Stored objects are deleted by prefix (`visits/<visitId>/`) rather than by
the keys on the `Upload` rows, because an object whose row a half-finished earlier attempt already removed
would otherwise be invisible and stay for ever.

**A prefix the store refuses is written down, because the rows that named it are about to go.** `purgePatient`
deletes the `Visit` seconds after its objects, and `visits/<visitId>/` is built from that id — so a refusal
that was only counted was a prefix nothing could name again, and the job finished successfully with bytes
still in the bucket. Every refusal now lands on `StorageOrphan` before the rows do, keyed by the prefix.
`retention.sweep` walks that ledger nightly, which is the pass that needs nobody, and `patient.delete` walks
the patient's own part of it — so a retry of that job reaches the object store rather than finding
`patient.visits` empty and returning. A prefix that comes
back empty leaves the ledger; one refused again stays with `attempts` one higher (`docs/RUNBOOK.md`).

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
also carries whether the narrative came from the model, so configuring `OPENAI_API_KEY` invalidates the
numbers-only pair an unconfigured deployment saves instead of serving it for ever; a pair written while a
*configured* gateway was down is stored with a null fingerprint and is never reused at all. Neither of those
pairs carries a sentence for the reader: the patterns and questions are simply empty and the reason rides on
`Summary.narrativeMissing`, which the provider page and the printed sheet show as state (T63, §6.3, §11.3).

## Adding a kind

1. Add the name to `JOB_KINDS` in `lib/jobs.ts`.
2. Add a handler to `handlers` in `lib/jobHandlers.ts`. Throwing is how a job asks to be retried; returning is
   success. Take `{ visitId }` (or another opaque id — `patient.delete` takes a patient id, `retention.sweep`
   takes nothing) and read the rest from the database.
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
