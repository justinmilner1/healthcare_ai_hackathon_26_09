# Sweet Spot 🍬🍋

**Meet Sweetie and Sour.** Sweetie talks to the diabetes patient before the visit and collects their data. Sour hands the endocrinologist a one-page summary during the visit.

> Patients forget, CGMs don't. We turn a week of glucose, sleep and location data into the 5 minutes your endo actually needs.

Healthcare AI Hackathon, 26 Sep 2026. Built in 3 hours on Next.js and GPT-5.5 via Amazon Bedrock.

## Flow

1. **Booking.** A new diabetes patient books an endo appointment in the practice's scheduling system. That creates the patient here: the provider page's Add patient form (`POST /api/book`), or a day's visits at once from the scheduler's CSV (`POST /api/visits/import`, previewed row by row before anything is created). Staff record which channel the patient agreed to be contacted on and how that consent was taken, and the link goes out by text or email on that channel. Patients never come to the site on their own.
2. **Before the visit (Sweetie 🍬).** The patient opens the link and chats with Sweetie, the patient-facing agent. Sweetie asks them to connect Dexcom, WHOOP and Google Maps location, then asks a few quick questions about meals and symptoms.
3. **During the visit (Sour 🍋).** The doctor opens Sour, the provider-facing agent. Sour gives a one-page summary: glucose trends, spikes linked to places, sleep, and key questions to ask the patient.

Data is kept for life, so the summary gets better with every visit. Patients can see their own summary on the site.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 (App Router, TypeScript) | Front end and API routes in one repo |
| DB | Postgres 16 via Prisma | `docker compose up db` locally, RDS in production |
| Infra | AWS CDK (TypeScript) in `/infra` | Amplify, RDS, S3, SES, SNS, the job schedule, SSM, alarms (§3.6) |
| LLM | GPT-5.5 on Amazon Bedrock, OpenAI SDK, Responses API | What the workshop covers |
| SMS | Twilio | Fallback: show the link on screen |
| Glucose | Dexcom Clarity CSV upload, `pydexcom`-style Share polling optional | CSV is reliable in a demo |
| Location | Google Maps Timeline JSON upload | Only export that works in 2026 |
| Sleep | WHOOP CSV export | Optional |

## Quick start

