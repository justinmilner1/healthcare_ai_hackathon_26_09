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
