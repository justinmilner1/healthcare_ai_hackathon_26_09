# T42 — unit tests for the lib/ modules §12.1 still left untested

T42 changes no screen. It is a conformance ticket: design §12.1 asks for unit tests for **every module in
`lib/`**, and nine modules had none. The deliverable is eight `lib/*.test.ts` files, a shared fixture-schema
helper in `lib/fixtures.ts`, one export turned public for testability (`assertSendable` in
`lib/jobHandlers.ts`), and a comment in each of the four modules the coverage table leaves out saying why it
is out.

So the evidence is in two parts: the coverage table, and the screens unchanged — which is what a ticket about
unit tests should do to the app.

## The screens, unchanged

From the `bash scripts/agent-check.sh` run this pull request reports (exit 0; 178 Playwright tests passed).

| File | What it shows |
|---|---|
| `desktop-landing.png` | the landing page, both agents |
| `desktop-provider-dashboard.png` | the practice dashboard after sign-in, 17 visits |
| `desktop-provider-sour.png` | the Sour brief for the seeded visit |
| `desktop-sweetie-start.png` | Sweetie's first question on the patient link |
| `mobile-patient-summary.png` | the patient summary at 375px |

Four things visible in them are open bugs owned by other tickets, not regressions here: the raw `follow_up`
pill on the patient summary (T41, in review), "LLM not configured: set OPENAI_API_KEY" in the brief's
patterns (T63), Sweetie saying the upload button is "on the left" (T53), and the dashboard's "Date pending"
rows (T54, T67).

## The coverage table

`npm run test:coverage`, which `scripts/agent-check.sh` runs as its `== unit` step. 780 tests, 779 passing
and one skipped (`the health probe fails on a read-only local root`, skipped as root, which is pre-existing).

Every module in `lib/` now has a row except three, each of which says in its own header why it has none:

| Module | Why it is not in the table |
|---|---|
| `lib/types.ts` | declarations only; TypeScript erases them, so there is nothing to instrument |
| `lib/voice.ts` | every line calls `window.speechSynthesis` or `webkitSpeechRecognition`, neither of which exists under `node --test` |
| `lib/fixtures.ts` | the harness the other suites run on; excluded by name in `package.json` so a coverage row does not measure the measuring |

`lib/prompts.ts` is the fourth module the ticket allows to be absent. It now has a row anyway, because
`lib/sourRun.ts` imports it — its 28% is the prompt strings themselves, and its header says why there is no
`lib/prompts.test.ts`.

The nine modules this ticket covered:

| Module | Tests | Line % |
|---|---|---|
| `lib/bundle.ts` | 21 | 99.31 |
| `lib/sourRun.ts` | 30 (19 new) | 94.17 |
| `lib/jobHandlers.ts` | 21 | 94.22 |
| `lib/visit.ts` | 12 | 98.11 |
| `lib/practice.ts` | 12 | 97.62 |
| `lib/guard.ts` | 12 | 88.24 |
| `lib/teamStore.ts` | 22 | 99.35 |
| `lib/auth.ts` | 22 (8 new) | 87.50 |
| `lib/db.ts` | — | 100.00 (through the eight above) |

The two gaps worth naming. `lib/guard.ts` lines 24–34 are `requireProvider` and `requireCapability`:
`currentProvider` reads the Auth.js session through `next/headers`, which throws outside a request scope, so
they are exercised by the e2e suite (`e2e/auth.ts` signs in for real) and the role table they decide with is
`lib/access.test.ts`. `lib/auth.ts` lines 68–87 are `mintSignInUrl`'s happy path and `currentProvider`, for
the same reason — `e2e/demo.spec.ts` is what notices if a future Auth.js changes the token hashing.
