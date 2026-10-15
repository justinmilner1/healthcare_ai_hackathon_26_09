# T29 — the CDK staging stack

T29 changes no screen. The deliverable is `/infra` and `docs/DEPLOY.md`, and the only way to look at a stack
that has not been deployed is to synthesize it — so the evidence is in two parts: the synthesized template
below, and the screens unchanged, which is what a ticket that adds infrastructure should do to the app.

## The screens, unchanged

Taken from the run of `bash scripts/agent-check.sh` that this pull request reports. The new step in that script
sits before the Playwright suite, so these also prove the step does not disturb the suite that follows it.

| File | What it shows |
|---|---|
| `desktop-landing.png` | the landing page, both agents |
| `desktop-provider-dashboard.png` | the practice dashboard after sign-in |
| `desktop-provider-sour.png` | the Sour brief for the seeded visit |
| `desktop-sweetie-start.png` | Sweetie's first question on the patient link |
| `mobile-patient-summary.png` | the patient summary at 375px |

## The stack, synthesized

`bash scripts/infra-check.sh` → install, the §10.8 dependency audit of the CDK tree, typecheck, 14 unit tests,
`cdk synth`. 68 resources in one template, with no AWS account and no Docker daemon:

| Resource | Count |
|---|---|
| `AWS::Amplify::App`, `AWS::Amplify::Branch` | 1, 1 |
| `AWS::RDS::DBInstance`, `DBParameterGroup`, `DBSubnetGroup` | 1, 1, 1 |
| `AWS::S3::Bucket`, `BucketPolicy` | 1, 1 |
| `AWS::SES::EmailIdentity`, `ConfigurationSet`, `ConfigurationSetEventDestination` | 1, 1, 1 |
| `AWS::SNS::Topic`, `TopicPolicy` | 2, 2 |
| `AWS::Scheduler::Schedule`, `AWS::Lambda::Function` | 1, 2 |
| `AWS::SSM::Parameter` | 13 |
| `AWS::Logs::MetricFilter`, `AWS::CloudWatch::Alarm` | 4, 6 |
| `AWS::KMS::Key`, `Alias` | 1, 1 |
| `AWS::IAM::Role`, `Policy` | 4, 4 |
| VPC, two subnets, routes, security group | 11 |
| `AWS::SecretsManager::Secret` (the database password RDS generates), `SecretTargetAttachment` | 1, 1 |
| `Custom::LogRetention` (retention on the exported Postgres logs), `AWS::CDK::Metadata` | 1, 1 |

The ten outputs an operator reads after a deploy:

```
AmplifyAppId  AppUrl  BranchName  DatabaseEndpoint  DatabaseSecretArn
UploadsBucket  AlarmTopicArn  MailEventTopicArn  ConfigParameterPath  SecureParametersNeeded
```

`SecureParametersNeeded` is the list CloudFormation cannot create itself (§10.6 — there is no SecureString in
CloudFormation): `DATABASE_URL`, `AUTH_SECRET`, `JOBS_SECRET`, `OPENAI_API_KEY`, `DEXCOM_CLIENT_ID`,
`DEXCOM_CLIENT_SECRET`. `docs/DEPLOY.md` has the command for each.

Two warnings are expected from that synth and are explained in `docs/DEPLOY.md`: the database is reachable from
outside the VPC, because Amplify Hosting's SSR compute cannot join one, and it is closed to every CIDR until a
deployment names one — which the stack says out loud rather than leaving to be discovered.
