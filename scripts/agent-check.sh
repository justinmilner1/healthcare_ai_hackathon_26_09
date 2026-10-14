#!/usr/bin/env bash
# The one command both routines (and CI) run. Installs, audits the dependency tree, prepares a throwaway DB,
# seeds, then typecheck, lint, unit tests with a coverage table, and the Playwright suite with screenshots in
# e2e/screenshots/. Exit code is the verdict.
set -euo pipefail
cd "$(dirname "$0")/.."

export OPENAI_API_KEY=""            # scripted mode: deterministic, no model calls
export E2E_PORT="${E2E_PORT:-3100}"
# Provider sign-in (design §5.1). No email provider is configured here, so lib/mailer.ts drops each sign-in
# link in DEV_MAIL_DIR and e2e/auth.ts reads it back; a stale link from the last run must not be picked up, so
# the mailbox starts empty. AUTH_SECRET signs the session cookie — in a throwaway database it is not a secret,
# and production takes it from SSM (§10.6).
export DEV_MAIL_DIR="${DEV_MAIL_DIR:-e2e/.mail}"
export AUTH_SECRET="${AUTH_SECRET:-e2e-session-secret-not-for-deployment}"
# One mailbox per server in playwright.config.ts (the main one, the degraded one, the jobs runner), so a link
# from one never shows up in another's.
rm -rf "$DEV_MAIL_DIR" "${DEV_MAIL_DIR}-degraded" "${DEV_MAIL_DIR}-runner"
export APP_URL="http://localhost:${E2E_PORT}"
export NEXT_TELEMETRY_DISABLED=1

echo "== install"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "== dependency audit"
# `npm audit --audit-level=high` minus the advisories written down in security/audit-exceptions.json
# (design 10.8, 12.4). scripts/audit.ts explains the subtraction; docs/SECURITY.md is the process. It needs
# the registry, so outside CI an unreachable registry is a skip with a warning rather than a failure.
npx tsx scripts/audit.ts

echo "== database"
# Postgres, never SQLite (design §3.2). The run gets its own database, sweetspot_e2e, dropped and recreated every
# time; a DATABASE_URL in the environment (CI's service container) supplies the server, not the database, so a
# developer's own data is never the thing being wiped. scripts/dev-db.sh picks Docker or a host Postgres.
export DATABASE_URL="$(bash scripts/dev-db.sh "${E2E_DB_NAME:-sweetspot_e2e}" --fresh)"
echo "database: ${DATABASE_URL%%:*}://...@${DATABASE_URL#*@}"
npx prisma migrate deploy
npm run seed

echo "== config"
# The §3.7 gate as a command, judged by production rules because that is what the two Playwright servers are:
# both are `next start` on a production build. Running it here is the same check instrumentation.ts runs when
# they boot, twenty seconds in instead of two minutes in and with a readable message instead of a webServer
# timeout. It passes in this sandbox and in CI: the only required variables are DATABASE_URL, set just above,
# and APP_URL, which is localhost here and exempt from the https rule.
npm run config:check -- --production

echo "== typecheck"; npm run typecheck
echo "== lint";      npm run lint
# Coverage goes through the unit step rather than a step of its own, so the table lands in CI output and in both
# routines' logs with no second run of the suite (design §12.1). `npm test` stays the bare runner.
echo "== unit";      npm run test:coverage

echo "== browsers"
# Some sandboxes block the Playwright CDN but ship a Chromium. Try the normal install; if it fails, point Playwright
# at any pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH, usually /opt/pw-browsers) via PW_CHROMIUM_PATH.
if ! npx playwright install chromium >/dev/null 2>&1; then
  found=""
  for dir in "${PLAYWRIGHT_BROWSERS_PATH:-}" /opt/pw-browsers "$HOME/.cache/ms-playwright"; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    found=$(find "$dir" -type f \( -name chrome -o -name headless_shell -o -name chromium \) -perm -u+x 2>/dev/null | grep -E "chrome-linux/(chrome|headless_shell)$|/chrome$" | head -1 || true)
    [ -n "$found" ] && break
  done
  if [ -n "$found" ]; then
    export PW_CHROMIUM_PATH="$found"
    echo "playwright download blocked; using pre-installed Chromium at $PW_CHROMIUM_PATH"
  else
    echo "playwright download blocked and no pre-installed Chromium found" >&2
    exit 1
  fi
fi

echo "== e2e"
mkdir -p e2e/screenshots
npm run e2e

echo "== done. screenshots:"; ls -1 e2e/screenshots
