# Probe: sandbox capability report

## Environment
- node v22.22.0, npm 10.9.4, git 2.43.0, gh 2.89.0, python 3.11.17, docker 29.8.2
- npm registry: HTTP/2 200. 4 CPUs, 15Gi RAM, no swap.

## scripts/agent-check.sh (exit 1, 52s)
- install, database (migrate deploy + seed), typecheck, lint, unit (12/12) all PASSED.
- FAILED at `== browsers`: `npx playwright install --with-deps chromium` and the fallback both fail:
  `Error: Download failed: server returned code 403 body 'request blocked: no rule or allowlist entry allows host "cdn.playwright.dev"'`
  (playwright wants chromium v1248; the egress proxy blocks cdn.playwright.dev). `set -e` aborts before e2e.
- Pre-installed Chromium exists at /opt/pw-browsers (chromium-1194, `/opt/pw-browsers/chromium`), PLAYWRIGHT_BROWSERS_PATH is set.

## e2e workaround
A temp config wrapping playwright.config.ts with `launchOptions.executablePath = "/opt/pw-browsers/chromium"`
ran the suite: 6 passed / 0 failed in ~1m14s. 12 screenshots written to e2e/screenshots/ (desktop + mobile).

## Screenshot
desktop-sweetie-done.png: Sweet Spot "Sweetie" chat with a pink left panel (100% progress, Dexcom/Timeline/WHOOP upload rows)
and a completed conversation ending in "Your check-in is complete". Readable and renders correctly.
