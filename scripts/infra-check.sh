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

# `cdk synth` writes the cloud assembly into cdk.out, but it never removes what an earlier synth left there.
# Both routines keep one working directory across branches (docs/ROUTINES.md), so a template for a stack only
# another branch builds survives the switch — and the verdict line at the end of this script used to list the
# directory, which meant it could name a stack this branch cannot produce (T68). A CI runner checks out fresh
# and never saw it. Nothing reads cdk.out between runs and a synth is seconds, so clear it here, before any
# step that can fail, the way scripts/agent-check.sh clears e2e/screenshots (T43) and .next/types (T45).
rm -rf cdk.out

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
# The verdict line is evidence: a reviewer reads it to confirm the branch's stacks synthesize, and a builder
# quotes it as how the /infra step was verified. So it reports the cloud assembly's own manifest — the stacks
# this synth just produced — and not a listing of the directory, which is a different question with the same
# answer most of the time (T68). An empty assembly or a manifest naming a template that is not on disk is a
# failure here rather than a cheerful line with nothing behind it.
# Assigned first, then echoed: `echo "$(node ...)"` would swallow a non-zero node under `set -e`, because
# the command that failed is the substitution and the command that runs is a successful echo.
templates=$(node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync("cdk.out/manifest.json", "utf8"));
const stacks = Object.values(manifest.artifacts ?? {}).filter((a) => a.type === "aws:cloudformation:stack");
const templates = stacks.map((a) => `cdk.out/${a.properties.templateFile}`).sort();
const missing = templates.filter((t) => !fs.existsSync(t));
const problem = templates.length === 0 ? "the cloud assembly in cdk.out holds no stack"
  : missing.length > 0 ? `the cloud assembly names templates that are not on disk: ${missing.join(" ")}`
  : "";
if (problem !== "") { console.error(`infra-check: ${problem}`); process.exit(1); }
process.stdout.write(templates.join(" "));
')
echo "== infra ok: $templates"
