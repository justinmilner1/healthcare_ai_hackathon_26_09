# AGENTS.md

Instructions for coding agents (Codex, Claude Code) working in this repo. Read before writing code.

## What this is

Sweet Spot: two agents around one diabetes visit, being taken from a hackathon demo to something a small
endocrinology practice can pilot with real patients.

- **Sweetie** 🍬 interviews the patient before the visit and collects their Dexcom, Google Maps Timeline and
  WHOOP exports.
- **Sour** 🍋 turns that into a one-page brief for the clinician and a plain-language summary for the patient.

Three documents are the authority, in this order:

| Document | What it decides |
|---|---|
| [`docs/PRODUCTION_DESIGN.md`](docs/PRODUCTION_DESIGN.md) | The product and the architecture. Every ticket cites its sections; every reviewer checks against them. Numbered sections are stable — add subsections, never renumber. |
| [`docs/AGENT_ARCHITECTURE.md`](docs/AGENT_ARCHITECTURE.md) | How Sweetie and Sour are built: code decides, models write. |
| [`docs/ROUTINES.md`](docs/ROUTINES.md) | How work arrives: `T<nn>` issues, labels, one ticket per run of commits on `main`, and the REST-only GitHub calls that work from the sandbox. |

Read the design sections a ticket cites before you write anything. If the design and the code disagree, say so
on the issue rather than guessing which one is wrong.

## Stack

- Next.js 15, App Router, TypeScript, Tailwind. API routes under `app/api/*/route.ts`, exported through
  `withRoute` from `lib/log.ts`.
- Prisma + Postgres 16 (design §3.2). SQLite is gone. `docker compose up -d db` locally, or
  `npm run db:up` where there is no Docker daemon (the cloud sandbox); RDS in AWS.
- Auth.js email magic links for providers (§5.1); one-time codes over SMS or email for patient links (§5.3).
- Files to S3 in a deployment, to the filesystem locally and in CI (`lib/storage.ts`, §3.3).
- Background work is rows in `Job`, drained by `POST /api/jobs/run` (§3.4, `docs/JOBS.md`).
- LLM: GPT-5.5 on Amazon Bedrock through the OpenAI SDK, Responses API only. See `lib/llm.ts`.
- Email through SES, SMS through SNS; Twilio and Resend are local alternatives (§8.1, §8.4).
- Infrastructure is AWS CDK in `/infra` (§3.6). Charts are Recharts.

## Commands

```bash
npm install
npm run db:up            # Postgres: Docker if the daemon is up, a host cluster if not; prints DATABASE_URL
npx prisma migrate deploy
npm run seed             # demo practice + patient + one visit with sample uploads; prints the URLs
npm run dev              # localhost:3000
npm run mail             # the newest sign-in link or verification code out of the local mailbox

npm run typecheck        # tsc --noEmit
npm run lint
npm run config:check     # every env var, judged as this environment; -- --production to judge as a deployment
npm run test             # the lib/ unit tests, against the fixtures in data/fixtures/
npm run test:coverage    # the same, with a coverage table (design §12.1)
npm run e2e              # Playwright, both flows, screenshots into e2e/screenshots/
npm run agent:check      # all of the above in one command — this is the gate
```

