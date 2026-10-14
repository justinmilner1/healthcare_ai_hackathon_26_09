# Sweet Spot 🍬🍋

**Meet Sweetie and Sour.** Sweetie talks to the diabetes patient before the visit and collects their data. Sour hands the endocrinologist a one-page summary during the visit.

> Patients forget, CGMs don't. We turn a week of glucose, sleep and location data into the 5 minutes your endo actually needs.

Healthcare AI Hackathon, 26 Sep 2026. Built in 3 hours on Next.js and GPT-5.5 via Amazon Bedrock.

## Flow

1. **Booking.** A new diabetes patient books an endo appointment in the practice's scheduling system. That creates the patient here (demo: the provider page's Add patient form, or `POST /api/book`). If they opted in, they get a text or email with a presigned link. Patients never come to the site on their own.
2. **Before the visit (Sweetie 🍬).** The patient opens the link and chats with Sweetie, the patient-facing agent. Sweetie asks them to connect Dexcom, WHOOP and Google Maps location, then asks a few quick questions about meals and symptoms.
3. **During the visit (Sour 🍋).** The doctor opens Sour, the provider-facing agent. Sour gives a one-page summary: glucose trends, spikes linked to places, sleep, and key questions to ask the patient.

Data is kept for life, so the summary gets better with every visit. Patients can see their own summary on the site.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 (App Router, TypeScript) | Front end and API routes in one repo |
| DB | Postgres 16 via Prisma | `docker compose up db` locally, RDS in production |
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

No Docker daemon? `npm run db:up` starts a Postgres that is already installed on the host instead and prints the
`DATABASE_URL` to put in `.env`. Either way the database is Postgres; SQLite is gone (design §3.2).

Checks: `npm run typecheck`, `npm run lint`, `npm run config:check`, `npm run test` (unit tests for every
`lib/` module, against the synthetic fixtures in `data/fixtures/` — see the README there),
`npm run test:coverage` for the same with a coverage table, `npm run build`, or `npm run agent:check` for
everything including e2e.
Reset the DB with `npm run db:reset && npm run seed`.

Server logs are one JSON line per event with a request id, and drop any field outside an allow-list, so no name,
phone number, email address or message text reaches them. See [docs/LOGGING.md](docs/LOGGING.md).

Security headers, CSRF protection and the dependency audit are in
[docs/SECURITY.md](docs/SECURITY.md). Two things to know before writing code: client calls that change
something go through `apiFetch` from `lib/csrf.ts`, not `fetch`, or middleware refuses them with a 403; and
a dependency advisory at high or above either gets fixed or gets a dated, owned entry in
`security/audit-exceptions.json`.

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

## Repo layout

```
app/
  page.tsx                      landing with links to every screen
  s/[token]/page.tsx            Sweetie voice-first chat + uploads (presigned link) Justin
  s/[token]/intake/page.tsx     onboarding: connect data, then continue to chat  Nisarga
  patient/[id]/page.tsx         patient summary view (visit id or token)      Justin
  provider/page.tsx             session guard; dashboard.tsx is the practice dashboard Justin
  provider/signin/page.tsx      ask for a magic link; check-email/ and signout/ finish it Justin
  provider/signup/page.tsx      create a practice, then the same emailed link  Justin
  provider/[id]/page.tsx        session guard; sour.tsx is the Sour summary view Justin
  api/
    auth/[...nextauth]/route.ts Auth.js endpoints (sign in, callback, session, sign out)
    book/route.ts               POST create patient + send invite (scheduling hook) Justin
    sweetie/route.ts            GET transcript+status, POST message or upload event  Justin
    upload/route.ts             POST multipart: token, kind, file             Nisarga / Robbert
    sour/route.ts               POST { visitId } generate summaries; or with question James
    patient/[id]/route.ts       GET PatientBundle for one visit (visit id or token)
    provider/route.ts           POST sign up, GET the signed-in provider + their visits
components/
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
  authAdapter.ts                Prisma adapter + the 7-day absolute session cap
  mailer.ts                     where a sign-in link goes: SES, or devMailbox.ts
  devMailbox.ts                 the local .mail/ drop behind `npm run mail`
  voice.ts                      browser speech synthesis + recognition for Sweetie Justin
  glucose.ts                    parse Clarity CSV, spikes, time in range      Nisarga
  location.ts                   parse Timeline.json, visits.csv, labelling    Robbert
  match.ts                      link spikes to visits                         Robbert
  sleep.ts                      parse WHOOP CSV                               (open)
  bundle.ts                     load a visit's data + status from the DB
  visit.ts                      resolve a visit from its id or invite token
  practice.ts                   a provider and their practice, created on demand
  migrateVisits.ts              the one-time backfill behind npm run migrate:visits
  sms.ts                        Twilio, falls back to showing the link        Justin
  db.ts                         Prisma singleton
  config.ts                     every environment variable, checked at startup (design §3.7)
instrumentation.ts              runs that check before the server serves anything
prisma/schema.prisma            Practice, User (+Auth.js), Patient, Visit, Upload, Message, Summary, AuditLog, Job
scripts/seed.ts                 demo data into the DB;  gen_samples.py regenerates data/
scripts/migrate-visits.ts       give any patient without a visit one (design §4.11)
scripts/check-config.ts         npm run config:check: the startup check as a command
data/                           synthetic 7-day exports (see data/README.md)
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