```bash
git clone https://github.com/robbertstruyven/healthcare_ai_hackathon_26_09
cd healthcare_ai_hackathon_26_09
npm install
cp .env.example .env    # fill in the values below (works without an API key; agents fall back to scripted replies)
docker compose up -d db # Postgres 16 on localhost:5432, credentials as in .env.example
npx prisma migrate dev
npm run seed            # demo provider + patient with the sample files loaded; prints the three URLs
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

## Getting the demo data

**Dexcom:** Clarity web → Export → CSV, last 14 days. Or Dexcom app → Share on, then poll with `pydexcom`.

**Location (Samsung A55):** Settings → Location → Location services → Timeline → Export Timeline data. Copy `Timeline.json` to the laptop. Only visits from the last 7 days get used.

**Location (iPhone):** Google Maps → profile picture → Settings → Personal content → Export Timeline data → Save to Files.

**WHOOP:** app → More → Data export, or the CSV from the web dashboard.

If Timeline was off, write `data/visits.csv` by hand (`start,end,place,lat,lng`) from card transactions and photos. Takes 20 minutes and gives cleaner meal events.

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
  s/[token]/layout.tsx          the code and consent screens in front of both pages below (§5.3, §2.4)
  s/[token]/page.tsx            Sweetie voice-first chat + uploads (presigned link) Justin
  s/[token]/intake/page.tsx     onboarding: connect data, then continue to chat  Nisarga
  patient/[id]/layout.tsx       the same gate in front of the summary
  patient/[id]/page.tsx         patient summary view (opened by the invite token) Justin
  provider/page.tsx             session guard; dashboard.tsx is the practice dashboard Justin
  provider/signin/page.tsx      ask for a magic link; check-email/ and signout/ finish it Justin
  provider/signup/page.tsx      create a practice, then the same emailed link  Justin
  provider/settings/page.tsx    admin only; settings.tsx is practice, retention, users Justin
  provider/audit/page.tsx       admin only; audit.tsx is the §10.2 audit trail + CSV export
  provider/[id]/page.tsx        session guard; sour.tsx is the Sour summary view Justin
  provider/visit/[id]/print/page.tsx  the §7.4 one-pager: the summary alone, made for paper
  api/
    auth/[...nextauth]/route.ts Auth.js endpoints (sign in, callback, session, sign out)
    book/route.ts               POST create patient + send invite (scheduling hook) Justin
    verify/route.ts             POST ask for a six-digit code, POST check it (§2.3, §5.3)
    consent/route.ts            POST the patient's answer to the consent screen (§2.4)
    sweetie/route.ts            GET transcript+status, POST message or upload event  Justin
    upload/route.ts             POST multipart: token, kind, file             Nisarga / Robbert
    sour/route.ts               POST { visitId } generate summaries; or with question James
    patient/[id]/route.ts       GET PatientBundle for one visit (visit id or token)
    provider/route.ts           POST sign up, GET the signed-in provider + the practice's visits
    practice/route.ts           GET/PATCH the practice: name, retention, users (admin)
    practice/users/route.ts     POST invite a colleague with a role (admin)
    practice/users/[id]/route.ts PATCH one colleague's role (admin)
    audit/route.ts              GET the practice's audit log, filtered; ?format=csv exports it (admin)
    deletion/route.ts           POST { patientId, confirm } delete a patient's data (§2.8, §10.5)
    jobs/run/route.ts           POST drain the queue; queues the nightly retention sweep (§3.4, §10.4)
    health/route.ts             GET the dependency report: database, uploads, model gateway (§11.2)
    health/live/route.ts        GET liveness alone, for the load balancer and the e2e wait (§11.2)
components/
  VerifyGate.tsx                decides, on the server, whether a link shows its page, a code screen or consent
  VerifyScreen.tsx              that code screen
  ConsentScreen.tsx             the consent screen behind it, shown on first open only (§2.4)
  GlucoseChart.tsx              glucose line, target band, labeled spike pins  Justin
  SleepChart.tsx                hours asleep per night, with table twin        Justin
  SpikeTable.tsx                spikes linked to places (table twin of chart)  Justin
  RangeBar.tsx                  below / in / above range meter                 Justin
  StatTile.tsx, Disclaimer.tsx  small shared pieces                            Justin
lib/
  types.ts                      the shared shapes; change with care
  llm.ts                        ask(system, user, {json}) -> Bedrock Responses API; timeout, retry, circuit
  visits.ts                     visit types and labels (client-safe; no model)
  prompts.ts                    Sour prompts                                  James
  sweetie.ts                    Sweetie: visit templates, red-flag scan, extract, speak Justin
  auth.ts                       Auth.js: magic links, database sessions (§5.1)
  patientSession.ts             the patient side: one-time codes, the 24-hour session cookie (§5.3)
  consent.ts                    the consent screen's four statements, the first-open rule, the write (§2.4)
  authAdapter.ts                Prisma adapter + the 7-day absolute session cap
  access.ts                     roles and capabilities: the whole of §5.2, pure
  auditLog.ts                   audit vocabulary, the PHI gate on detail, CSV, filters (client-safe)
  auditStore.ts                 the database half: write a row, read the trail back (§4.8, §10.2)
  retention.ts                  how long data is kept, and the typed confirmation (client-safe; §2.8, §10.4)
  retentionStore.ts             the database half: the nightly sweep and the patient purge (§10.4, §10.5)
  guard.ts                      the 401 / 403 / 404 every provider route starts with
  httpError.ts                  a guard's refusal, answered and logged by withRoute
  team.ts                       practice/team shapes and validators (client-safe)
  teamStore.ts                  the database half: invite, role change, settings
  mailer.ts                     where a sign-in link goes: SES, or devMailbox.ts
  devMailbox.ts                 the local .mail/ drop behind `npm run mail`
  voice.ts                      browser speech synthesis + recognition for Sweetie Justin
  glucose.ts                    parse Clarity CSV, spikes, time in range      Nisarga
  location.ts                   parse Timeline.json, visits.csv, labelling    Robbert
  match.ts                      link spikes to visits                         Robbert
  sleep.ts                      parse WHOOP CSV                               (open)
  bundle.ts                     load a visit's data + status from the DB
  storage.ts                    raw uploaded files: S3, or the filesystem in dev and CI (§3.3)
  uploads.ts                    the gates before a parser: 20 MB cap, type sniffing (§9.1)
  visit.ts                      resolve a visit from its id or invite token
  practice.ts                   the first person in a practice: sign-up and the demo provider
  demo.ts                       demo practices: the sweep, the alarm label, the address rule (§13.4)
  migrateVisits.ts              the one-time backfill behind npm run migrate:visits
  sms.ts                        Twilio, falls back to showing the link        Justin
  health.ts                     the three §11.2 probes, their latencies, and what makes a report 503
  db.ts                         Prisma singleton
  config.ts                     every environment variable, checked at startup (design §3.7)
instrumentation.ts              runs that check before the server serves anything
prisma/schema.prisma            Practice, User (+Auth.js), Patient, Visit, Upload, Message, Summary, AuditLog, Job
scripts/seed.ts                 demo data into the DB;  gen_samples.py regenerates data/
scripts/migrate-visits.ts       give any patient without a visit one (design §4.11)
scripts/check-config.ts         npm run config:check: the startup check as a command
scripts/health-check.ts         npm run health:check: the deploy gate against a running deployment (§11.2)
scripts/infra-check.sh          npm run infra:check: typecheck, test and `cdk synth` the stack below
infra/bin/infra.ts              the CDK app: both stacks, staging and production (§3.6, §13.2, §13.3)
infra/lib/sweetspot-stack.ts    Amplify, RDS, S3, SES, SNS, the minute schedule, SSM, the alarms
infra/lib/stage.ts              everything that differs between staging and production
infra/lambda/jobs-tick/         the 60 lines EventBridge Scheduler runs to call POST /api/jobs/run (§3.4)
infra/test/stack.test.ts        asserts the stack is the one §10.1, §11.1 and §11.4 asked for
data/                           synthetic 7-day exports (see data/README.md)
data/uploads/                   where uploaded files land when no bucket is configured (gitignored)
```

