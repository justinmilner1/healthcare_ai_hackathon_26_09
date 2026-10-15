#!/usr/bin/env npx tsx
// The CDK app (design §3.6). Owner: ops.
//
// `npx cdk synth` with no arguments synthesizes every stack below, which is what `scripts/infra-check.sh` and
// CI run (§12.4). It needs no AWS credentials: a stage whose `cdk.json` context has no account is synthesized
// env-agnostic, and nothing in the stack does a context lookup.
//
// Two stacks, one class (§13.2, §13.3): `SweetSpot-staging` and `SweetSpot-production`, each configured by its
// own `sweetspot:<stage>` context object in cdk.json. Everything that differs between them is in lib/stage.ts,
// so the difference between a staging deployment and a production one is readable in one file.
//
// `cdk deploy` with no stack named refuses to pick for you now that there are two; deploy one at a time, and
// run `cdk diff SweetSpot-production` first (docs/RUNBOOK.md).

import * as cdk from "aws-cdk-lib";
import { SweetSpotStack } from "../lib/sweetspot-stack";
import { stageConfig } from "../lib/stage";

const app = new cdk.App();

const staging = stageConfig(app, "staging");
new SweetSpotStack(app, "SweetSpot-staging", {
  config: staging,
  description: "Sweet Spot staging: Amplify, RDS, S3, SES, SNS, the job schedule and the alarms (design §3.6, §13.2)",
  // CDK_DEFAULT_* are what `cdk deploy` fills in from the shell's credentials; the context values win so that a
  // stage can name its own account and region, and both being absent is the env-agnostic synth CI does.
  env: {
    account: staging.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: staging.region ?? process.env.CDK_DEFAULT_REGION,
  },
});

const production = stageConfig(app, "production");
new SweetSpotStack(app, "SweetSpot-production", {
  config: production,
  description: "Sweet Spot production: Amplify, RDS, S3, SES, SNS, the job schedule and the alarms (design §3.6, §13.3)",
  env: {
    account: production.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: production.region ?? process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
