# Runbook

What to do, step by step, when a deployment needs something done to it. Design §13.5 lists the procedures this
page owes: deploy, rollback, rotate a secret, restore a backup, handle a bounce, handle a deletion request, and
what each alarm means. **Deploy, rollback and migrations are here (T30).** The rest arrive with their own
tickets — the restore drill is T33, and T35 fills the page in — and each is marked below so nobody reads a gap
as "nothing to do".

Setting a deployment up for the first time is `docs/DEPLOY.md`. This page assumes it exists already.

## The two deployments

| | Staging | Production |
|---|---|---|
| Stack | `SweetSpot-staging` | `SweetSpot-production` |
| Context | `sweetspot:staging` in `infra/cdk.json` | `sweetspot:production` |
| Deploys when | a merge lands on `main` (§13.2) | the `release` branch moves to a `v*` tag (§13.3) |
| Branch written by | everybody, through pull requests | `.github/workflows/release.yml`, and nothing else |
| Database | single-AZ, `db.t4g.micro`, rebuildable | multi-AZ, `db.t4g.medium`, deletion protection on |
| Logs kept | 30 days | 90 days |
| Backups | 7 days of automated RDS backups | 7 days of automated RDS backups (§11.4) |

Both are the same stack class with the same build, so what is true of a staging deploy is true of a production
one. Everything that differs is in `infra/lib/stage.ts`.

## Deploy to production

A production deploy is a tag. Nothing else deploys, and nobody pushes to `release` by hand.

```bash
git fetch origin && git checkout main && git pull   # the commit you are releasing must be on main
npm run typecheck && npm run lint && npm test       # or just read the green ci run on the commit
git tag -a v1.5.0 -m "Sweet Spot v1.5.0"
git push origin v1.5.0
```

Pushing the tag runs `.github/workflows/release.yml`, which:

1. refuses anything that is not a `v*` tag;
2. refuses a tag whose commit is not on `main` — a release is a merged commit, never a side branch;
3. refuses a commit where `ci` ran and failed (a commit where `ci` never ran at all is a warning in the run's
   summary, not a refusal: see T47. If you see that warning, look at the commit before you trust the release);
4. points `release` at that commit.

Amplify is watching `release`, so that push is the deploy. The build is the pre-deploy step: `npm ci`, this
stage's parameters out of SSM into `.env.production`, `npx prisma migrate status`, `npx prisma migrate deploy`,
`npm run config:check -- --production`, then `npm run build`. **A failure anywhere in there fails the build and
leaves the version that is already serving in place.** Watch it in the Amplify console, or:

```bash
aws amplify list-jobs --app-id "$APP_ID" --branch-name release --max-results 5
```

Then check it the way §11.2 asks:

```bash
APP_URL=$(aws ssm get-parameter --name /sweetspot/production/APP_URL --query Parameter.Value --output text)
APP_URL=$APP_URL npm run health:check     # database, uploads bucket, model gateway
```

### Rolling back

A rollback is a redeploy of the previous tag (§13.3). The release run's summary names it; `git tag --list 'v*'
--sort=-v:refname | head -2` is the other way to find it.

- GitHub → Actions → **release** → *Run workflow* → tag `v1.4.2`.
- Or: `gh workflow run release.yml -f tag=v1.4.2` (needs a GraphQL-capable host — from the agents' sandbox use
  `gh api -X POST repos/<owner>/<repo>/actions/workflows/release.yml/dispatches -f ref=main -f inputs[tag]=v1.4.2`).

The branch moves back to that commit, Amplify rebuilds it, and the old version serves again. Expect it to take
as long as a deploy, because it *is* a deploy — there is no instant previous-build switch.

**Code rolls back; the database does not.** The migrations the bad release ran have already run and a redeploy
of the previous tag does not undo them. That is the reason for the rule below.

## Migrations

- Migrations run as a pre-deploy step, inside the Amplify build, before the new version can take a request.
  Staging migrates on every merge to `main`; production migrates once per release tag.
- **Every migration must be readable by the release before it.** Add a column, backfill it, start writing it,
  and only drop the old one a release later. A migration that renames or drops something the previous release
  still reads makes the rollback above useless — the only way back is a restore (T33), which loses whatever was
  written since.
- `npx prisma migrate status` runs ahead of the deploy, so the build log says which migrations this release
  brought and which were already applied. Read it when a deploy goes wrong.
- A failed migration is a failed build: nothing new is published, and the previous version keeps serving
  against the schema the migration did not finish changing. Fix forward with a new tag.
- Never run `prisma migrate reset` or `prisma db push` against a deployment. `migrate deploy` is the only
  command that touches a deployed database, and it is the build that runs it.

## Changing the infrastructure

The stack is code and a stack change is a human running CDK, not a release tag:

```bash
cd infra && npm ci
npx cdk diff SweetSpot-production     # always first: the only honest view of what a stack edit does
npx cdk deploy SweetSpot-production
```

`cdk deploy` with no stack named refuses to choose between the two stacks, which is the behaviour we want.
`bash scripts/infra-check.sh` is the same check CI runs — `cdk synth` of both stacks plus the stack's unit
tests, with no AWS account.

Two warnings in that output are expected and are not failures: `PubliclyAccessible` on the database (Amplify's
SSR compute cannot join a VPC — `docs/DEPLOY.md` has the trade), and `dbAllowedCidrs is empty` for any stage
that has not named the ranges allowed to reach port 5432 yet.

## What a human has to have done once

Both are outside anything a stack or a workflow can do:

- **Protect `release`.** Branch protection on `release`: no direct pushes, no pull requests into it, and
  `release.yml` (the `github-actions` actor) as the only writer. Without this, "production deploys from tagged
  releases" is a convention rather than a rule.
- **Protect the tags.** A tag protection rule for `v*` keeps a release tag from being moved after the fact.

## Not written yet

| Procedure | §13.5 | Ticket |
|---|---|---|
| Rotate a secret | yes | T35 |
| Restore a backup | yes | T33 (the drill), T35 (the page) |
| Handle a bounce or a complaint | yes | T35. `docs/NOTIFICATIONS.md` has the mechanism today |
| Handle a deletion request | yes | T35. §10.5 is a staff action in the app |
| What each alarm means | yes | the table in `docs/DEPLOY.md` today; T35 moves it here with the response |
