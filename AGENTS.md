# AGENTS.md

Instructions for coding agents (Codex, Claude Code) working in this repo. Read before writing code.

## What this is

Sweet Spot: a 3-hour hackathon demo. Two agents for diabetes care.

- **Sweetie** 🍬 talks to the patient before the visit. Collects Dexcom, location and WHOOP data plus a few answers.
- **Sour** 🍋 gives the doctor a one-page summary during the visit.

Optimize for a working demo in 3 hours, not for production. Prefer the boring option.

## Stack

- Next.js 15, App Router, TypeScript, Tailwind. API routes under `app/api/*/route.ts`.
- Prisma + Postgres 16. `docker compose up db` locally (or `bash scripts/dev-db.sh` where there is no Docker daemon); RDS in AWS.
- LLM: GPT-5.5 on Amazon Bedrock through the OpenAI SDK, Responses API only. See `lib/llm.ts`.
- SMS: Twilio. Optional.
- Charts: Recharts.

## Commands

```bash
npm install
npx prisma migrate dev
npm run seed       # demo provider + patient with sample uploads; prints URLs
npm run dev        # localhost:3000
npm run lint
npm run typecheck  # tsc --noEmit
```

Without `OPENAI_API_KEY`, `lib/llm.ts` throws `LLMUnavailable` and the Sweetie and Sour routes fall back to scripted output, so the front end works offline. Data for a page comes from `GET /api/patient/[id]` (a `PatientBundle`, built in `lib/bundle.ts`); don't query Prisma from pages.

## Env vars

```
OPENAI_BASE_URL=https://bedrock-mantle.us-east-2.api.aws/openai/v1
OPENAI_API_KEY=<Bedrock API key>
BEDROCK_OPENAI_MODEL_ID=openai.gpt-5.5
DATABASE_URL=postgresql://sweetspot:sweetspot@localhost:5432/sweetspot?schema=public
APP_URL=<ngrok https url>
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM   (optional)
```

Never commit `.env` or anything in `data/` except the synthetic samples.

## LLM rules

- Always go through `lib/llm.ts`. One client, one helper: `ask(system, user, {json?: boolean})`.
- Use `client.responses.create`, never `chat.completions`. Bedrock only supports Responses for GPT-5.5.
- Model id comes from `BEDROCK_OPENAI_MODEL_ID`. Don't hardcode.
- Default `reasoning: {effort: "medium"}`, `text: {verbosity: "low"}`.
- For structured output ask for JSON in the prompt and parse with a try/catch. Retry once on parse failure.
- The developer message is the system prompt. Use role `developer`, not `system`.

## Data schemas

Keep these exact shapes. Front end and back end both depend on them.

```ts
// lib/types.ts
type GlucoseReading = { t: string; mgdl: number };                 // ISO time
type Visit = { start: string; end: string; place: string; lat: number; lng: number; placeId?: string };
type Spike = { start: string; peak: string; from: number; to: number; visit?: Visit };
type SleepNight = { date: string; hours: number; recovery?: number };

type Summary = {
  timeInRange: number;            // 0..1, 70..180 mg/dL
  avgGlucose: number;
  spikes: Spike[];                // top 3 to 5, with matched visit when found
  patterns: string[];             // max 3, plain language
  questions: string[];            // max 3, for the doctor to ask
  patientNotes: string;           // from Sweetie chat
};
```

### Spike detection (`lib/glucose.ts`)

Rise of at least 50 mg/dL within 2 hours, peak above 180. Merge spikes closer than 1 hour. Time in range = share of readings in 70 to 180.

### Location (`lib/location.ts`)

Parse Google Maps Timeline export. Android export is `{ semanticSegments: [...] }`, iOS export is a top-level array. Keep only segments with a `visit` key and `startTime` in the last 7 days. `topCandidate.placeLocation` is either `"37.77°, -122.41°"` or `{ latLng: "geo:37.77,-122.41" }`. Handle both. Place names are not in the export. Use `placeId` when present and fall back to a hand-labelled `data/visits.csv` if it exists.

### Matching (`lib/match.ts`)

A spike matches a visit if the visit ended within 30 minutes before the spike start, or overlaps it. Pick the closest.

## Agent prompts (`lib/prompts.ts`)

**Sweetie** (patient-facing) lives in `lib/sweetie.ts`, not in `prompts.ts`.
- Field-driven, like a clinical history template: `fieldsFor(visitType, reason)` builds the template from base fields
  (meals, unusual week, symptoms, visit goal) plus visit-type extras (new patient, medication check, post-hospital,
  annual) and a first field about whatever the patient called in about. Each patient
  message goes through a deterministic red-flag regex scan first, then an extraction call fills fields with a
  confidence, then `nextTarget` picks the next thing to ask (dexcom upload, timeline upload unless declined, first
  unfilled field, optional WHOOP, wrap), then `speak` writes one short plain-text message toward that target.
- Speaks like an intake nurse: acknowledge, then one question; notable events, concerns, purpose of the visit. Plain
  text because it is read aloud. Voice is the browser's own speech synthesis and recognition (`lib/voice.ts`); a final
  transcript is posted to the route like typed text, so the brain does not know or care which one it was.
- The route (`app/api/sweetie/route.ts`) is transport only. Upload events also go through it so Sweetie can
  acknowledge what arrived. `renderNotes` produces the text Sour reads from `Patient.notes`; the structured state is
  `Patient.intake` (JSON `IntakeState`).

**Sour** (provider-facing)
- Clinical, terse, no fluff. Numbers first.
- Input: `GlucoseReading[]`, `Spike[]` with matched visits, `SleepNight[]`, patient notes.
- Output: `Summary` as JSON. Patterns must cite data ("3 of 4 overnight highs followed dinners out after 8pm"). Questions must be specific to this patient.
- Never diagnose or recommend medication changes. Flag, don't prescribe.

## Repo layout

See README. Put parsers in `lib/`, keep API routes thin, keep pages thin. Sample data in `data/` (synthetic, 7 days). Real Dexcom and Timeline exports never get committed.

## Conventions

- Small commits, push often, `main` only. No PR reviews today.
- One owner per file where possible. Front end: `app/**/page.tsx`. Back end: `app/api/**`, `lib/**`.
- No new dependencies without a one-line reason in the commit message.
- If something doesn't work in 10 minutes, stub it and move on. A hardcoded provider beats a broken login.
- Don't build: auth beyond a token in the URL, real Dexcom OAuth, WHOOP OAuth, deployment. Local plus ngrok is the demo.

## Done means

`npm run dev` starts, Add patient on the provider page creates a patient and sends the link, `/s/<token>` chats and accepts uploads, `/provider/<id>` shows a `Summary` rendered from real uploaded files, and `npm run typecheck` passes.
