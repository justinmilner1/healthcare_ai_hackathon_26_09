#!/usr/bin/env bash
# The one command both routines (and CI) run. Installs, prepares a throwaway DB, seeds, then typecheck, lint,
# unit tests, and the Playwright suite with screenshots in e2e/screenshots/. Exit code is the verdict.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="${DATABASE_URL:-file:./e2e.db}"
export OPENAI_API_KEY=""            # scripted mode: deterministic, no model calls
export E2E_PORT="${E2E_PORT:-3100}"
export APP_URL="http://localhost:${E2E_PORT}"
export NEXT_TELEMETRY_DISABLED=1

echo "== install"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "== database"
rm -f prisma/e2e.db prisma/e2e.db-journal
npx prisma migrate deploy
npm run seed

echo "== typecheck"; npm run typecheck
echo "== lint";      npm run lint
echo "== unit";      npm test

echo "== browsers"
npx playwright install --with-deps chromium >/dev/null 2>&1 || npx playwright install chromium

echo "== e2e"
mkdir -p e2e/screenshots
npm run e2e

echo "== done. screenshots:"; ls -1 e2e/screenshots
