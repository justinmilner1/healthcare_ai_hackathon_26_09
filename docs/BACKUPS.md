# Backups and the restore drill

Design §11.4: *"RDS automated backups with 7-day retention; a documented restore drill."* Owner: ops.

Two halves, and the second one is the one that matters. Backups are a setting; a restore is a skill. This
page is the setting in one table and the skill in a sequence of commands somebody can follow at 3am without
thinking, having already followed them once on a quiet afternoon.

Day-to-day operations — deploy, rollback, rotating a secret, what each alarm means — are `docs/RUNBOOK.md`,
which links here for the restore. Setting a deployment up in the first place is `docs/DEPLOY.md`.

## What is backed up

| Thing | How it survives | Retained | Where it is configured |
|---|---|---|---|
| The database | RDS automated backups, and the transaction logs that make them point-in-time | 7 days | `infra/lib/sweetspot-stack.ts`, `backupRetention` |
| Uploaded exports | S3 object versioning on the uploads bucket | versions 30 days, current version forever | the same file, `uploadsBucket()` |
| Configuration | SSM parameters, written by `cdk deploy` | n/a — redeployable | `configParameters()` |
| Secrets | **not backed up**: SecureStrings a human put there, and the RDS password in Secrets Manager | n/a | `docs/DEPLOY.md` |
| The infrastructure | this repository | n/a | `cdk deploy` |

Seven days of retention is also seven days of **point-in-time recovery**. RDS keeps the write-ahead log beside
the nightly snapshot, so a restore names a second — "09:14 this morning, before the migration" — and not just
"last night". That is what the drill below practises, because it is the only kind of restore that helps with
the realistic disaster, which is not a disk failing but a bad deploy, a wrong `DELETE`, or a retention sweep
pointed at the wrong window.

The daily snapshot is taken at **07:00–07:30 UTC** — around 3am on the US east coast, midnight on the west.
Maintenance is `sun:08:00-sun:09:00 UTC`, deliberately clear of it. Both are pinned in the stack rather than
left to AWS, so this page can state them.

### What a restore does not bring back

- **Uploaded files.** The bucket is versioned and nothing deletes an object except a §10.5 staff deletion, so
  a database restored to an earlier point still finds its uploads. The reverse is the gap: an upload deleted
  under §10.5 stays deleted, and a restored row pointing at it will not resolve. That is correct — a deletion
  request is not undone by a restore — but the brief will show the upload as missing rather than empty.
- **Secrets.** A restored instance keeps the master password it had at the restore time. Everything in SSM is
  a human step from `docs/DEPLOY.md`.
- **Anything after the restore point.** Obviously, and worth saying out loud before a production restore: the
  gap between the restore point and now is data that is gone. Write down what the gap is before starting.

### Knowing a backup failed

There is no CloudWatch metric that goes red when an automated backup fails; RDS publishes an *event*. So the
stack subscribes the instance's `backup`, `failure`, `availability`, `failover`, `deletion` and `low storage`
events to the same SNS topic §11.1's alarms use (`sweetspot-<stage>-alarms`). One place to watch. If nobody
is subscribed to that topic yet, set `alarmEmail` in `infra/cdk.json` — a silent topic is the same as no
subscription at all.

## The drill

Run it **once a quarter**, and after any change to the database's size, engine version or parameter group.
Run it against staging; a production drill is the same commands with `STAGE=production` and a change window.
Budget 45 minutes, most of it waiting for an instance to come up.

The whole point is that it is boring. If it is not boring, something has been discovered, which is the drill
working.

### 0. Set the shell up

```bash
export AWS_REGION=us-east-1
export STAGE=staging                       # or production
export DB="sweetspot-$STAGE-db"
export DRILL="$DB-drill"
```

### 1. Ask what is restorable

```bash
aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].{retention:BackupRetentionPeriod,window:PreferredBackupWindow,latest:LatestRestorableTime,status:DBInstanceStatus}'
```

Expected:

```json
{ "retention": 7, "window": "07:00-07:30", "latest": "2026-10-15T09:12:00Z", "status": "available" }
```

`retention` is 7 or the stack has drifted. `latest` should be within about five minutes of now — that number
*is* the recovery point objective, and if it is hours old the transaction logs are not being shipped and the
drill has already found something. Note the value; it is the restore target.

```bash
export TARGET=$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].LatestRestorableTime' --output text)
```

### 2. Restore it to a new instance

A point-in-time restore never touches the source. It builds a second instance, which is why the drill is safe
to run against production.

```bash
SUBNETS=$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' --output text)
SG=$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)
PG=$(aws rds describe-db-instances --db-instance-identifier "$DB" \
  --query 'DBInstances[0].DBParameterGroups[0].DBParameterGroupName' --output text)

aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$DB" \
  --target-db-instance-identifier "$DRILL" \
  --restore-time "$TARGET" \
  --db-subnet-group-name "$SUBNETS" \
  --vpc-security-group-ids "$SG" \
  --db-parameter-group-name "$PG" \
  --db-instance-class db.t4g.micro \
  --no-multi-az --publicly-accessible --no-deletion-protection \
  --tags Key=app,Value=sweetspot Key=stage,Value="$STAGE" Key=purpose,Value=restore-drill
```

