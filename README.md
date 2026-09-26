# Sweet Spot 🍬🍋

**Meet Sweetie and Sour.** Sweetie talks to the diabetes patient before the visit and collects their data. Sour hands the endocrinologist a one-page summary during the visit.

> Patients forget, CGMs don't. We turn a week of glucose, sleep and location data into the 5 minutes your endo actually needs.

Healthcare AI Hackathon, 26 Sep 2026. Built in 3 hours on Next.js and GPT-5.5 via Amazon Bedrock.

## Flow

1. **Booking.** A new diabetes patient books an endo appointment. If they opt in, they get a text with a presigned link to the site.
2. **Before the visit (Sweetie 🍬).** The patient opens the link and chats with Sweetie, the patient-facing agent. Sweetie asks them to connect Dexcom, WHOOP and Google Maps location, then asks a few quick questions about meals and symptoms.
3. **During the visit (Sour 🍋).** The doctor opens Sour, the provider-facing agent. Sour gives a one-page summary: glucose trends, spikes linked to places, sleep, and key questions to ask the patient.

Data is kept for life, so the summary gets better with every visit. Patients can see their own summary on the site.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 15 (App Router, TypeScript) | Front end and API routes in one repo |
| DB | SQLite via Prisma | Zero setup. Swap to Postgres later |
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
npx prisma migrate dev
npm run seed            # demo provider + patient with the sample files loaded; prints the three URLs
npm run dev             # http://localhost:3000
```

Checks: `npm run typecheck`, `npm run lint`, `npm run build`. Reset the DB with `npm run db:reset && npm run seed`.

Phone access for the patient link (needs HTTPS):

```bash
ngrok http 3000
```

### .env

```bash
# Bedrock (OpenAI-compatible endpoint, from the AWS workshop)
OPENAI_BASE_URL="https://bedrock-mantle.us-east-2.api.aws/openai/v1"
OPENAI_API_KEY="<BEDROCK_API_KEY>"        # Bedrock API key, not an OpenAI key
BEDROCK_OPENAI_MODEL_ID="openai.gpt-5.5"  # or openai.gpt-5.4

# Sending the link (all optional; see .env.example for the sandbox rules of each)
AWS_DEFAULT_REGION=us-east-1        # with AWS keys set, email goes via SES and SMS via SNS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
EMAIL_FROM=you@example.com          # must be a verified SES identity
TWILIO_ACCOUNT_SID=, TWILIO_AUTH_TOKEN=, TWILIO_FROM=      # Twilio wins over SNS when set
RESEND_API_KEY=                                            # Resend wins over SES when set
```

Test a real send from the terminal: `npm run send:test -- --email you@example.com --phone +1415...`

# App
DATABASE_URL="file:./dev.db"
APP_URL="https://<your-ngrok>.ngrok.app"
```

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

GPT-5.5 is only in us-east-2 (Ohio). Only the Responses API is supported, not chat completions.

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
  book/page.tsx                 patient booking + opt-in                      Justin
  s/[token]/page.tsx            Sweetie chat + upload buttons (presigned link) Nisarga
  patient/[id]/page.tsx         patient summary view                          Justin
  provider/signup/page.tsx      provider sign up                              (open)
  provider/[id]/page.tsx        patient list + Sour summary view              Justin
  api/
    book/route.ts               POST create patient, send SMS                 Justin
    sweetie/route.ts            GET transcript+status, POST chat turn         (open)
    upload/route.ts             POST multipart: token, kind, file             Nisarga / Robbert
    sour/route.ts               POST generate summaries; POST with question   James
    patient/[id]/route.ts       GET PatientBundle (everything a page needs)
    provider/route.ts           POST sign up, GET provider + patients         (open)
components/
  GlucoseChart.tsx              glucose line, target band, labeled spike pins  Justin
  SleepChart.tsx                hours asleep per night, with table twin        Justin
  SpikeTable.tsx                spikes linked to places (table twin of chart)  Justin
  RangeBar.tsx                  below / in / above range meter                 Justin
  StatTile.tsx, Disclaimer.tsx  small shared pieces                            Justin
lib/
  types.ts                      the shared shapes; change with care
  llm.ts                        ask(system, user, {json}) -> Bedrock Responses API
  prompts.ts                    Sweetie + Sour prompts                        James (Sour)
  glucose.ts                    parse Clarity CSV, spikes, time in range      Nisarga
  location.ts                   parse Timeline.json, visits.csv, labelling    Robbert
  match.ts                      link spikes to visits                         Robbert
  sleep.ts                      parse WHOOP CSV                               (open)
  bundle.ts                     load a patient's data + status from the DB
  sms.ts                        Twilio, falls back to showing the link        Justin
  db.ts                         Prisma singleton
prisma/schema.prisma            Provider, Patient, Upload, Message, Summary
scripts/seed.ts                 demo data into the DB;  gen_samples.py regenerates data/
data/                           synthetic 7-day exports (see data/README.md)
```

Everything runs end to end today with scripted agent replies. Each owner replaces the stub in their file; the API contracts in `lib/types.ts` and the route comments are the interface between us.

## Product tasks

**Front end**
- [ ] Provider sign up (open)
- [ ] Patient chat with Sweetie and data upload: Nisarga
- [ ] Provider view results (Sour): Justin
- [ ] Patient view results: Justin

**Back end**
- [ ] Sweetie (info-gathering agent) (open)
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

1. Book an appointment on the phone, opt in, receive the text.
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