`scripts/agent-check.sh` (`npm run agent:check`) is what both routines and CI run: install, dependency audit,
a throwaway `sweetspot_e2e` database, seed, config check, typecheck, lint, unit tests with coverage, the
`/infra` check, the Playwright suite, and the §11.4 restore drill. It must pass before anything is pushed to `main`.
When the Playwright suite fails, the script re-runs just the tests that failed, serially, once, and says of
each failure whether it was a clock that ran out or the product answering wrongly — the run is only excused
when every failure was a clock and the serial re-run passes (`docs/ROUTINES.md`, "When the box is the
problem").
Two things it cannot use in the sandbox: the Docker daemon (absent) and the Playwright CDN (blocked, a
pre-installed Chromium stands in). Don't add a step that needs either.

Without `OPENAI_API_KEY`, `lib/llm.ts` throws `LLMUnavailable` and Sweetie and Sour fall back to scripted
output, so the whole product works offline — that is the mode the check script and the demo run in (§6.3,
§11.3). Data for a page comes from `GET /api/patient/[id]` (a `PatientBundle`, built in `lib/bundle.ts`);
don't query Prisma from pages.

## Env vars

[`.env.example`](.env.example) is the list: every variable the app reads, with a comment saying what it is for
and whether it is required, recommended or optional. `lib/config.ts` holds the same list in code and
`instrumentation.ts` checks it before the server serves anything, so a production deployment missing something
required refuses to start (design §3.7). Add a variable in both places, or the check will not know about it.

```bash
npm run config:check                  # what is set and what is wrong with it; never prints a value
npm run config:check -- --production  # judge this .env as a deployment would
```

Only `DATABASE_URL` (a `postgresql://` URL) and `APP_URL` (https in production) are required. A deployment
takes the rest from SSM Parameter Store (§10.6); `.env` is local only. Never commit `.env`, a secret, or
anything in `data/` except the synthetic samples.

## Data model

Everything about one encounter hangs off `Visit`, not `Patient` (design §4.4): `intake`, `notes`, messages,
uploads, summaries, follow-ups, deliveries and patient sessions. A `Patient` persists across visits and keeps
the name, the contact details and the Dexcom connection. `prisma/schema.prisma` is the whole list; a schema
change is a migration (`npx prisma migrate dev --name ...`), never an edit to an existing one.

`prisma migrate reset` refuses to run for an agent without recorded human consent. A clean database comes from
`bash scripts/dev-db.sh <name> --fresh`, which drops and recreates only the database named on its command line
(`npm run db:up` is the same script with no arguments: it brings a server up without dropping anything), plus
`prisma migrate deploy`.

## Shared shapes

Keep these exact shapes. Front end and back end both depend on them, and `lib/types.ts` is the file to change
if a ticket says so.

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
  flags?: string[];               // deterministic safety flags from lib/sour.ts, never from the model
};
```

`Visit` here is a place the patient went, from their Timeline export — not an appointment. The appointment is
the `Visit` row in Prisma. `PatientBundle`, `IntakeState`, `SourJobState`, `ReviewRecord` and `FollowUp` are
in the same file with the comments that explain them.

### Spike detection (`lib/glucose.ts`)

Rise of at least 50 mg/dL within 2 hours, peak above 180. Merge spikes closer than 1 hour. Time in range =
share of readings in 70 to 180. `lib/sour.ts` adds the rest of §7's deterministic numbers: time below and
above range, GMI, per-day and time-of-day statistics, and the safety flags.

### Location (`lib/location.ts`)

Parse Google Maps Timeline export. Android export is `{ semanticSegments: [...] }`, iOS export is a top-level
array. Keep only segments with a `visit` key within the last 7 days of the file (the latest `endTime` is
"now", so a sample file never goes stale). `topCandidate.placeLocation` is either `"37.77°, -122.41°"` or
`{ latLng: "geo:37.77,-122.41" }`. Handle both. Place names are not in the export: join on `placeId`, then
fall back to a hand-labelled `data/visits.csv` by proximity. A visit neither of those names is called by its
own coordinates, three decimals (`placeLabel`) — never by its place id, which means nothing to a clinician
(T62). `placeId` stays on the `Visit` regardless; it is what the join uses.

### Matching (`lib/match.ts`)

A spike matches a visit if the visit ended within 30 minutes before the spike start, or overlaps it. Pick the
closest.

An overlap is two stories and not one: the visit was already running when the rise began, or it began after
the rise did, any time up to the peak. The matcher distinguishes neither — every overlap scores a gap of
zero and the first one seen wins — so the `visit` on a spike names a place and never a story.
`spikeVisitRelation` in `lib/spikePlaces.ts` is the one rule that tells the three apart (`after`, `during`,
`arrived`), and everything that says where the patient was reads it: the clinician's Place column, the chart
caption over it, and the relation word `lib/sour.ts` hands the model (T191, T192).

## The two agents

**Sweetie** (patient-facing) lives in `lib/sweetie.ts` and `lib/sweetieTurn.ts`, not in `prompts.ts`.
- Field-driven, like a clinical history template: `fieldsFor(visitType, reason)` builds a two-field template —
  what the patient called in about and what they want from the visit, then what has changed since last time,
  worded for the visit type. Each patient message goes through a deterministic red-flag regex scan first, then
  an extraction call fills fields with a confidence, a deterministic backstop catches what the model missed,
  and `nextTarget` picks the next thing to ask — the first unfilled required field, then any optional field
  under the six-turn cap, then wrap — before `speak` writes one short plain-text message toward it. It never
  asks for an upload: §2.5 gives that to the optional data panel on the page, and `Target` has only the two
  kinds `nextTarget` returns (T144).
- The order of a turn is `lib/sweetieTurn.ts`, because §6.2 is a claim about order: the patient's message is
  stored before any model call, and the reply and the intake state are committed together or not at all. The
  route (`app/api/sweetie/route.ts`) is transport only — token, session, rate limit, and the database half of
  the turn. Upload events go through it too, so Sweetie can acknowledge what arrived.
- Speaks like an intake nurse: acknowledge, then one question. Plain text, because it is read aloud. Voice is
  the browser's own speech synthesis and recognition (`lib/voice.ts`); a final transcript is posted to the
  route like typed text, so the agent neither knows nor cares which one it was.
- `renderNotes` produces the text Sour reads from `Visit.notes`; the structured state is `Visit.intake`
  (JSON `IntakeState`).

**Sour** (provider-facing) is `lib/sour.ts` (the numbers), `lib/prompts.ts` (the prompts) and
`lib/sourRun.ts` (the run).
- Clinical, terse, no fluff. Numbers first.
- Runs as a `sour.run` job, not inside a request: the three enqueuers are the turn that wraps intake — every
  wrap, with or without glucose (T143) — a completed Dexcom import — OAuth or a Clarity upload — when the
  intake is already done, and the provider page's Generate button (`docs/JOBS.md` is the list;
  `lib/sourQueue.ts` is the key, the wrap predicate and the import trigger's gate on the intake). The OAuth callback also deletes the saved summary, so a stale
  narrative is off the screen while the fresh run is in flight; the Clarity upload path deletes nothing — the
  saved pair stays up, `lib/bundle.ts` marks it `summaryStale` so it is never read as current, and the queued
  run replaces it. Idempotent per visit and input hash (§7.1), so a second run with unchanged inputs returns
  the saved pair. The page shows the job's state and offers a retry (§7.2).
- Input: `GlucoseReading[]`, `Spike[]` with matched visits, `SleepNight[]`, patient notes — all computed in
  code. The model returns `patterns` and `questions` only; numbers and flags stay code-generated.
- Patterns must cite data ("3 of 4 overnight highs followed dinners out after 8pm"). Questions must be
  specific to this patient.
- Never diagnose or recommend medication changes. Flag, don't prescribe.

## LLM rules

- Always go through `lib/llm.ts`. One client, one helper: `ask(system, user, {json?: boolean})`.
- Use `client.responses.create`, never `chat.completions`. Bedrock only supports Responses for GPT-5.5.
- Model id comes from `BEDROCK_OPENAI_MODEL_ID`. Don't hardcode.
- Default `reasoning: {effort: "medium"}`, `text: {verbosity: "low"}`.
- For structured output ask for JSON in the prompt and parse with a try/catch. Retry once on parse failure.
- The developer message is the system prompt. Use role `developer`, not `system`.
- Every call is bounded: a 20-second timeout, one retry on transient failures, and a circuit that opens after
  three failed calls (§3.5, §6.3). Everything a caller sees is `LLMUnavailable`, which is the same signal a
  missing key gives, so one fallback covers both. Don't catch anything else as an outage.

## Conventions

- One ticket, landed on `main` as a run of small commits whose messages start `T<nn>:` and say why. Push only a
  tree `npm run agent:check` has just passed on; never force-push. Unfinished work goes to a `t<nn>-wip` branch,
  not to `main`.
- Don't touch files the ticket is not about. The comment that hands the ticket to review cites the design
  sections, the commands run and the screenshots committed under `docs/screenshots/tickets/t<nn>/` (§12.3).
- No new dependencies without a one-line reason in the commit message. A dependency advisory at high or above
  either gets fixed or gets a dated, owned entry in `security/audit-exceptions.json` (`docs/SECURITY.md`).
- Client code that changes something calls `apiFetch` from `lib/csrf.ts`, never bare `fetch`: middleware
  refuses an unsafe method with no CSRF token (§10.8).
- Log through `lib/log.ts`, never `console.*`: it drops every field outside its allow-list so PHI cannot reach
  the logs, and carries the request id. Routes are exported through `withRoute`, which answers and logs a
  guard's refusal. See `docs/LOGGING.md`.
- Every provider route starts with `lib/guard.ts`: practice membership and role before anything else (§5.2).
  Every read of a visit's intake, summary, messages or uploads writes an audit row (`lib/auditStore.ts`,
  §10.2), with no PHI in `detail`.
- Public routes get their limits from `lib/ratelimit.ts`: by IP before the body is read, by visit once the
  token has named one (§5.4).
- §12.1 asks for unit tests for every module in `lib/`, against the synthetic fixtures in `data/fixtures/`.
  A module you add or change comes with its `lib/*.test.ts`, and a parser change comes with a fixture. Real
  Dexcom and Timeline exports never get committed.
- Keep parsers in `lib/`, API routes thin, pages thin. The repo layout is in the README.
- Accessibility is a requirement, not a polish pass: the patient pages are checked with axe in the e2e suite
  (§12.5) and are tested at 375px (§6.5).

## Done means

The ticket's acceptance criteria are all met, `npm run agent:check` passes, the screenshots of the screens the
ticket touched are committed under `docs/screenshots/tickets/t<nn>/` and look right, and the hand-off comment
on the issue says which design sections were fulfilled and how it was verified.
