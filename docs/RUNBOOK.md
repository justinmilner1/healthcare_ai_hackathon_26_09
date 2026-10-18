# Runbook

What to do, step by step, when a deployment needs something done to it. Design §13.5 names the procedures this
page owes, and they are all here:

| Procedure | Section |
|---|---|
| Deploy | [Deploy to production](#deploy-to-production) |
| Rollback | [Rolling back](#rolling-back) |
| Rotate a secret | [Rotate a secret](#rotate-a-secret) |
| Restore a backup | [Restore a backup](#restore-a-backup) — the procedure itself is `docs/BACKUPS.md` |
| Handle a bounce | [Handle a bounce or a complaint](#handle-a-bounce-or-a-complaint) |
| Handle a deletion request | [Handle a deletion request](#handle-a-deletion-request) |
| What each alarm means | [What each alarm means](#what-each-alarm-means) |

Setting a deployment up for the first time is `docs/DEPLOY.md`. This page assumes it exists already. Owner: ops.

## The two deployments

| | Staging | Production |
|---|---|---|
| Stack | `SweetSpot-staging` | `SweetSpot-production` |
| Context | `sweetspot:staging` in `infra/cdk.json` | `sweetspot:production` |
| Deploys when | a merge lands on `main` (§13.2) | the `release` branch moves to a `v*` tag (§13.3) |
| Branch written by | everybody, through pull requests | `.github/workflows/release.yml`, and nothing else |
| Database | single-AZ, `db.t4g.micro`, rebuildable | multi-AZ, `db.t4g.medium`, deletion protection on |
| Logs kept | 30 days | 90 days |
| Backups | 7 days of automated RDS backups | 7 days of automated RDS backups (§11.4) |
| Backup window | 07:00-07:30 UTC, maintenance `sun:08:00-sun:09:00` | the same; restoring is `docs/BACKUPS.md` |

Both are the same stack class with the same build, so what is true of a staging deploy is true of a production
one. Everything that differs is in `infra/lib/stage.ts`. Every command below takes `STAGE`, and **staging is
where you rehearse the ones you have not done before** — a rotation, a restore, a deletion.

The names things have: the stack is `SweetSpot-<stage>`, everything inside it is prefixed
`sweetspot-<stage>-`, the SSM parameters live under `/sweetspot/<stage>/`, the alarm topic is
`sweetspot-<stage>-alarms` and the app's logs are in `/aws/amplify/<appId>`.

## Deploy to production

A production deploy is a tag. Nothing else deploys, and nobody pushes to `release` by hand.

```bash
git fetch origin && git checkout main && git pull   # the commit you are releasing must be on main
npm run typecheck && npm run lint && npm test       # or just read the green ci run on the commit
git tag -a v1.5.0 -m "Sweet Spot v1.5.0"
git push origin v1.5.0
```

Pushing the tag runs `.github/workflows/release.yml`, which:

1. refuses anything that is not a `v*` tag;
2. refuses a tag whose commit is not on `main` — a release is a merged commit, never a side branch;
3. refuses a commit where `ci` ran and failed (a commit where `ci` never ran at all is a warning in the run's
   summary, not a refusal. Since T47 every commit on `main` is checked — `auto-merge` dispatches `ci` after it
   merges, and an hourly sweep catches a dispatch that did not happen — so that warning now means something
   went wrong with the dispatch, not that this is normal. If you see it, look at the commit before you trust
   the release);
4. points `release` at that commit.

Amplify is watching `release`, so that push is the deploy. The build is the pre-deploy step: `npm ci`, this
stage's parameters out of SSM into `.env.production`, `npx prisma migrate status`, `npx prisma migrate deploy`,
`npm run config:check -- --production`, then `npm run build`. **A failure anywhere in there fails the build and
leaves the version that is already serving in place.** Watch it in the Amplify console, or:

```bash
aws amplify list-jobs --app-id "$APP_ID" --branch-name release --max-results 5
```

Then check it the way §11.2 asks:

```bash
APP_URL=$(aws ssm get-parameter --name /sweetspot/production/APP_URL --query Parameter.Value --output text)
APP_URL=$APP_URL npm run health:check     # database, uploads bucket, model gateway
```

### Rolling back

A rollback is a redeploy of the previous tag (§13.3). The release run's summary names it; `git tag --list 'v*'
--sort=-v:refname | head -2` is the other way to find it.

- GitHub → Actions → **release** → *Run workflow* → tag `v1.4.2`.
- Or: `gh workflow run release.yml -f tag=v1.4.2` (needs a GraphQL-capable host — from the agents' sandbox use
  `gh api -X POST repos/<owner>/<repo>/actions/workflows/release.yml/dispatches -f ref=main -f inputs[tag]=v1.4.2`).

The branch moves back to that commit, Amplify rebuilds it, and the old version serves again. Expect it to take
as long as a deploy, because it *is* a deploy — there is no instant previous-build switch.

**Code rolls back; the database does not.** The migrations the bad release ran have already run and a redeploy
of the previous tag does not undo them. That is the reason for the rule below.

## Migrations

- Migrations run as a pre-deploy step, inside the Amplify build, before the new version can take a request.
  Staging migrates on every merge to `main`; production migrates once per release tag.
- **Every migration must be readable by the release before it.** Add a column, backfill it, start writing it,
  and only drop the old one a release later. A migration that renames or drops something the previous release
  still reads makes the rollback above useless — the only way back is a restore (`docs/BACKUPS.md`), which
  loses whatever was written since.
- `npx prisma migrate status` runs ahead of the deploy, so the build log says which migrations this release
  brought and which were already applied. Read it when a deploy goes wrong.
- A failed migration is a failed build: nothing new is published, and the previous version keeps serving
  against the schema the migration did not finish changing. Fix forward with a new tag.
- Never run `prisma migrate reset` or `prisma db push` against a deployment. `migrate deploy` is the only
  command that touches a deployed database, and it is the build that runs it.

## Changing the infrastructure

The stack is code and a stack change is a human running CDK, not a release tag:

```bash
cd infra && npm ci
npx cdk diff SweetSpot-production     # always first: the only honest view of what a stack edit does
npx cdk deploy SweetSpot-production
```

`cdk deploy` with no stack named refuses to choose between the two stacks, which is the behaviour we want.
`bash scripts/infra-check.sh` is the same check CI runs — `cdk synth` of both stacks plus the stack's unit
tests, with no AWS account.

Two warnings in that output are expected and are not failures: `PubliclyAccessible` on the database (Amplify's
SSR compute cannot join a VPC — `docs/DEPLOY.md` has the trade), and `dbAllowedCidrs is empty` for any stage
that has not named the ranges allowed to reach port 5432 yet.

## Rotate a secret

§10.6 keeps six values out of this repository, and they are the six in `SECURE_PARAMETERS`
(`infra/lib/sweetspot-stack.ts`). Nothing expires them and nothing rotates them on a schedule: rotate on the
cadence the practice agreed, when somebody with access leaves, and immediately on any suspicion that a value
has leaked.

| Secret | What it is | Who reads it | What a half-finished rotation costs |
|---|---|---|---|
| `DATABASE_URL` | the RDS connection string, password included | the SSR compute, and the build for `prisma migrate deploy` | everything: the app answers 5xx |
| `AUTH_SECRET` | signs provider sessions and patient sessions, hashes the one-time tokens (§5.1, §5.3) | the SSR compute | sign-in links and six-digit codes already sent stop working |
| `JOBS_SECRET` | the bearer token on `POST /api/jobs/run` (§3.4) | the SSR compute, and the `jobs-tick` Lambda out of SSM | the minute tick 401s: jobs queue up, nothing is lost |
| `OPENAI_API_KEY` | the Bedrock API key (§3.5) | the SSR compute | Sweetie and Sour fall back to scripted (§11.3) |
| `DEXCOM_CLIENT_ID` / `DEXCOM_CLIENT_SECRET` | the Dexcom application's credentials (§9.2) | the SSR compute | connecting a Dexcom account fails; CSV uploads are unaffected |

### The two places every secret lives

This is the whole reason a rotation is four steps rather than one.

1. **SSM Parameter Store**, as a `SecureString` at `/sweetspot/<stage>/<NAME>`. The Amplify build reads the
   whole path into `.env.production` (and copies it to `.env`, which is what Prisma and
   `npm run config:check` read), and the `jobs-tick` Lambda reads `JOBS_SECRET` from it directly, at run time.
2. **The Amplify *app's* environment variables**, put there by a human once (`docs/DEPLOY.md` step 2). Amplify
   injects these into the SSR compute, so they are already in `process.env` by the time Next.js loads
   `.env.production` — and a `.env` file does not overwrite a variable that is already set. **The app's value
   is the one that serves.**

So SSM is what the *build* believes and the app variable is what the *running app* believes. Change one and
not the other and the deployment disagrees with itself at the next build, which is a failure that arrives
hours later with no obvious cause.

### The procedure

```bash
STAGE=production
NAME=AUTH_SECRET
NEW=$(openssl rand -base64 32)        # see "Minting each one" below; it differs per secret

out() { aws cloudformation describe-stacks --stack-name "SweetSpot-$STAGE" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
APP_ID=$(out AmplifyAppId)
BRANCH=$(out BranchName)        # release on production, main on staging

# 1. The app first, because the app is what serves. update-app REPLACES the whole list, so pass every
#    value, not just the new one (docs/DEPLOY.md says the same thing about adding the Dexcom pair).
aws amplify update-app --app-id "$APP_ID" --environment-variables \
  DATABASE_URL="...",AUTH_SECRET="$NEW",JOBS_SECRET="...",OPENAI_API_KEY="..."

# 2. Redeploy, because a variable change is not a deploy: the compute picks the list up when it is built.
#    start-job returns as soon as the build is queued, so wait for it: step 3 is only safe once the new
#    value is the one being served.
aws amplify start-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-type RELEASE
aws amplify list-jobs --app-id "$APP_ID" --branch-name "$BRANCH" --max-results 1 \
  --query 'jobSummaries[0].status'   # repeat until SUCCEED. A FAILED build means fix that, not step 3.

# 3. SSM, so the next build and the Lambda agree with the app. Straight after the build goes live: the
#    window between the two is the only one in which ticks fail.
aws ssm put-parameter --name "/sweetspot/$STAGE/$NAME" --type SecureString --value "$NEW" --overwrite

# 4. Check it.
APP_URL=$(aws ssm get-parameter --name /sweetspot/$STAGE/APP_URL --query Parameter.Value --output text)
APP_URL=$APP_URL npm run health:check
```

Keep the old value in the shell until step 4 passes. `put-parameter --overwrite` is the moment it stops
existing anywhere, and a rotation that has to be undone in a hurry is not the time to be regenerating it.

**Why the app before SSM.** `JOBS_SECRET` is the one where the order is visible, and it is the right order for
every secret but `DATABASE_URL`, which has its own note below. The Lambda caches the parameter for the life
of its container, and on a 401 or 403 it drops the cache, re-reads SSM and tries once more
(`infra/lambda/jobs-tick/index.js`). Rotate the app first and the cost
is one failed tick, provided step 3 follows the build promptly. Be clear about which tick the retry rescues:
between the new build going live and `put-parameter`, SSM still holds the *old* secret, so the Lambda sends
it, gets a 401, drops the cache, re-reads the same old value and fails that tick anyway. What the cache-drop
buys is the first tick *after* step 3 — it picks the new value up there and then, instead of waiting for a
cold start. Rotate SSM first, or run step 3 before the build is live, and it is the other way round: the
Lambda holds the new secret while the old version is still serving the old one, for the whole length of the
build — five or ten minutes of ticks that cannot authenticate, which is enough to fire `jobs-tick-errors`
(five errors in fifteen minutes). No jobs are lost either way; `run_after` is in the past and the next
successful tick drains them.

### Minting each one

**`AUTH_SECRET`** — `openssl rand -base64 32`. Provider sign-ins **survive**: sessions are rows in the
database (§5.1, `strategy: "database"`), not a signed cookie. What does not survive is everything the secret
is an HMAC key for:

- every sign-in link already sitting in a provider's inbox (Auth.js hashes the token with the secret) — they
  ask for another from `/provider/signin`;
- every patient session cookie, and every six-digit code already sent (`lib/patientSession.ts` keys both off
  it) — a patient who was mid-verification taps *send a new code*, which `POST /api/verify` serves.

Rotate it outside clinic hours and it costs nobody anything.

**`JOBS_SECRET`** — `openssl rand -hex 32`. One failed tick, as above. Nothing else reads it.

**`OPENAI_API_KEY`** — minted in Bedrock, not here. The gentlest rotation of the six: while the deployment
holds a key the gateway no longer accepts, `lib/llm.ts` times out, opens its circuit and answers from the
scripted path (§6.3, §11.3), which is a visible state on the page rather than an error. Expect
`model-failures` and then `model-degraded` to fire, and expect them to clear on their own once the new key is
serving. Any summary that ran scripted in the meantime can be re-run from the provider page (§7.1).

**`DEXCOM_CLIENT_ID` / `DEXCOM_CLIENT_SECRET`** — rotated in Dexcom's developer portal, both at once. Stored
refresh tokens were issued to the old client, so patients who had connected Dexcom reconnect; their CSV
uploads and everything already parsed are untouched. `DEXCOM_REDIRECT_URI` is computed by the stack and is not
a secret, but it does have to stay registered with Dexcom (`docs/DEXCOM.md`).

**`DATABASE_URL`** — the only rotation with an outage, because the server's password changes the instant you
ask and the app has the old one until a build lands. Schedule a window.

```bash
HOST=$(out DatabaseEndpoint)
SECRET=$(out DatabaseSecretArn)
NEWPASS=$(aws secretsmanager get-random-password --exclude-punctuation --password-length 32 \
  --query RandomPassword --output text)
aws rds modify-db-instance --db-instance-identifier "sweetspot-$STAGE-db" \
  --master-user-password "$NEWPASS" --apply-immediately
```

Then compose the new URL:

```
postgresql://sweetspot:$NEWPASS@$HOST:5432/sweetspot?schema=public&sslmode=require
```

`sslmode=require` is not optional — `rds.force_ssl=1` means the server refuses a plaintext connection (§10.1).

**This is the one secret whose steps go in a different order: 1, 3, 2.** Put the new URL on the app *and* in
SSM, and only then start the build. `prisma migrate deploy` runs from the build container with the SSM value,
so a build started while SSM still holds the old password fails at the migration step — which leaves the old
version serving against a password it no longer has, and now you are rotating under an outage. The tick's
one-failed-tick argument does not apply here: the Lambda reads only `JOBS_SECRET`.

Two more things to know:

- **The password changes before the app does.** Every request 5xxs from `modify-db-instance` until the
  redeploy is live, so `http-5xx` will fire. That is the alarm working; say so in the incident channel
  before you start, and do it out of clinic hours.
- **Secrets Manager is now stale.** The stack generated the original password into
  `sweetspot-<stage>/db` and nothing rotates it, so `modify-db-instance` leaves that secret holding the old
  value. Put the new one there too, or the next person composing a URL from the stack's outputs gets a
  password the server no longer takes:
  `aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "{\"username\":\"sweetspot\",\"password\":\"$NEWPASS\"}"`.

### What this does not cover

The KMS key behind the Dexcom tokens (§4.10) is not a secret anyone copies, so it is not in the table above.
AWS key rotation keeps old ciphertext readable and needs nothing from us; replacing the key with a different
one is a different thing and means every patient reconnects, because there is no re-encryption pass
(`docs/DEXCOM.md`). The GitHub token Amplify clones with is held by Amplify and is rotated in the console.

## Restore a backup

**The procedure is `docs/BACKUPS.md`**, and it is long enough to be its own page: what is backed up, how to
ask what is restorable, how to restore to a new instance, and `npm run restore:drill` to prove the restored
instance is the one you meant. Run the drill once a quarter against staging so that the day you need it is not
the first time.

What belongs here is when to reach for it, because a restore is the most destructive repair in this document:

- **A bad migration** that a rollback cannot undo (see [Migrations](#migrations)) — the only route back.
- **A wrong `DELETE`, or a retention sweep against the wrong window** (§10.4). Point-in-time recovery names a
  second, so "09:14, before the sweep" is restorable.
- **Not for a lost upload.** The bucket is versioned and a database restore does not bring an object back that
  §10.5 deleted on purpose (`docs/BACKUPS.md`, "What a restore does not bring back").
- **Not for a deletion request.** A restore that reaches back past a §10.5 deletion un-deletes a person who
  asked to be gone. If you restore across one, re-run the deletion afterwards and say so in the record.

Write down the gap between the restore point and now *before* you start: that gap is data that is being
thrown away, and it is the one number the practice will ask for.

## Handle a bounce or a complaint

Nothing here is a manual step in the normal case, and knowing that is the point of this section. SES publishes
to the configuration set's topic, SNS posts to `POST /api/notifications/sns`, the signature is checked
(`lib/snsSignature.ts`), and then `lib/notifyStore.ts` does two things: it records `bounced` or `complained`
on the `VisitDelivery` row, which staff see in the dashboard's **Messages** column with the reason in the
tooltip, and for a *permanent* bounce or a complaint it sets `emailUndeliverableAt` on the patient, which
closes the channel for every later send (`lib/suppression.ts`, §8.1). Transient bounces — a full mailbox, a
greylist — are left alone, because SES retries those itself and the address is not what is broken.
`docs/NOTIFICATIONS.md` is the mechanism in full.

So the operator's job is the three things the machinery cannot do.

**1. Confirm the loop is actually closed.** A bounce that suppresses nothing is a sending reputation quietly
draining away. The symptom is a delivery stuck at `sent` for an address that is obviously wrong.

```bash
aws logs tail "/aws/amplify/$APP_ID" --since 1h --filter-pattern '{ $.route = "POST /api/notifications/sns" }'
```

`sns_webhook_unverified` or `sns_webhook_wrong_topic` in there says which check refused it, and the usual
cause is `SNS_TOPIC_ARNS` not listing the topic, or *raw message delivery* left on for the subscription (it
strips the envelope the signature is on). A 503 from that route means `SNS_TOPIC_ARNS` is unset entirely.
`npm run config:check -- --production` warns about a configuration set with no topic ARN beside it.

**2. Tell the practice, so a person fixes the address.** A suppressed patient is a patient who will not get
an invite, a code or a summary notice, and the app will not tell them why — it is the front desk who has to
phone them or correct the record. The dashboard shows it; nobody is emailed about it.

**3. Reopen the channel once the address is corrected.** SMS does this by itself: a `STOP` sets `smsOptOutAt`
and a `START` clears it (`lib/notifyStore.ts`). Email does not, and this is the sharp edge — booking a new
visit with a corrected email updates `Patient.email` and leaves `emailUndeliverableAt` set
(`lib/visitStore.ts`), so the corrected address stays suppressed. There is no staff control for it yet, so
today it is one statement against the stage's database, after confirming the new address is really different:

```bash
URL=$(aws ssm get-parameter --name "/sweetspot/$STAGE/DATABASE_URL" --with-decryption \
  --query Parameter.Value --output text)
psql "${URL/schema=public&/}"   # psql refuses Prisma's `schema` parameter; `sslmode` it understands
```

```sql
-- the patient id is on the dashboard row and in the audit trail; never match on name
update "Patient"
   set "emailUndeliverableAt" = null, "emailUndeliverableReason" = null
 where id = '<patientId>' and "practiceId" = '<practiceId>';
```

Expect `UPDATE 1`. A staff-facing version of this is worth a ticket; until then it is an ops request, and it
is the only routine reason to open a `psql` against production.

### When it is a storm rather than a bounce

Watch the account's own numbers, because AWS acts on them: a bounce rate at or above 5%, or a complaint rate
at or above 0.1%, puts the sending account under review, and a higher rate still risks a sending pause that
takes every message with it. The two "at risk" figures are AWS's and they move, so read them off the
reputation dashboard in the SES console rather than from here.

```bash
aws sesv2 get-account --query '{enabled:SendingEnabled,review:EnforcementStatus}'
```

The one way to generate a hundred bad addresses at once in this product is the CSV import that creates a
day's visits (§2.2), so that is the first place to look. To stop sending while it is sorted out, turn the
configuration set off rather than editing the app's configuration:

```bash
SET=$(aws ssm get-parameter --name "/sweetspot/$STAGE/SES_CONFIGURATION_SET" \
  --query Parameter.Value --output text)
aws sesv2 put-configuration-set-sending-options --configuration-set-name "$SET" --no-sending-enabled
```

That makes every send fail rather than skip, so the `notify.*` jobs will use their three attempts and
`job-failed` will fire — which is the honest signal, and the reason to do this deliberately rather than leave
it on. Patients already in an intake are unaffected: nothing in Sweetie or Sour sends mail. Turn it back on
with `--sending-enabled`, then re-queue what was lost from the dashboard (regenerate the link, which sends
again).

## Handle a deletion request

§2.8 has the request arriving "through the practice", and §10.5 makes it a staff action in the app. **The app
is the procedure.** An operator's part is to confirm it finished and to know what it does and does not reach.

**In the app**, an admin or staff member — not a clinician, because reading a summary is not a reason to be
able to destroy the record behind it (`lib/access.ts`) — opens the patient's row and deletes it, typing the
patient's name to confirm (`lib/retention.ts`, `confirmsDeletion`): the mistake worth guarding against is
deleting the row above the one you meant, and another button cannot catch that.

What then happens, in order:

1. `deletedAt` is set immediately. The patient stops being matched onto new visits and the dashboard stops
   offering the row. This is one statement and cannot half-happen.
2. A `patient.delete` job is queued (§3.4), because the rest touches an object store and a dozen tables and
   has to survive failing half way through.
3. The job purges every visit and everything hanging off it — messages, intake, uploads and their parsed
   rows, summaries, the stored objects under `visits/<visitId>/`, and the patient's Dexcom tokens — then
   blanks the name, phone number and email, leaving a row that identifies nobody (§4.3: the audit record has
   to point at something, and a practice has to be able to answer "did you delete this person" a year later).
4. Any prefix the object store refused is written to `StorageOrphan`, keyed by the prefix itself, before the
   `Visit` rows that named it are deleted (T70). That row is what a later pass walks.
5. One `patient.deleted` audit row is written, against the staff member who asked, carrying counts and
   nothing else (§10.2, `docs/AUDIT.md`).
6. A deletion confirmation goes to the patient (§8.2), addressed from the contact details read just before
   the purge removed them.

**Confirm it finished.** `/provider/audit`, admin only, filtered to `patient.deleted`: one row, with
`visits`, `uploads`, `turns`, `summaries` and `objects`. Two things to read twice:

- **`orphans` above zero** means the rows are gone and some of the bytes are not: S3 refused that many
  deletes (`objects.failed`, `lib/storage.ts`). **This is no longer yours to repair by hand** (T70). The
  prefix is on `StorageOrphan` and two things come back to it. The nightly `retention.sweep` is the one that
  needs nobody: it walks the ledger after it has swept, every night, until the bucket takes the bytes. Any
  further `patient.delete` for that patient walks their part of it too — a retry of the job, or staff
  pressing *Delete data* again where the row is still on the dashboard — which is the fix for the old
  behaviour of returning early on an empty `patient.visits`. When the bytes finally go, the trail says so: a
  `storage.orphans_purged` row against the practice, with `prefixes`, `objects` and `orphans`.

  What is still yours is noticing that it is not clearing. Treat a non-zero `orphans` as an unfinished
  deletion request until a later row says otherwise, and look at the ledger directly if it is not moving:

  ```sql
  -- outstanding prefixes, worst first. attempts climbing with objects flat is a bucket saying no every night.
  SELECT "prefix", "objects", "attempts", "createdAt", "lastTriedAt" FROM "StorageOrphan" ORDER BY "attempts" DESC;
  ```

  A row whose `attempts` keeps rising is a permissions or lifecycle problem on the bucket, not a flake: read
  `object_delete_failed` in the logs for what S3 actually said, fix that, and the next sweep clears it. The
  manual prefix delete below is still the last resort, and still the thing to do if the practice needs the
  bytes gone tonight rather than after the next sweep; deleting them by hand also clears the ledger row, on
  the next pass, because a prefix that comes back empty leaves it.
- **No row at all** means the job has not run or has failed. Look for `job_failed` with
  `kind: patient.delete`; the three attempts and the error are in the queue. Staff can press delete again —
  the route deliberately allows it, the idempotency key releases once the job is not in flight, and the purge
  is idempotent. If nothing is draining at all, that is `jobs-tick-errors` below, and `npm run jobs:drain`
  against the stage's database is the manual drain.

**What a deletion does not reach**, which is what to say when a practice asks whether the data is really gone:

| Residue | How long | Why |
|---|---|---|
| Earlier versions of the deleted S3 objects | up to 30 days | the uploads bucket is versioned, and the purge deletes current versions; `expire-old-versions` removes the rest. Nothing in the app can read a non-current version. |
| The patient's rows in RDS automated backups | up to 7 days | point-in-time recovery is a 7-day window (§11.4); a restore across a deletion is the case called out in [Restore a backup](#restore-a-backup) |
| The audit record of the deletion | kept | on purpose (§2.8). It carries counts and no identity. |
| Application logs | 30 days staging, 90 production | they hold opaque ids only, never a name, an address or message text (§10.3) |

Deleting a prefix by hand — when a request needs the bytes or the object versions gone sooner than the next
sweep or the lifecycle rule — is destructive and unversioned, so read the prefix back before and after:

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name "SweetSpot-$STAGE" \
  --query "Stacks[0].Outputs[?OutputKey=='UploadsBucket'].OutputValue" --output text)
aws s3api list-object-versions --bucket "$BUCKET" --prefix "visits/<visitId>/" \
  --query '{Versions:Versions[].[Key,VersionId],Markers:DeleteMarkers[].[Key,VersionId]}'
```

A patient's visit ids come from the audit trail or from `StorageOrphan.prefix`, not from the patient row — by
then there is nothing on it. Record what was done in the practice's own deletion log: this page does not keep
one.

## What each alarm means

All six alarms and every RDS event publish to one SNS topic, `sweetspot-<stage>-alarms`. **If `alarmEmail` is
empty in `infra/cdk.json` for a stage, that topic has no subscriber and none of this reaches anybody** — check
that before trusting the silence. A demo practice's lines are excluded from `http-5xx`, `job-failed` and
`model-failures` (§13.4), so a synthetic visit cannot wake anyone. `model-degraded` counts them anyway, on
purpose: the circuit is one per process, so whoever tripped it, everybody is now reading scripted replies.

| Alarm | Fires when | Means | First look |
|---|---|---|---|
| `http-5xx` | ≥ 5 lines with `status >= 500` in 5 minutes | the app is failing requests | the log, filtered to 5xx |
| `job-failed` | any `job_failed` in 15 minutes | a job used up its three attempts: an invite, a summary or a deletion did not happen | the job's `kind` and `lastError` |
| `model-failures` | ≥ 10 `llm_call_failed` in 15 minutes | the model gateway is timing out or erroring (§3.5) | `npm run health:check` |
| `model-degraded` | any `llm_circuit_opened` in 15 minutes | the circuit is open: everyone is reading scripted replies (§6.3, §11.3) | the same |
| `jobs-tick-errors` | ≥ 5 Lambda errors in 15 minutes | nothing is draining the queue — a wrong `JOBS_SECRET`, or the app is down | the Lambda's log group |
| `db-storage` | less than 2 GiB free | storage autoscaling has not kept up | RDS console, free storage graph |

The first four read the app's own JSON log lines (§10.3, §11.1) through metric filters, which is only possible
because those lines carry no names, no phone numbers and no message text. To read them, in CloudWatch Logs
Insights on `/aws/amplify/<appId>`:

```
fields @timestamp, level, event, route, status, durationMs, requestId
| filter level = "error" or status >= 500
| sort @timestamp desc
| limit 100
```

and, to follow one request end to end, `filter requestId = "f1c2…"` on its own (`docs/LOGGING.md`).

**`http-5xx`** — start with whether anything was deployed or rotated in the last hour; this alarm is what a
half-finished `DATABASE_URL` rotation looks like, and what a bad release looks like. `npm run health:check`
separates the three dependencies (database, uploads bucket, model gateway) in one call. A green health check
with 5xx still arriving is application-level: group the log lines above by `route`, and if they are all one
route, read that route's handler rather than the infrastructure. If it is a bad release, roll back — the
previous tag is the fastest safe state.

**`job-failed`** — fires once and tells you nothing about which job, so the queue is the thing to read:
`npm run jobs:drain -- --list` against the stage's database prints each job's kind, attempts and last error.
What failed decides the urgency. `notify.invite` and `notify.code` mean a patient is waiting on a message that
will not arrive: fix the cause, then regenerate the link from the dashboard, which sends again. `sour.run`
means a clinician has no brief: the provider page has a retry (§7.2), and the summary is idempotent per visit
and input hash (§7.1). `patient.delete` is the serious one — a deletion request the practice has been told is
done, which is not — and the procedure above is how to finish it. A failure in every kind at once is not a job
problem; look at the database or at a secret.

**`model-failures`** and **`model-degraded`** — the same cause, two stages of it. `llm_call_failed` is each
failed attempt, including a timeout; `llm_circuit_opened` is `lib/llm.ts` giving up and going scripted for
everybody, because the circuit is per process and not per practice. Patients are *not* stuck: Sweetie's
scripted path keeps asking the intake questions and the page says so (§6.3), and Sour defers with a visible
state (§11.3). Check the gateway (`npm run health:check`), then the key — a rotated or revoked
`OPENAI_API_KEY` looks exactly like an outage from here — then Bedrock's own status for the model named by
`BEDROCK_OPENAI_MODEL_ID`. The circuit closes on its own when calls succeed again; nothing needs restarting.
Afterwards, re-run the summaries that came out scripted from the provider page.

**`jobs-tick-errors`** — the minute schedule could not call `POST /api/jobs/run`. The Lambda throws on any
non-2xx precisely so this metric exists; its own log group, `/aws/lambda/sweetspot-<stage>-jobs-tick`, has the
status and the body of the refusal. A 401 is `JOBS_SECRET` disagreeing between the app and SSM — see the order
note in [Rotate a secret](#rotate-a-secret) — and a 503 is the app having no `JOBS_SECRET` at all. A timeout
or a 5xx is the app being down, in which case `http-5xx` is the alarm to work and this one will clear with it.
Nothing is lost while it is red: due jobs stay due, and the first successful tick drains the backlog. If the
backlog is urgent, `npm run jobs:drain` is the same drain from a terminal.

**`db-storage`** — under 2 GiB free. Storage autoscaling is on (20 GiB allocated, 100 GiB ceiling), so this
is either autoscaling not keeping up with a burst or the ceiling being reached; `maxAllocatedStorage` in
`infra/lib/sweetspot-stack.ts` is the number to raise, followed by `cdk deploy`. The cause is
worth a look rather than just the symptom: the retention sweep (§10.4) is what is supposed to keep the
database bounded, and a sweep that has not run since a release is a `job-failed` nobody read. Growth with no
new practices is usually `Upload`/`UploadData` rows that outlived their retention setting.

**RDS events** arrive on the same topic and are not alarms, so they read differently — a sentence from AWS
rather than a metric. The `backup` and `failure` categories are the ones to act on, because a failed
automated backup publishes an event and no metric at all; that is the only way to hear about it (§11.4,
`docs/BACKUPS.md`). `availability` and `failover` on production are the multi-AZ standby doing its job, and
are worth reading but not usually worth doing anything about.

## What a human has to have done once

Both are outside anything a stack or a workflow can do:

- **Protect `release`.** Branch protection on `release`: no direct pushes, no pull requests into it, and
  `release.yml` (the `github-actions` actor) as the only writer. Without this, "production deploys from tagged
  releases" is a convention rather than a rule.
- **Protect the tags.** A tag protection rule for `v*` keeps a release tag from being moved after the fact.

And one that is easy to leave undone: **somebody has to be subscribed to the alarm topic.** `alarmEmail` in
`infra/cdk.json`, and then the confirmation link SNS sends has to be clicked. Every procedure in the section
above starts with a notification that nobody receives until that is done.
