# Sweet Spot 🍬🍋

**Meet Sweetie and Sour.** Sweetie talks to the diabetes patient before the visit and collects their data. Sour hands the endocrinologist a one-page summary during the visit.

> Patients forget, CGMs don't. We turn a week of glucose, sleep and location data into the 5 minutes your endo actually needs.

It began as a three-hour build at the Healthcare AI Hackathon on 26 Sep 2026. What is in this repository now
is that demo being taken to something a small endocrinology practice can pilot: AWS end to end, Postgres,
provider accounts, verified patient links, an audit trail, retention and deletion, background jobs, a runbook
and a test suite. [`docs/PRODUCTION_DESIGN.md`](docs/PRODUCTION_DESIGN.md) is the agreed design every change
cites; it also says what is deliberately out of scope (§14). Not HIPAA certification, no EHR integration, no
scale beyond a few practices.

### The documents

| Document | What it covers |
|---|---|
| [PRODUCTION_DESIGN.md](docs/PRODUCTION_DESIGN.md) | The design, in numbered sections. Every change cites the ones it fulfills |
| [AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md) | How Sweetie and Sour are built: code decides, models write |
| [AGENTS.md](AGENTS.md) | The working rules for anyone, human or agent, writing code here |
| [JOBS.md](docs/JOBS.md) · [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | The job queue, and every message the app sends |
| [SECURITY.md](docs/SECURITY.md) · [LOGGING.md](docs/LOGGING.md) · [AUDIT.md](docs/AUDIT.md) · [COMPLIANCE.md](docs/COMPLIANCE.md) | Headers, CSRF, rate limits, the PHI-free logs, the audit trail, and the HIPAA checklist |
| [DEPLOY.md](docs/DEPLOY.md) · [RUNBOOK.md](docs/RUNBOOK.md) · [BACKUPS.md](docs/BACKUPS.md) | The first deploy, the day-to-day procedures, and the restore drill |
| [DEXCOM.md](docs/DEXCOM.md) | The Dexcom connection, sandbox and production |
| [ROUTINES.md](docs/ROUTINES.md) | The two scheduled agents that advance the ticket stack, and how to work with them |

## Flow

The customer flow is design §2, and the code follows it in that order:

1. **Practice onboarding (§2.1).** An admin signs up with their email, names the practice, and invites
   clinicians and staff. Three roles: admin, clinician, staff (§5.2). No passwords anywhere — providers sign
   in with an emailed magic link (§5.1).
2. **Visit creation (§2.2).** Staff add a visit: the patient (new, or existing by phone or email), the date
   and time, the visit type, what the patient called about, the contact channel, and a recorded consent to be
   contacted. One at a time on the dashboard (`POST /api/book`) or a day at once from the scheduler's CSV
   (`POST /api/visits/import`, previewed row by row before anything is created). This is the seam a
   scheduling integration plugs into later.
3. **Invite (§2.3).** The patient gets a text or email naming the practice and nothing clinical, with a link
   to `/s/<token>`. Opening it sends a six-digit code to the same phone or email; a forwarded link alone
   reveals nothing.
4. **Consent (§2.4).** On the first open only: what the check-in collects, that it is optional, that a
   clinician reads it, and how to have it deleted. One tap continues; declining ends the session.
5. **Before the visit — Sweetie 🍬 (§2.5).** The patient answers two questions, by voice or by typing, and
   shares what they have: Dexcom (connected or a Clarity CSV), a Google Maps Timeline export, a WHOOP CSV.
   All of it optional. A deterministic safety scan runs before every model call, and a red flag stops the
   interview and points the patient at a person.
6. **During the visit — Sour 🍋 (§2.6).** When intake wraps, a `sour.run` job builds the brief and emails
   the clinician a link. Signed in, they get the one-pager — time in range, spikes linked to places, sleep,
   questions to ask — can ask Sour follow-ups, print it, and mark it reviewed, which records who and when.
7. **The patient's own view (§2.7).** The same verified link shows the patient a plain-language version of
   their week.
8. **Afterwards (§2.8).** Data is kept for as long as the practice's retention setting says (365 days by
   default) and a nightly sweep removes what is past it. A patient can ask the practice to delete their data,
   which goes end to end — messages, uploads, summaries, intake, the stored files — and leaves an audit record
   of the deletion.

