#!/usr/bin/env bash
# The one command both routines (and CI) run. Installs, audits the dependency tree, prepares a throwaway DB,
# seeds, then typecheck, lint, unit tests, and the Playwright suite with screenshots in e2e/screenshots/.
# Exit code is the verdict.
set -euo pipefail
cd "$(dirname "$0")/.."

export OPENAI_API_KEY=""            # scripted mode: deterministic, no model calls
export E2E_PORT="${E2E_PORT:-3100}"
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

echo "== typecheck"; npm run typecheck
echo "== lint";      npm run lint
echo "== unit";      npm test

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