Three of those flags are the ones a hurried restore gets wrong:

- `--db-parameter-group-name` — without it the new instance gets `default.postgres16`, which does **not** have
  `rds.force_ssl=1`. A restore that quietly drops the TLS requirement is a §10.1 regression.
- `--vpc-security-group-ids` — without it the instance lands in the VPC's default group and nothing can reach
  it, including the operator running the drill.
- `--no-deletion-protection` — a production restore inherits deletion protection and then cannot be cleaned
  up without a second call.

```bash
aws rds wait db-instance-available --db-instance-identifier "$DRILL"   # 10-25 minutes
```

### 3. Verify it is the database that went in

```bash
ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DRILL" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
PASSWORD=$(aws secretsmanager get-secret-value --secret-id "sweetspot-$STAGE/db" \
  --query SecretString --output text | python3 -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.load(sys.stdin)["password"], safe=""))')

npm run restore:drill -- \
  --url "postgresql://sweetspot:$PASSWORD@$ENDPOINT:5432/sweetspot?sslmode=require" \
  --restored-to "$TARGET"
```

The password is URL-quoted because a generated one contains characters a connection string reads as syntax.
Keep it in the variable: the drill prints the host, the port and the database name and never the credential,
so its output is safe to paste into the record below.

Expected — and the exit code is 0:

```
restore drill: sweetspot-staging-db-drill.abc123.us-east-1.rds.amazonaws.com:5432/sweetspot
restore: ok
  migrations  pass  11 applied, none missing
  tables      pass  Practice 1, User 3, Patient 42, Visit 96
  audit       pass  1184 rows
  freshness   pass  newest row 2 min before the restore target (limit 60)
  rows        Practice=1 User=3 Patient=42 Visit=96 AuditLog=1184 Summary=71 Upload=88
```

What each check is for, and what it means when it is not `pass`, is in `lib/restore.ts`. In short:

| Check | `fail` means |
|---|---|
| `migrations` | the restore predates a migration this checkout needs — restore to a later point, or deploy the matching tag |
| `tables` | an empty required table: the wrong instance, or a point in time before the practice existed |
| `audit` | visits came back without the §10.2 trail, which is the one record a practice cannot rebuild |
| `freshness` | rows dated *after* the restore target: this is not the instance the drill thinks it is |

A `warn` is a database that is intact with something worth reading — a quiet practice, a snapshot ahead of
the checkout (which is what a §13.3 rollback looks like), or no restore target given.

### 4. Put it back in service, or throw it away

A drill throws it away. A real restore does not: the app is pointed at the new endpoint by updating
`DATABASE_URL` in SSM and redeploying (`docs/RUNBOOK.md`), and the old instance is kept until the new one has
been through a business day. A restore is also the only way back from a migration the previous release cannot
read, which is why `docs/RUNBOOK.md` sends a rollback here when the schema moved.

```bash
aws rds delete-db-instance --db-instance-identifier "$DRILL" \
  --skip-final-snapshot --delete-automated-backups
aws rds wait db-instance-deleted --db-instance-identifier "$DRILL"
```

Check the bill afterwards: an orphaned drill instance is about $15 a month of nobody noticing. The
`purpose=restore-drill` tag above is how to find one.

### 5. Write it down

Add a row. A drill nobody recorded is a drill nobody can prove, and the numbers are the argument for the next
instance size.

| Date | Stage | Target | Available after | Verdict | Notes |
|---|---|---|---|---|---|
| _(first real drill goes here, once there is a deployed stage to run it against)_ | | | | | |

**Objectives.** Recovery point: 5 minutes, which is the point-in-time granularity RDS gives and the number
step 1 measures. Recovery time: 60 minutes from the decision to restore to the app answering, of which the
restore itself is the 10–25 minutes in step 2.

## Rehearsing the verification without AWS

Steps 1, 2 and 4 need an AWS account. Step 3 does not — it is a script and a database — so it is rehearsed on
every check run instead of only once a quarter:

```bash
npm run restore:drill                      # against DATABASE_URL
npm run restore:drill -- --url "postgresql://..." --restored-to 2026-10-15T09:00:00Z
```

`scripts/agent-check.sh` runs it after the Playwright suite, against the throwaway database the suite has just
finished driving — a database with a practice, patients, visits and an audit trail in it, which is the shape
step 3 asks about. It is not a restore, and it does not pretend to be. What it keeps honest is the part of the
drill most likely to rot between quarters: that the script still runs, still reads the schema it expects, and
still prints a verdict somebody can act on.

The checks themselves are unit-tested against the ways a restore comes back wrong — `lib/restore.test.ts`.