Patients never come to the site on their own: every patient page is behind a visit's token and a verified
code.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 (App Router, TypeScript) | Front end and API routes in one repo |
| DB | Postgres 16 via Prisma | `docker compose up db` locally, RDS in production |
| Infra | AWS CDK (TypeScript) in `/infra` | Amplify, RDS, S3, SES, SNS, the job schedule, SSM, alarms (§3.6) |
| LLM | GPT-5.5 on Amazon Bedrock, OpenAI SDK, Responses API | One gateway, `lib/llm.ts`; the model id is configuration (§3.5) |
| Email / SMS | SES and SNS, with Twilio and Resend as local alternatives | One vendor and one set of BAAs (§8.1, §8.4) |
| Glucose | Dexcom OAuth, or a Clarity CSV upload | The connection is the product; the CSV always works (§9.2) |
| Location | Google Maps Timeline JSON upload | The only export that works in 2026 (§9.3) |
| Sleep | WHOOP CSV upload | Optional (§9.3) |

## Quick start

```bash
git clone https://github.com/justinmilner1/healthcare_ai_hackathon_26_09
cd healthcare_ai_hackathon_26_09
npm install
cp .env.example .env    # fill in the values below (works without an API key; agents fall back to scripted replies)
docker compose up -d db # Postgres 16 on localhost:5432, credentials as in .env.example
npx prisma migrate dev
npm run seed            # demo practice, patient and visit with the sample exports loaded; prints the URLs
npm run dev             # http://localhost:3000
```

Signing in as a provider (design §5.1): there is no password. Open `/provider`, type the seeded address
`demo@sweetspot.local` (or click **Open the demo**, which fills it in), then read the link out of the mail:

```bash
npm run mail            # prints the newest sign-in link; nothing is configured, so mail lands in .mail/
```

Set `RESEND_API_KEY` or AWS credentials in `.env` and the same link is emailed instead. `AUTH_SECRET` signs the
session cookie; local development falls back to a fixed development value, and a deployment must set it.

Set `DEMO_SIGN_IN=1` and **Open the demo** skips the mailbox: `/demo` mints the same one-use Auth.js link it
would have emailed and follows it, so you land on the dashboard. That is what §13.4 asks for on staging,
where there is no inbox to read. It opens nothing else — the route checks that the practice behind the seeded
address is marked `isDemo` before it hands anything out — and the §3.7 config check says so on every boot of
a deployment that has it on.

### Demo practices (design §13.4)

`npm run seed` marks its practice synthetic (`Practice.isDemo`), and three things follow from the flag:

- the nightly retention sweep leaves its visits alone, so a demo's week of readings is still there next month;
- its log lines carry `demo: true`, and §11.1's alarm filters leave those out (`docs/LOGGING.md`);
- it only messages reserved test addresses and `555-01xx` numbers — anything else is not sent, and says why
  in the dashboard's Messages column (`lib/demo.ts`, `docs/NOTIFICATIONS.md`).

A practice is marked when it is seeded, not from a form: the settings screen shows the flag and cannot set it,
because an admin turning it on would be turning their own practice's retention sweep off.

No Docker daemon? `npm run db:up` starts a Postgres that is already installed on the host instead and prints the
`DATABASE_URL` to put in `.env`. Either way the database is Postgres; SQLite is gone (design §3.2).

Checks: `npm run typecheck`, `npm run lint`, `npm run config:check`, `npm run test` (unit tests for every
`lib/` module, against the synthetic fixtures in `data/fixtures/` — see the README there),
`npm run test:coverage` for the same with a coverage table, `npm run build`, or `npm run agent:check` for
everything including e2e.
Reset the DB with `npm run db:reset && npm run seed`.

