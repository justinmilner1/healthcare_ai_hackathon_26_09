#!/usr/bin/env bash
# The one command both routines (and CI) run. Installs, audits the dependency tree, prepares a throwaway DB,
# seeds, then typecheck, lint, unit tests with a coverage table, the Playwright suite with screenshots in
# e2e/screenshots/ (emptied first, so it holds this run and nothing else), and the §11.4 restore drill's
# verification step against what the suite leaves behind.
# Exit code is the verdict.
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
# One mailbox per server in playwright.config.ts (the main one, the degraded one, the jobs runner, the
# Dexcom production one), so a link from one never shows up in another's.
rm -rf "$DEV_MAIL_DIR" "${DEV_MAIL_DIR}-degraded" "${DEV_MAIL_DIR}-runner" "${DEV_MAIL_DIR}-dexcom"
# Screenshots are the other thing both routines read to decide whether what they built looks right
# (design §12.3, docs/ROUTINES.md). Playwright overwrites the files this run produces and leaves every other
# file alone, so a directory that is never emptied is the union of this run and every run before it on
# whatever branch — and nothing in the filenames says which is which. Empty it here, with the mailboxes and
# before anything that can fail, so a run that dies at typecheck leaves no stale PNG claiming to be current.
rm -rf e2e/screenshots
mkdir -p e2e/screenshots
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

# The CDK app (design §3.6). Separate package, separate install; `cdk synth` with no credentials is the check
# that the stack is well formed, and the stack's own unit tests assert the properties §10.1, §11.1 and §11.4
# ask for. Before the slow part of the run, so a broken stack fails in forty seconds rather than three minutes.
bash scripts/infra-check.sh

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
npm run e2e

# The verification step of the §11.4 restore drill (docs/BACKUPS.md), rehearsed against the database the
# suite has just finished driving — a practice, patients, visits and an audit trail, which is the shape the
# drill asks about. Steps 1, 2 and 4 of the drill need an AWS account; this one is a script and a database,
# so it runs here and cannot quietly rot between quarterly drills. After the suite, not before: a seeded but
# undriven database has no audit rows, and §10.2's trail is one of the things the drill checks for.
echo "== restore drill (rehearsal)"
npm run restore:drill -- --restored-to "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== done. screenshots (this run only):"; ls -1 e2e/screenshots
