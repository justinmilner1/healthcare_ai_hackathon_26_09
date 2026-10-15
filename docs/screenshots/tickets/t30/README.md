# T30 — the production stack, tagged deploys, migrations, rollback

T30 changes no screen. The deliverable is the second CDK stack, `.github/workflows/release.yml` and
`docs/RUNBOOK.md`, so the evidence is in three parts: the two synthesized templates, the pre-deploy steps a
production build runs, and the screens unchanged — which is what a ticket that adds a deployment should do to
the app.

## The screens, unchanged

Taken from the run of `bash scripts/agent-check.sh` this pull request reports (170 Playwright tests passed).

| File | What it shows |
|---|---|
| `desktop-landing.png` | the landing page, both agents |
| `desktop-provider-dashboard.png` | the practice dashboard after sign-in |
| `desktop-provider-sour.png` | the Sour brief for the seeded visit |
| `desktop-sweetie-start.png` | Sweetie's first question on the patient link |
| `mobile-patient-summary.png` | the patient summary at 375px |

Three things visible in these are open bugs of their own, not T30's: the hero pill over the Sweetie and Sour
captions (T52), `LLM not configured: set OPENAI_API_KEY` on the brief (T63), and the 7px stat labels on the
patient summary (T64).

## Two stacks out of one class

`bash scripts/infra-check.sh` → install, the §10.8 dependency audit of the CDK tree, typecheck, **17** unit
tests (14 before, plus three for this ticket), `cdk synth`. Two templates now, with no AWS account and no
Docker daemon:

```
== infra ok: cdk.out/SweetSpot-production.template.json cdk.out/SweetSpot-staging.template.json
```

Both are 68 resources and 10 outputs, of exactly the same types — the production deployment is not a different
shape of thing, it is the same thing configured for data worth keeping:

| | staging | production |
|---|---|---|
| `AWS::Amplify::Branch` `BranchName` / `Stage` | `main` / `BETA` | `release` / `PRODUCTION` |
| `AWS::RDS::DBInstance` `DBInstanceClass` | `db.t4g.micro` | `db.t4g.medium` |
| `MultiAZ` / `DeletionProtection` / `DeletionPolicy` | false / false / `Snapshot` | true / true / `Retain` |
| App log group `RetentionInDays` | 30 | 90 |
| SSM path, and so every physical name | `/sweetspot/staging/` | `/sweetspot/production/` |
| `BackupRetentionPeriod` | 7 | 7 (§11.4 for both) |

## What a production build runs before it serves

The `preBuild` phase of the production app's build spec, read out of `SweetSpot-production.template.json`.
Everything here is pre-deploy: Amplify publishes nothing unless all of it succeeded, so a failed migration
leaves the version that is already serving in place (§13.3).

```
- test "$AWS_BRANCH" = "release" || { echo "production deploys the release branch only (design §13.3); got $AWS_BRANCH"; exit 1; }
- npm ci
- aws ssm get-parameters-by-path --path "/sweetspot/production/" --recursive --with-decryption … > .env.production
- cp .env.production .env
- npx prisma migrate status || true
- npx prisma migrate deploy
- npm run config:check -- --production
```

The first line is what makes "deploys from tagged releases" a rule rather than a convention: the release
branch is written only by `release.yml`, and `release.yml` accepts nothing but a `v*` tag whose commit is on
`main`. Staging has no such line — a merge to `main` is its deploy (§13.2), and the unit tests assert both.

## Rollback

Running `release.yml` again with the previous tag moves the branch back and Amplify rebuilds it. The run's
summary prints the previous tag for exactly that reason. The database does not roll back with it, which is
why `docs/RUNBOOK.md` requires every migration to be readable by the release before it.
