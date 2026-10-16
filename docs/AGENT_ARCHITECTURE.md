# How the Sweet Spot agents work

Sweet Spot uses two focused AI agents around one diabetes visit:

- **Sweetie 🍬** interviews the patient before the visit and collects optional Dexcom, Google Maps Timeline, and WHOOP exports.
- **Sour 🍋** turns the collected story and data into a concise brief for the clinician and a plain-language summary for the patient.

The model does not control the application or calculate clinical metrics. TypeScript code owns routing, state, parsing, calculations, safety checks, persistence, and notifications; the model is used only for extracting meaning and writing concise language.

## End-to-end flow

```mermaid
flowchart LR
    A[Staff create a visit] --> B[Invite: /s/token]
    B --> B2[Six-digit code, then consent]
    B2 --> C[Sweetie intake]
    C --> D[(Postgres / Prisma)]
    E[Dexcom connection or CSV] --> F[Deterministic parsers]
    G[Timeline JSON] --> F
    H[WHOOP CSV] --> F
    F --> D
    C --> I{Intake wrapped?}
    I -->|Yes| Q[[Job: sour.run]]
    D --> Q
    Q --> J[Deterministic glucose analysis]
    J --> K[Sour clinician narrative]
    K --> L[Patient-friendly rewrite]
    K --> D
    L --> D
    Q --> R[[Job: notify.summary]]
    D --> M[Provider and patient pages]
    R --> N[Summary links by email and SMS]
```

Everything in that diagram after the first box belongs to one **visit**, not to the patient (design §4.4):
the token, the verified session, the transcript, the uploads, the intake state, both summaries, the
follow-ups and the sign-off. A `Patient` keeps the person — their name, their contact details, their Dexcom
connection — and persists across visits, so next quarter's appointment is a new visit with the same patient
and a fresh brief. Sweetie's structured state is `Visit.intake` (a JSON `IntakeState`) and the text Sour reads
is `Visit.notes`, both written in the same transaction as her reply.

The two double-walled boxes are rows in `Job`, not awaited calls (§3.4). Neither the patient nor the
clinician waits on Sour's two model calls or on an SES round trip, and a crash or a redeploy mid-request
costs an attempt rather than the work: the row says what to do, when it may run, how often it has been tried
and why it last failed. `docs/JOBS.md` is the queue — every kind, who enqueues it, the backoff, and who
drains it in each environment.

## One model gateway

All model calls go through `lib/llm.ts`. It creates one OpenAI SDK client, points it at Amazon Bedrock's OpenAI-compatible Responses API, and reads the model from the environment.

```ts
const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await client.responses.create({
  model: process.env.BEDROCK_OPENAI_MODEL_ID!,
  input: [
    { role: "developer", content: systemPrompt },
    { role: "user", content: userPrompt },
  ],
  reasoning: { effort: "medium" },
  text: { verbosity: "low" },
});
```

For JSON tasks, `ask<T>(..., { json: true })` asks for one JSON object, parses it, and retries once if parsing fails. If no API key is configured, it throws `LLMUnavailable`, which is the same signal an outage gives, so the scripted paths below answer instead (§6.3, §11.3). That is how the product runs offline, and how the e2e suite and the demo run.

### Timeout, retry, and the circuit (design §3.5, §6.3, §11.3)

Every call is bounded, and no failure reaches a page as a 500:

| Guard | Default | Env |
|---|---|---|
| Timeout per HTTP attempt | 20 s | `LLM_TIMEOUT_MS` |
| Retries | one, transient failures only | — |
| Consecutive failed calls that open the circuit | 3 | `LLM_CIRCUIT_THRESHOLD` |
| How long the circuit stays open | 60 s | `LLM_CIRCUIT_COOLDOWN_MS` |

Transient means a timeout, a dropped connection, 408/409/425/429, or a 5xx. A 401 is not: a bad key fails the
same way twice. The SDK's own retries are off, so this module is the only thing deciding when to try again.

A failure counts once per `ask`, not once per HTTP attempt, so "three failures" is three answers a patient did
not get. When the count reaches the threshold the circuit opens and `ask` throws `LLMUnavailable` without
touching the network; after the cooldown it half-opens and lets one probe through, which either closes it or
re-opens it. A 400 or 422 is this code's bug rather than an outage, so it is rethrown unchanged.

Everything else ends as `LLMUnavailable`, which is the same signal a missing key gives, so each caller's
existing fallback handles it: `scripted()` for Sweetie, placeholder patterns for Sour. `llmStatus()` reports
`{ configured, model, state, degraded }`; `/api/sweetie` passes `agent.degraded` to the page, which shows the
quiet "the assistant is unavailable" note above the question stepper. `e2e/degraded.spec.ts` runs the whole
path against a second server whose gateway is a closed port.

## Sweetie: the patient intake agent

Sweetie is a field-driven state machine rather than an unrestricted chatbot. The patient's visit type and booking reason produce a two-question intake template:

1. Why the patient is coming and what they want from the visit.
2. What has changed and how they have been feeling, adapted to the visit type.

Each field is stored with a confidence level:

