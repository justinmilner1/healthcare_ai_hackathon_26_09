# T33 — backups and the restore drill

T33 changes no screen. The deliverable is `docs/BACKUPS.md`, the backup properties on the RDS instance in
`/infra`, and the drill's verification step as a script (`lib/restore.ts`, `scripts/restore-drill.ts`). So the
evidence is in three parts: the synthesized backup configuration, the drill rehearsal the check run now
performs, and the screens unchanged — which is what a ticket about backups should do to the app.

## The screens, unchanged

From the `bash scripts/agent-check.sh` run this pull request reports. The new step in that script runs after
the Playwright suite, so these also show that it disturbs nothing before it.

| File | What it shows |
|---|---|
| `desktop-landing.png` | the landing page, both agents |
| `desktop-provider-dashboard.png` | the practice dashboard after sign-in, 15 visits |
| `desktop-provider-sour.png` | the Sour brief for the seeded visit |
| `desktop-sweetie-start.png` | Sweetie's first question on the patient link |
| `mobile-patient-summary.png` | the patient summary at 375px |

Three things visible in them are open bugs owned by other tickets, not regressions here: the raw `follow_up`
pill on the patient summary (T41), "LLM not configured: set OPENAI_API_KEY" in the brief's patterns (T63), and
Sweetie saying the upload button is "on the left" (T53).

## The backups, synthesized

From `cdk.out/SweetSpot-staging.template.json` after `bash scripts/infra-check.sh` — 69 resources, one more
than T29's 68, the new one being the event subscription.

| Property | Value | Why |
|---|---|---|
| `BackupRetentionPeriod` | `7` | §11.4, and seven days of point-in-time recovery with it |
| `PreferredBackupWindow` | `07:00-07:30` | ~3am US east. Pinned so docs/BACKUPS.md can state it |
| `PreferredMaintenanceWindow` | `sun:08:00-sun:09:00` | clear of the backup window, which RDS requires |
| `DeleteAutomatedBackups` | `false` | or `cdk destroy` on staging takes the backups with it |
| `CopyTagsToSnapshot` | `true` | a snapshot that says which stage and app it came from |
| `DeletionPolicy` | `Snapshot` (staging), `Retain` (production) | unchanged from T29 |

And `AWS::RDS::EventSubscription sweetspot-staging-db-events`, pointed at the `-alarms` topic, categories
`availability, backup, deletion, failover, failure, low storage`. A failed automated backup publishes an
event and no metric, so without this it is silent until the restore that needs it.

## The drill, rehearsed

Steps 1, 2 and 4 of the drill need an AWS account. Step 3 — "is this the database that went in?" — does not,
so `scripts/agent-check.sh` now runs it after the Playwright suite, against the database the suite has just
driven:

```
== restore drill (rehearsal)
restore drill: localhost:5432/sweetspot_e2e
restore: ok
  migrations  pass  11 applied, none missing
  tables      pass  Practice 21, User 37, Patient 102, Visit 103
  audit       pass  278 rows
  freshness   pass  newest row 0 min before the restore target (limit 60)
  rows        Practice=21 User=37 Patient=102 Visit=103 AuditLog=278 Summary=26 Upload=37
```

The four checks, and the ways each of them fails, are unit-tested in `lib/restore.test.ts` (11 tests).