Server logs are one JSON line per event with a request id, and drop any field outside an allow-list, so no name,
phone number, email address or message text reaches them. See [docs/LOGGING.md](docs/LOGGING.md).

Every message the app sends — the invite, the verification code, the two summary-ready notices and the
deletion confirmation — is a template in `lib/notify.ts` carrying a link and nothing clinical, sent as a job.
What each one did is on the visit and in the dashboard's Messages column, and a bounce, a spam report or a
patient texting STOP closes that channel for good. [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) has the
templates, the delivery statuses and the SES domain, DKIM and origination-number setup.

Security headers, CSRF protection, the rate limits on the public routes and the dependency audit are in
[docs/SECURITY.md](docs/SECURITY.md). Three things to know before writing code: client calls that change
something go through `apiFetch` from `lib/csrf.ts`, not `fetch`, or middleware refuses them with a 403;
a dependency advisory at high or above either gets fixed or gets a dated, owned entry in
`security/audit-exceptions.json`; and a public route gets its limits from `lib/ratelimit.ts` — by IP before
the body is read, by visit once the token has named one.

What all of that adds up to under HIPAA — which business associate agreements are needed and whether they are
signed, the access, audit, integrity, transmission and contingency controls with the ticket that implements
each one, the risk assessment, and the list of things only a human can sign or name — is
[docs/COMPLIANCE.md](docs/COMPLIANCE.md) (design §10.7). It is also the honest list of what is still missing:
no agreement is signed and no official is named, so no deployment may yet be pointed at a real patient.

A patient link opens a code screen first: opening it sends a six-digit code to the phone or email on the
visit, and the chat, the uploads and the summary are all behind it (design §2.3, §5.3). With no SMS or email
backend configured the code goes to the same local mailbox as the sign-in links, so `npm run mail` prints it.
Behind the code, on the first open only, is the consent screen (§2.4): what the check-in collects, that it is
optional, that a clinician reads it, and how to have it deleted. One tap continues and the acceptance is kept
on the visit with its time; declining ends the session there and then.

Phone access for the patient link (needs HTTPS):

```bash
ngrok http 3000
```

### .env

[`.env.example`](.env.example) is the list: every variable the app reads, with a comment saying what it is for
and whether it is required, recommended, or optional. `lib/config.ts` holds the same list in code and checks it
when the server starts, so a production deployment missing something required refuses to serve rather than
failing at the first patient who needs it (design §3.7). In development the same problems are warnings.

```bash
npm run config:check                  # what is set, and what is wrong with it; never prints a value
npm run config:check -- --production  # judge this .env as a production deployment would
```

Two are required: `DATABASE_URL`, which must be a `postgresql://` URL, and `APP_URL`, which every patient and
provider link is built from and which has to be `https://` in production unless the host is localhost.
Everything else has a documented fallback — no model key means Sweetie and Sour answer from their scripted
paths, and no email or SMS credentials means the invite link is shown on screen instead of sent.

```bash
DATABASE_URL="postgresql://sweetspot:sweetspot@localhost:5432/sweetspot?schema=public"
APP_URL="https://<your-ngrok>.ngrok.app"    # the link in texts and emails points here
OPENAI_API_KEY="<BEDROCK_API_KEY>"          # Bedrock API key, not an OpenAI key
```

Test a real send from the terminal: `npm run send:test -- --email you@example.com --phone +1415...`

### Health and the deploy check

`GET /api/health` is the dependency report (design §11.2): the database, the uploads backend and the model
gateway, each with the milliseconds it took, and 503 as soon as one of them is down. A dependency that is not
configured is `skipped` rather than down, so the scripted mode this repo runs in locally is a healthy state.
The body carries one word per check — `reachable`, `local`, `unreachable`, `circuit_open`, `not_configured` —
and never an error message: the route needs no session, and a Prisma connection error names the database host.

