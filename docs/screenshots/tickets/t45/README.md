# T45 — main does not build

T45 changes no screen. It is two lines that let the application build and the e2e servers start again:
`lib/log.ts` mints its request id with Web Crypto instead of `node:crypto`, and the e2e runner server's
`JOBS_SECRET` is long enough for the §3.7 config gate to accept it.

Before it, `npx next build` failed outright, so there were no screenshots to take at all. These four are from
the first green run after the fix — the proof that the application still comes up and serves both flows.

| File | Screen |
|---|---|
| `desktop-landing.png` | `/` |
| `desktop-provider-dashboard.png` | `/provider` after signing in with the emailed link |
| `desktop-sweetie-start.png` | `/s/<token>` on open |
| `desktop-patient-summary.png` | `/patient/<token>` |
