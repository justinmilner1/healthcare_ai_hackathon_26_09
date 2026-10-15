#!/usr/bin/env bash
# The /infra check (design §3.6, §12.4): install, typecheck, the stack's unit tests, then `cdk synth`.
#
# Its own package, so the Next.js app never ships the CDK libraries and `npm ci` at the root stays small; the
# cost is this second install, about twenty seconds cold and nothing once node_modules is there.
#
# It needs no AWS credentials. Every value a deployment supplies comes from cdk.json context, and a stage with
# none synthesizes env-agnostic — which is the whole point of running synth here: it proves the stack is well
# formed before anybody with credentials tries it. There is no Docker step: the one Lambda in the stack is
# dependency-free JavaScript (`lambda.Code.fromAsset`), because the sandbox both routines run in has no Docker
# daemon.
set -euo pipefail
cd "$(dirname "$0")/../infra"

echo "== infra install"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "== infra dependency audit"
# The same §10.8 gate as the app's, pointed at this package's tree: `npm audit` only ever sees the
# package.json it is run in, so without this the CDK libraries would be the one dependency tree in the
# repository nobody checks.
npx tsx ../scripts/audit.ts infra

echo "== infra typecheck"; npm run typecheck
echo "== infra unit";      npm test
echo "== cdk synth"
# Warnings are expected and named in docs/DEPLOY.md (the database is reachable from outside the VPC because
# Amplify's SSR compute cannot join one, and it is closed to every CIDR until a deployment names one).
npx cdk synth --quiet
echo "== infra ok: $(ls -1 cdk.out/*.template.json | tr '\n' ' ')"