```bash
npm run health:check                               # against APP_URL; exits 1 if anything is down
npm run health:check -- --url https://staging.example --attempts 10
```

That command is the gate between "the new version is running" and "traffic goes to it" (§13.3). A load
balancer's target check uses `GET /api/health/live` instead, which touches nothing: §11.3 has the app serve
through a model outage — Sweetie falls back to its scripted path, Sour defers — so draining the fleet over one
would turn a degraded feature into an outage. The e2e suite waits on the same liveness path, because one of its
servers has an unreachable gateway on purpose (playwright.config.ts).

### Calling GPT-5.5 on Bedrock

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const res = await client.responses.create({
  model: process.env.BEDROCK_OPENAI_MODEL_ID!,
  input: [
    { role: "developer", content: "You are Sour, a concise clinical summarizer." },
    { role: "user", content: prompt },
  ],
  reasoning: { effort: "medium" },
  text: { verbosity: "low" },
});
console.log(res.output_text);
```

GPT-5.5 and 5.4 answered from both us-east-1 and us-east-2 on 26 Sep. Short-term Bedrock API keys are scoped to the region they were generated in, so `OPENAI_BASE_URL` must use that same region or every call returns 401 "Credential should be scoped to a valid region". Only the Responses API is supported, not chat completions.

### Codex on Bedrock

The review bot on pull requests, and any agent working in this repo, talks to the same gateway the app does:

```bash
export AWS_BEARER_TOKEN_BEDROCK=<your-bedrock-api-key>
```

`~/.codex/config.toml`:

```toml
model = "openai.gpt-5.5"
model_provider = "amazon-bedrock"
[model_providers.amazon-bedrock.aws]
region = "us-east-2"
```

## Where a patient's exports come from

Sweetie asks for these, and this is what the office tells a patient who cannot find them. All of it is
optional, and the check-in finishes without any of it (design §2.5).

**Dexcom:** connecting the account is one tap in the chat and needs no files
([docs/DEXCOM.md](docs/DEXCOM.md), §9.2). Otherwise: Clarity web → Export → CSV, last 14 days.

**Location (Android):** Settings → Location → Location services → Timeline → Export Timeline data, then
share `Timeline.json` with the check-in. Only visits from the last 7 days of the export get used.

**Location (iPhone):** Google Maps → profile picture → Settings → Personal content → Export Timeline data
→ Save to Files.

**WHOOP:** app → More → Data export, or the CSV from the web dashboard.

A Timeline export carries no place names, only Google's place ids, so the brief says "an unnamed place" unless
a `data/visits.csv` (`start,end,place,lat,lng`) names them. `data/` holds the synthetic 7-day set the fixtures
and the demo use; a real export never gets committed.

## Where uploaded files go

The bytes of an export never go in the database (design §3.3). `POST /api/upload` checks the file before any
parser sees it — 20 MB cap, then magic bytes and format against the kind, so a Takeout zip or a PDF comes back
as one plain sentence the patient can act on — then hands the bytes to `lib/storage.ts` and keeps the key,
the byte count and the parsed rows on the `Upload` row.

| Environment | Backend | Where |
|---|---|---|
| Deployed (staging, production) | S3 | `UPLOADS_BUCKET`, private, server-side encrypted; `UPLOADS_KMS_KEY_ID` for SSE-KMS |
| Local, CI, the e2e suite | filesystem | `UPLOADS_DIR`, default `data/uploads/`, which `.gitignore` already covers |

Nothing has to be configured to run the app: with no `UPLOADS_BUCKET` the filesystem backend is what runs, and
the demo, the seed script and the check script all exercise the same code path a bucket would.
`STORAGE_BACKEND=s3|local` forces either. Keys are `visits/<visitId>/<kind>/<uuid>.<ext>`: ids the database
already has, never the name of the file the patient picked, and never anything a browser is shown.

### Deploying

`/infra` is an AWS CDK app in TypeScript (design §3.6): one stack class, two environments. It brings up the
Amplify Hosting app the Next.js build is served from, the RDS Postgres it reads, the private S3 bucket uploads
land in, the SES identity and SNS topics notifications go through, the EventBridge schedule that drains the job
queue every minute, the SSM parameters that carry configuration, and the CloudWatch alarms for the 5xx rate,
job failures and a model gateway that has stopped answering.

```bash
npm run infra:check      # typecheck, the stack's unit tests and `cdk synth` — no AWS account needed
npm run infra:synth      # just the template, into infra/cdk.out/
```

The first deploy needs a human: AWS credentials, a GitHub token for Amplify, a verified SES identity, and one
security decision about who may reach the database. [docs/DEPLOY.md](docs/DEPLOY.md) is that walkthrough, the
six secrets SSM needs, and what each alarm means.

After that, deploying is a push: staging is every merge to `main` (§13.2), and production is a `v*` tag, which
`.github/workflows/release.yml` turns into the only push the `release` branch ever gets (§13.3). The build
migrates before it serves, so a failed migration is a failed deploy rather than an app on the wrong schema, and
a rollback is that workflow run again with the previous tag. [docs/RUNBOOK.md](docs/RUNBOOK.md) is the
procedure.

The database keeps seven days of point-in-time backups (§11.4), which is the way back when a rollback is not
one. Restoring is a drill rather than a setting: [docs/BACKUPS.md](docs/BACKUPS.md) has the commands, the
expected output of each, and what the failure modes look like. Its verification step is a script —
`npm run restore:drill` — and `scripts/agent-check.sh` rehearses it on every run so it cannot rot between
quarterly drills.

## Repo layout

```
app/
  page.tsx                      landing with links to every screen
  demo/route.ts                 GET: sign straight into the seeded demo practice, when DEMO_SIGN_IN is on (§13.4)
  s/[token]/layout.tsx          the code and consent screens in front of both pages below (§5.3, §2.4)
  s/[token]/page.tsx            Sweetie voice-first chat + the optional data panel
  s/[token]/intake/page.tsx     onboarding: connect data, then continue to chat
  patient/[id]/layout.tsx       the same gate in front of the summary
  patient/[id]/page.tsx         patient summary view (§2.7)
  provider/page.tsx             session guard; dashboard.tsx is the practice dashboard
  provider/signin/page.tsx      ask for a magic link; check-email/ and signout/ finish it (§5.1)
  provider/signup/page.tsx      create a practice, then the same emailed link (§2.1)
  provider/settings/page.tsx    admin only; settings.tsx is practice, retention, users
  provider/audit/page.tsx       admin only; audit.tsx is the §10.2 audit trail + CSV export
  provider/[id]/page.tsx        session guard; sour.tsx is the Sour summary view (§2.6)
  provider/visit/[id]/print/page.tsx  the §7.4 one-pager: the summary alone, made for paper
  api/
    auth/[...nextauth]/route.ts Auth.js endpoints (sign in, callback, session, sign out)
    provider/route.ts           POST sign up, GET the signed-in provider + the practice's visits
    book/route.ts               POST create the patient and the visit, then invite (§2.2)
    visits/import/route.ts      POST a day of visits from the scheduler's CSV, previewed first (§2.2)
    invite/route.ts             POST (re)send a visit's link, regenerating the token (§5.5)
    verify/route.ts             POST ask for a six-digit code, POST check it (§2.3, §5.3)
    consent/route.ts            POST the patient's answer to the consent screen (§2.4)
    sweetie/route.ts            GET transcript+status, POST message or upload event (§6.1)
    upload/route.ts             POST multipart: token, kind, file (§9.1)
    dexcom/connect|callback/route.ts  the §9.2 OAuth round trip; status/ and demo/ finish it
    sour/route.ts               POST { visitId } queue a run; or a clinician's follow-up question (§7.5)
    review/route.ts             POST mark a visit's summary reviewed (§7.3)
    patient/[id]/route.ts       GET PatientBundle for one visit (visit id or token)
    practice/route.ts           GET/PATCH the practice: name, retention, users (admin)
    practice/users/route.ts     POST invite a colleague with a role (admin)
    practice/users/[id]/route.ts PATCH one colleague's role (admin)
    audit/route.ts              GET the practice's audit log, filtered; ?format=csv exports it (admin)
    deletion/route.ts           POST { patientId, confirm } delete a patient's data (§2.8, §10.5)
    jobs/run/route.ts           POST drain the queue; queues the nightly retention sweep (§3.4, §10.4)
    notifications/sns/route.ts  POST SES and SNS delivery results: bounces, complaints, STOP (§8.1, §8.3)
    health/route.ts             GET the dependency report: database, uploads, model gateway (§11.2)
    health/live/route.ts        GET liveness alone, for the load balancer and the e2e wait (§11.2)