```ts
type IntakeFieldState = {
  value: string | null;
  confidence: "unfilled" | "low" | "medium" | "high";
};

type IntakeState = {
  fields: Record<string, IntakeFieldState>;
  skipped: ("dexcom" | "timeline" | "whoop")[];
  flagged: string | null;
  turns: number;
  wrapped: boolean;
  questionsSkipped?: boolean;
};
```

### What happens after a patient message

One turn runs in a controlled sequence:

1. Save the patient's message, on its own, before anything that can fail.
2. Run a deterministic red-flag scan before sending anything to the model.
3. Ask the model to extract facts into the current intake fields.
4. Merge those facts without lowering existing confidence.
5. Apply a deterministic backstop when the model misses a substantive answer.
6. Select the next incomplete field or finish the intake.
7. Ask the model to acknowledge the answer and ask one short next question.
8. Commit the reply, the structured intake and the provider-readable notes together.

That order *is* design §6.2 — "every patient message is stored before any model call; the transcript survives
a crash" — and an order is the one thing reading a route cannot prove. So it lives in `lib/sweetieTurn.ts`
behind two injectable ports, a `TurnStore` that talks to Postgres and a `TurnModel` that talks to the
gateway, and `app/api/sweetie/route.ts` is left as transport: token, verified session, rate limit, and the
database half of the turn. `lib/sweetieTurn.test.ts` drives it with a store that records the order it was
called in and a model that can be told to throw, so steps 1 and 8 are asserted rather than read.

```ts
// lib/sweetieTurn.ts, simplified
await store.append("patient", message);          // 1. durable before any model call

const flag = scanRedFlags(message);              // 2. deterministic, so an outage cannot swallow it
if (flag) {
  state = { ...state, flagged: flag, wrapped: true };
  const reply = redFlagReply(firstName, providerName);
  await store.commit(reply, state);
  return { state, reply, flagged: flag, target: { kind: "wrap" } };
}

const transcript = await store.transcript();
const askedId = fieldTarget(nextTarget(state, defs));

state = merge(state, await model.extract(state, defs, transcript, message, askedId));
state = backstop(state, askedId, message);       // 5. behind the model, not instead of it

const target = nextTarget(state, defs);          // 6. from the state and the uploads
const reply = await model.speak({ state, defs, target, transcript, status: await store.status() });

await store.commit(reply, state);                // 8. one write: a question and the state it came from
```

An `LLMUnavailable` from either model call falls back to `scripted()` — the same targets in fixed words — and
changes the wording and nothing else, including what gets stored. Anything else is a bug and is allowed to
escape: the patient's message is already stored, nothing else has been written, and a half-finished turn is
never committed as if it had worked. After six turns Sweetie wraps up however little has been filled in
(`MAX_TURNS`), and the wrapping turn is what enqueues `sour.run`.

### Deterministic safety comes first

Red-flag phrases such as loss of consciousness, possible diabetic ketoacidosis, severe hypoglycemia, breathing problems, or self-harm are checked with explicit code before the model sees the message.

```ts
export function scanRedFlags(text: string): string | null {
  for (const flag of RED_FLAGS) {
    if (flag.patterns.test(text)) return flag.id;
  }
  return null;
}
```

If a flag matches, Sweetie stops the interview, directs the patient to immediate human help, records the flag for the care team, and does not ask the model to make a medical judgment. Sweetie never diagnoses, interprets glucose values, or recommends treatment.

### Structured extraction

The extraction prompt gives the model the field definitions, current values, previous transcript, and latest patient message. It requests a small JSON object rather than free-form clinical notes:

```json
{
  "fields": [
    {
      "id": "purpose",
      "value": "Wants to discuss recurring afternoon lows",
      "confidence": "high"
    }
  ],
  "declines": ["whoop"],
  "asks_export_help": null
}
```

The application validates field IDs, trims values, records declined uploads, and decides what to ask next. A field is considered answered when its confidence reaches `medium`.

### Upload events

Uploads go to `POST /api/upload`, where code parses and stores the file. After a successful upload, the page sends Sweetie a separate event so she can acknowledge it naturally:

```ts
// apiFetch, not fetch: middleware refuses an unsafe method with no CSRF token (design §10.8)
await apiFetch("/api/sweetie", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token,
    event: {
      type: "upload",
      kind: "dexcom",
      count: 2016,
      days: 7,
    },
  }),
});
```

Data sharing is optional. Patients can decline a source, remove an uploaded source, or skip the remaining questions.

### Voice and text use the same agent

Browser speech recognition converts speech to text, and browser speech synthesis reads Sweetie's response aloud. Voice and typed messages both call the same `/api/sweetie` route, so they share one transcript and one intake state.

## Sour: the clinician summary agent