Everything runs end to end today with scripted agent replies. Each owner replaces the stub in their file; the API contracts in `lib/types.ts` and the route comments are the interface between us.

## Product tasks

**Front end**
- [x] Provider sign up and dashboard: Justin
- [ ] Patient chat with Sweetie and data upload: Nisarga
- [ ] Provider view results (Sour): Justin
- [ ] Patient view results: Justin

**Back end**
- [x] Sweetie (info-gathering agent): Justin
- [ ] Sour (summary agent), provider and patient versions: James
- [ ] Data upload and storage: Dexcom Nisarga, location Robbert, WHOOP (open)
- [ ] Texting / emailing: Justin

## 3h plan

| Time | Who | What |
|---|---|---|
| 0:00 to 0:30 | all | Scaffold Next.js, Prisma schema, Bedrock call works, sample data in `data/` |
| 0:30 to 1:15 | back end | Parsers, spike detection, spike-to-visit matching |
| 0:30 to 1:15 | front end | Booking, Sweetie chat page, upload form |
| 1:15 to 2:00 | back end | Sweetie and Sour prompts, summary JSON |
| 1:15 to 2:00 | front end | Provider and patient summary pages, glucose chart with place pins |
| 2:00 to 2:40 | all | Twilio, ngrok, end-to-end run on Nisarga's data |
| 2:40 to 3:00 | all | Demo script, screenshots as fallback |

**Cut if behind:** Twilio (show the link), WHOOP, patient view, provider sign up (hardcode one provider).

## Demo script

1. On the provider page, add the booked patient and send the invite; the phone buzzes.
2. Open the link, Sweetie says hi, upload Dexcom CSV and Timeline.json, answer two questions.
3. Switch to the provider screen. Sour shows: time in range, 3 spikes pinned to places ("Chipotle 12:10 → 210 mg/dL at 13:05"), one sleep pattern, 3 questions for the visit.
4. Ask Sour "why was Tuesday bad?"

## Team

- [Robbert Struyven](https://github.com/robbertstruyven)
- [Justin Milner](https://github.com/justinmilner1)
- [Nisarga P](https://github.com/nisargap)
- [James](https://github.com/AgenticJamesBond)

## Resources

- [Event on Luma](https://luma.com/e9z9vuxz?tk=f60eTG)
- [Workshop: OpenAI models and Codex on Amazon Bedrock](https://catalog.us-east-1.prod.workshops.aws/workshops/8af92173-8b5b-489f-93bf-8176a4c2020f/en-US)
- AWS access codes: `86a4-134c05-9c`, `af34-1cbd39-0f` (join at catalog.us-east-1.prod.workshops.aws/join)
- [AWS blog: GPT-5.5 on Bedrock](https://aws.amazon.com/blogs/aws/get-started-with-openai-gpt-5-5-gpt-5-4-models-and-codex-on-amazon-bedrock/)
- [Codex with Amazon Bedrock](https://developers.openai.com/codex/amazon-bedrock)

Demo only. Not medical advice, not HIPAA compliant, uses one consenting teammate's data.