components/
  VerifyGate.tsx                decides, on the server, whether a link shows its page, a code screen or consent
  VerifyScreen.tsx              that code screen
  ConsentScreen.tsx             the consent screen behind it, shown on first open only (§2.4)
  GlucoseChart.tsx              glucose line, target band, labeled spike pins
  SleepChart.tsx                hours asleep per night, with table twin
  SpikeTable.tsx                spikes linked to places (table twin of chart)
  RangeBar.tsx                  below / in / above range meter
  SourJobState.tsx              queued, running or failed, with the retry (§7.2)
  DexcomDemoLink.tsx            the sandbox connect link in the data panel (§9.2)
  StatTile.tsx, Disclaimer.tsx, PersonaBrand.tsx  small shared pieces
lib/
  types.ts                      the shared shapes; change with care
  llm.ts                        ask(system, user, {json}) -> Bedrock Responses API; timeout, retry, circuit
  visits.ts                     visit types and labels (client-safe; no model)
  sweetie.ts                    Sweetie: visit templates, red-flag scan, extract, speak
  sweetieTurn.ts                the order of one turn, which is design §6.2
  prompts.ts                    Sour prompts
  sour.ts                       the deterministic brief: the numbers and the safety flags
  sourInput.ts                  the input hash behind §7.1's idempotency
  sourRun.ts                    one run: both summaries, saved, then the "it's ready" jobs
  sourState.ts                  what the provider page says about a summary's job (§7.2)
  review.ts                     marking a summary reviewed: who and when (§7.3)
  followUps.ts                  a clinician's questions to Sour and the answers (§7.5)
  jobs.ts                       the queue: enqueue, claim, backoff, idempotency (§3.4)
  jobHandlers.ts                what each kind does: sour.run, the notifications, the sweeps
  auth.ts                       Auth.js: magic links, database sessions (§5.1)
  authAdapter.ts                Prisma adapter + the 7-day absolute session cap
  patientSession.ts             the patient side: one-time codes, the 24-hour session cookie (§5.3)
  consent.ts                    the consent screen's four statements, the first-open rule, the write (§2.4)
  access.ts                     roles and capabilities: the whole of §5.2, pure
  guard.ts                      the 401 / 403 / 404 every provider route starts with
  httpError.ts                  a guard's refusal, answered and logged by withRoute
  csrf.ts                       apiFetch and the token middleware checks (§10.8)
  security.ts                   the response headers (§10.8)
  ratelimit.ts                  the limits on the public routes, by IP and by visit (§5.4)
  log.ts                        structured JSON logs with a PHI allow-list, and withRoute (§10.3, §11.1)
  auditLog.ts                   audit vocabulary, the PHI gate on detail, CSV, filters (client-safe)
  auditStore.ts                 the database half: write a row, read the trail back (§4.8, §10.2)
  retention.ts                  how long data is kept, and the typed confirmation (client-safe; §2.8, §10.4)
  retentionStore.ts             the database half: the nightly sweep and the patient purge (§10.4, §10.5)
  team.ts                       practice/team shapes and validators (client-safe)
  teamStore.ts                  the database half: invite, role change, settings
  practice.ts                   the first person in a practice: sign-up and the demo provider
  visitIntake.ts                what the Add-visit form and the CSV import agree on (§2.2)
  visitStore.ts                 creating visits, one or a day at a time, and what each invite did (§2.2, §8.3)
  visit.ts                      resolve a visit from its id or invite token
  bundle.ts                     load a visit's data + status from the DB
  notify.ts                     the five message templates: a link and nothing clinical (§8.2)
  notifyStore.ts                what a provider told us about a send (§8.1, §8.3)
  snsEvents.ts, snsSignature.ts SES and SNS delivery results, and proving they came from SNS
  suppression.ts                when we stop messaging a channel, and why: bounce, complaint, STOP (§8.1)
  mailer.ts                     where a sign-in link goes: SES, or devMailbox.ts
  email.ts                      the SES and Resend backends behind it
  devMailbox.ts                 the local .mail/ drop behind `npm run mail`
  sms.ts                        SNS, with Twilio behind the same interface (§8.4)
  voice.ts                      browser speech synthesis + recognition for Sweetie
  glucose.ts                    parse Clarity CSV, spikes, time in range
  location.ts                   parse Timeline.json, visits.csv, labelling
  match.ts                      link spikes to visits
  sleep.ts                      parse WHOOP CSV
  dexcom.ts                     the Dexcom v3 client; dexcomEnv.ts is the sandbox/production switch (§9.2)
  storage.ts                    raw uploaded files: S3, or the filesystem in dev and CI (§3.3)
  uploads.ts                    the gates before a parser: 20 MB cap, type sniffing (§9.1)
  demo.ts                       demo practices: the sweep, the alarm label, the address rule (§13.4)
  health.ts                     the three §11.2 probes, their latencies, and what makes a report 503
  restore.ts                    what makes a restored database a usable one (§11.4)
  audit.ts                      the dependency-audit rules behind npm run audit:deps (§10.8)
  migrateVisits.ts              the one-time backfill behind npm run migrate:visits
  fixtures.ts                   test support: the one way lib/*.test.ts reads data/fixtures/
  config.ts                     every environment variable, checked at startup (§3.7)
  db.ts                         Prisma singleton
lib/*.test.ts                   a unit test file per module, against data/fixtures/ (§12.1)
instrumentation.ts              runs the config check before the server serves anything
middleware.ts                   the security headers and the CSRF refusal (§10.8)
prisma/schema.prisma            Practice, User (+Auth.js), Patient, Visit, PatientSession, Upload, Message,
                                Summary, FollowUp, VisitDelivery, AuditLog, Job, DexcomConnection
scripts/seed.ts                 demo practice, patient and visit into the DB; gen_samples.py regenerates data/
scripts/dev-db.sh               bring up a Postgres: Docker, or a host cluster where there is no daemon
scripts/agent-check.sh          npm run agent:check: the whole gate, in order
scripts/check-config.ts         npm run config:check: the startup check as a command
scripts/health-check.ts         npm run health:check: the deploy gate against a running deployment (§11.2)
scripts/jobs-drain.ts           npm run jobs:drain: drain or list the queue by hand (§3.4)
scripts/mail.ts                 npm run mail: the newest sign-in link or code out of the local mailbox
scripts/migrate-visits.ts       give any patient without a visit one (§4.11)
scripts/restore-drill.ts        npm run restore:drill: the §11.4 drill's verification step
scripts/audit.ts                npm run audit:deps: npm audit minus security/audit-exceptions.json
scripts/send-test.ts            npm run send:test: one real SMS or email, to check credentials
scripts/infra-check.sh          npm run infra:check: typecheck, test and `cdk synth` the stack below
infra/bin/infra.ts              the CDK app: both stacks, staging and production (§3.6, §13.2, §13.3)
infra/lib/sweetspot-stack.ts    Amplify, RDS, S3, SES, SNS, the minute schedule, SSM, the alarms
infra/lib/stage.ts              everything that differs between staging and production
infra/lambda/jobs-tick/         the 60 lines EventBridge Scheduler runs to call POST /api/jobs/run (§3.4)
infra/test/stack.test.ts        asserts the stack is the one §10.1, §11.1 and §11.4 asked for
e2e/                            the Playwright suite: a spec per screen, journey.spec.ts for both flows (§12.2)
e2e/screenshots/                what the last run saw; the committed ones are docs/screenshots/ (§12.3)
data/                           synthetic 7-day exports (see data/README.md)
data/fixtures/                  what the unit tests parse (§9.4)
data/uploads/                   where uploaded files land when no bucket is configured (gitignored)
security/audit-exceptions.json  dated, owned exceptions to the dependency audit (§10.8)
.github/workflows/              ci.yml on every pull request and on main after a merge, auto-merge, release.yml on a v* tag (§12.4, §13.3)
```

Everything runs end to end with scripted agent replies when no model key is configured — which is how the
e2e suite, the demo and the offline path all run (§6.3, §11.3). `lib/types.ts` and the comments on each route
are the contract between the pages and the API.

## A tour in five minutes

With `npm run seed` done and `npm run dev` running:

1. Open `/provider`, sign in as `demo@sweetspot.local` and read the link out of `npm run mail`. The dashboard
   lists the practice's visits.
2. **Add patient** books a visit: the patient, the date, the visit type, what they called about, and the
   channel they agreed to be contacted on. The invite goes out as a `notify.invite` job; with nothing
   configured to send it, the dashboard shows the link.
3. Open that link. A six-digit code is sent to the same place (`npm run mail` again), then the consent screen,
   then Sweetie. Share the sample Dexcom CSV and `Timeline.json` from `data/`, answer the two questions.
4. Back on the dashboard the visit moves to `summary_ready` once the `sour.run` job has drained
   (`npm run jobs:drain -- --list` shows the queue). Open the visit: time in range, the spikes with the places
   they followed, the sleep nights, and — with a model key configured — three patterns and three questions to
   ask. Without one the numbers are the same and the two written parts say the gateway is not configured.
5. Ask Sour a follow-up, hit **Print** for the one-pager, and **Mark reviewed** to sign it off. The patient's
   own version of the same week is behind their link.

## Working on this

Work arrives as `T<nn>` issues, one ticket to a branch and a pull request, with the design sections it
fulfills named in the body. Two scheduled agents — a builder and a reviewer — move that stack along, and
[docs/ROUTINES.md](docs/ROUTINES.md) is how they do it and how to work alongside them.
[AGENTS.md](AGENTS.md) is the rules for the code itself: the shapes that may not drift, the one model
gateway, the logger, `apiFetch`, and the one command that has to pass before anything goes up:

```bash
npm run agent:check
```

## Team

Built at the Healthcare AI Hackathon on 26 Sep 2026 by:

- [Robbert Struyven](https://github.com/robbertstruyven)
- [Justin Milner](https://github.com/justinmilner1)
- [Nisarga P](https://github.com/nisargap)
- [James](https://github.com/AgenticJamesBond)

## Reference

- [AWS blog: GPT-5.5 on Bedrock](https://aws.amazon.com/blogs/aws/get-started-with-openai-gpt-5-5-gpt-5-4-models-and-codex-on-amazon-bedrock/)
- [Codex with Amazon Bedrock](https://developers.openai.com/codex/amazon-bedrock)

Not medical advice, and nothing here interprets glucose for the patient (§14). The data in `data/` is
synthetic. No business associate agreement is signed and no security official is named
([docs/COMPLIANCE.md](docs/COMPLIANCE.md)), so no deployment of this may yet be pointed at a real patient.