Sour is queued as a `sour.run` job after Sweetie wraps up when Dexcom data is available, when a Dexcom import
completes, or when the clinician presses Generate; a background runner picks it up (design §3.4, §7.1, and
`docs/JOBS.md`). Neither the patient nor the clinician waits on the two model calls, and a crash between the
request and the summary costs an attempt rather than the summary. The job is idempotent per visit and per
input hash (`lib/sourInput.ts`): a second run over unchanged intake and uploads returns the saved pair rather
than paying for it again, and a changed input is what makes the provider page offer a fresh run. What the
clinician sees while they wait is the job itself — queued, running, or failed with the reason and a retry
(§7.2, `lib/sourState.ts`, `SourJobState` in `lib/types.ts`). Its pipeline is deliberately split into
deterministic analysis and model-written narrative.

### Code calculates the clinical data

Before calling the model, the application calculates:

- Time in, below, and above range.
- Average glucose and GMI.
- Per-day and time-of-day statistics.
- Spikes of at least 50 mg/dL reaching above 180 mg/dL.
- Temporal matches between spikes and nearby visits.
- Sleep averages and possible timing relationships.
- Explicit safety flags for severe lows, excessive time below range, and sustained readings above 250 mg/dL.

For example, spike-to-place matching is deterministic:

```ts
const overlaps = visitStart <= spikePeak && visitEnd >= spikeStart;
const endedJustBefore =
  visitEnd <= spikeStart &&
  spikeStart - visitEnd <= 30 * 60 * 1000;

if (overlaps || endedJustBefore) {
  matchedVisit = visit;
}
```

This produces a compact local-time brief such as:

```text
OVERALL (7 days, 2016 readings): TIR 82% · below 70: 2% · above 180: 16%

BY TIME OF DAY:
  overnight 00-06 | 96% | 118
  evening 18-24   | 68% | 164

SPIKES:
  Tue Sep 22 | 7:40 PM→8:25 PM | 128→214 | after leaving Chipotle at 7:32 PM
```

### The model identifies patterns and questions

Sour receives the precomputed brief and returns only narrative fields:

```json
{
  "patterns": [
    "Three of four evening spikes followed leaving a restaurant; Tuesday had the longest excursion."
  ],
  "questions": [
    "What did you eat and how did you dose before the Tuesday evening excursion?"
  ]
}
```

The prompt requires Sour to cite supplied evidence, avoid causal claims about locations, and never diagnose or recommend medication changes. Numeric values and safety flags remain code-generated even if the model output is incomplete.

### Save, rewrite, and notify

`runSour()` coordinates the complete operation (simplified):

```ts
const clinicianNarrative = await ask<Narrative>(
  sourSystem(),
  deterministicBrief,
  { json: true },
);

const providerSummary = {
  ...computedSummary,
  patterns: clinicianNarrative.patterns.slice(0, 3),
  questions: clinicianNarrative.questions.slice(0, 3),
  flags: deterministicFlags,
};

const patientNarrative = await ask<Narrative>(
  patientSummarySystem(),
  JSON.stringify(providerSummary),
  { json: true, effort: "low" },
);

await saveBothSummaries(providerSummary, patientNarrative);
await enqueue({ kind: "notify.summary", payload: { visitId } });
```

The patient rewrite uses simpler language and excludes clinician-only safety flags. Notifications are their own job, so a bounced or throttled send cannot cost Sour its summary, and they contain links to the saved summaries rather than patient data in the email body.

## Why this architecture is useful

The agents handle language tasks while ordinary application code handles decisions that must be reproducible.
Clinical numbers come out the same every time and can be unit-tested against fixtures; safety does not depend
on a model reading a message correctly; the product still works when the gateway is down; and a model cannot
invent a reading or move the workflow along. It is also what makes the brief reviewable: a clinician who
distrusts a sentence can check it against numbers that code computed.

## Main implementation files

| File | Responsibility |
|---|---|
| `lib/llm.ts` | Shared Bedrock Responses API client, timeout, retry, circuit, JSON retry |
| `lib/visits.ts` | Visit types and their labels: the client-safe half of Sweetie's vocabulary |
| `lib/sweetie.ts` | Intake templates, safety scan, extraction, state transitions, and speech |
| `lib/sweetieTurn.ts` | The order of one turn, which is design §6.2, behind injectable store and model ports |
| `app/api/sweetie/route.ts` | Transport: token, verified session, rate limit, and the turn's database half |
| `lib/jobs.ts`, `lib/jobHandlers.ts` | The queue and what each kind does: `sour.run`, the notifications, the sweeps (§3.4) |
| `app/api/upload/route.ts` | Upload validation, parsing, storage, and removal |
| `lib/glucose.ts` | Glucose parsing, time in range, averages, and spike detection |
| `lib/match.ts` | Temporal matching between spikes and visits |
| `lib/sour.ts` | Deterministic provider brief and safety flags |
| `lib/prompts.ts` | Sour clinician, chat, and patient-rewrite prompts |
| `lib/sourInput.ts` | The input fingerprint behind §7.1's idempotency |
| `lib/sourRun.ts` | Summary generation, persistence, and notifications |
| `lib/sourState.ts` | What the provider page says about a visit's summary job (§7.2) |
| `lib/bundle.ts` | One visit's data and status, as every page reads it (`PatientBundle`) |
| `app/api/sour/route.ts` | Sour generation and clinician follow-up API |
