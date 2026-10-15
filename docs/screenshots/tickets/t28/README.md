# T28 — health endpoint with dependency checks

T28 changes no patient- or clinician-facing screen. The endpoint itself is the deliverable, so these are the
two answers it gives, opened in a browser the way an operator would, plus the one app screen whose server the
ticket touched.

| File | What it shows |
|---|---|
| `desktop-health-ok.png` | `GET /api/health` on the main e2e server: 200, three checks with latencies, the model `skipped` because no key is configured |
| `desktop-health-degraded.png` | the same path on the degraded server (a key configured, `OPENAI_BASE_URL` on a closed port): 503, model `down`, database and storage still `ok` |
| `mobile-health-ok.png`, `mobile-health-degraded.png` | the same two at 375px, taken as viewport rather than full page — Chromium's JSON viewer reports a page thousands of pixels tall on the phone profile (the T57 shape) |
| `desktop-sweetie-degraded.png` | §6.3 still intact on that degraded server: the note, and the scripted questions continuing. The ticket moved Playwright's readiness wait to `/api/health/live`, and this is the screen that proves the move cost that server nothing |

## The two bodies

```json
{"ok":true,"status":"ok","checks":{"db":{"status":"ok","latencyMs":1,"detail":"reachable"},"storage":{"status":"ok","latencyMs":1,"detail":"local"},"model":{"status":"skipped","latencyMs":0,"detail":"not_configured"}}}
```

```json
{"ok":false,"status":"down","checks":{"db":{"status":"ok","latencyMs":15,"detail":"reachable"},"storage":{"status":"ok","latencyMs":1,"detail":"local"},"model":{"status":"down","latencyMs":0,"detail":"circuit_open"}}}
```

`circuit_open` rather than `unreachable` because `lib/llm.ts` had already given up on that gateway by the time
the spec ran; on the first failure it reads `unreachable`. Both are the gateway being down, and neither is an
error message: §11.2's endpoint needs no session, so the body says one word per check and the real error goes
to the log.

## The deploy gate, against a real deployment

`npm run health:check` is the §13.3 half of the ticket: the gate between "the new version is running" and
"traffic goes to it". Run here against a production build on port 3200 with a throwaway database, then against
the same build started with `DATABASE_URL` pointing at a closed port:

```
$ npm run health:check
health check: http://localhost:3200/api/health
  attempt 1/5: HTTP 200
health: ok
  db       ok           1ms  reachable
  storage  ok           1ms  local
  model    skipped      0ms  not_configured
$ echo $?
0

$ APP_URL=http://localhost:3201 npm run health:check -- --attempts 1
health check: http://localhost:3201/api/health
  attempt 1/1: HTTP 503
health: down
  db       down        47ms  unreachable
  storage  ok           3ms  local
  model    skipped      1ms  not_configured
$ echo $?
1

$ APP_URL=http://localhost:3999 npm run health:check -- --attempts 2 --delay 1
health check: http://localhost:3999/api/health
  attempt 1/2: no answer (TypeError: fetch failed)
  attempt 2/2: no answer (TypeError: fetch failed)
$ echo $?
1
```

## What the caller is not told, and the log is

The database-down run above. The body carried `"detail":"unreachable"` and nothing else; the host, the port
and the Prisma message are in the log line, where §10.3's scrubber has already taken the address apart:

```json
{"time":"2026-10-15T14:48:49.918Z","level":"error","event":"health_check_failed","requestId":"77e6b5f2-23ca-4076-bafd-a1a046f1b307","route":"GET /api/health","check":"db","durationMs":47,"error":"PrismaClientInitializationError: Invalid `prisma.$queryRaw()` invocation: Can't reach database server at `[number]:5999` Please make sure your database server is running at `[number]:5999`."}
```

Before this ticket the route answered `{"ok":false,"db":"<the Prisma message>"}` on a public path, which is the
same string with the host still in it.
