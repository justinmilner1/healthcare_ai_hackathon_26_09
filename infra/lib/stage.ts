// Per-stage deployment values (design §3.6, §13.2, §13.3). Owner: ops.
//
// Two stacks come out of one stack class: staging and production. Everything that differs between them is in
// here, read from `cdk.json` context under `sweetspot:<stage>` so that a deployment is configured by editing
// one object rather than by editing CDK code. Nothing in here is a secret: §10.6 keeps those in SSM Parameter
// Store, which CloudFormation cannot write (it has no SecureString support), so they are a documented deploy
// step instead — `docs/DEPLOY.md`.

import { Construct } from "constructs";

export type StageName = "staging" | "production";

/** What a stage's `sweetspot:<stage>` context object may set. All optional: an empty object still synthesizes. */
export interface StageContext {
  /** AWS account to deploy into. Empty means env-agnostic, which is what `cdk synth` in CI does. */
  account?: string;
  region?: string;
  /** Public base URL once a domain is pointed at the Amplify app. Empty until then; see `appUrl` below. */
  appUrl?: string;
  /** SES identity to send from: a domain, or a single address while in the SES sandbox. */
  emailIdentity?: string;
  /** `EMAIL_FROM` for the app. Must be inside `emailIdentity` or SES refuses the send. */
  emailFrom?: string;
  /** Subscribed to the alarm topic. Empty means the topic exists with no subscriber yet. */
  alarmEmail?: string;
  /** GitHub repository Amplify builds from, and the branch that is this stage. */
  repository?: string;
  branch?: string;
  /** Who may open a TCP connection to the database. See `SweetSpotStack` for why this list exists. */
  dbAllowedCidrs?: string[];
  modelBaseUrl?: string;
  modelId?: string;
}

/** A stage's configuration: the context above, with the defaults that make a stack out of it. */
export interface StageConfig extends StageContext {
  stage: StageName;
  branch: string;
  /** Production keeps its data when the stack goes away; staging is rebuildable but still not thrown away by accident. */
  retainData: boolean;
  /** §11.4: RDS automated backups. Seven days for both stages. */
  backupRetentionDays: number;
  /** How long §11.1's JSON log lines are kept before CloudWatch drops them. */
  logRetentionDays: number;
  multiAz: boolean;
  dbInstanceClass: "small" | "medium";
  /**
   * §13.3: production serves tagged releases only. `.github/workflows/release.yml` is the only writer of the
   * stage's branch and it accepts nothing but a `v*` tag, so moving that branch *is* the deploy; the build
   * spec checks the branch it was handed as well, so a build started by hand against anything else stops
   * before the migrations rather than at the first request. Staging deploys every merge instead (§13.2).
   */
  deployFromTag: boolean;
}

/** The fields `stageConfig` fills in when context is silent. */
type StageDefaults = Pick<
  StageConfig,
  "branch" | "retainData" | "backupRetentionDays" | "logRetentionDays" | "multiAz" | "dbInstanceClass" | "deployFromTag"
>;

const DEFAULTS: Record<StageName, StageDefaults> = {
  staging: {
    branch: "main",
    retainData: false,
    backupRetentionDays: 7,
    logRetentionDays: 30,
    multiAz: false,
    dbInstanceClass: "small",
    deployFromTag: false,
  },
  production: {
    // The branch the production Amplify app watches. Nothing but `.github/workflows/release.yml` writes it,
    // and that workflow only ever points it at a `v*` tag's commit (§13.3, docs/RUNBOOK.md).
    branch: "release",
    retainData: true,
    backupRetentionDays: 7,
    logRetentionDays: 90,
    multiAz: true,
    dbInstanceClass: "medium",
    deployFromTag: true,
  },
};

/**
 * Read `sweetspot:<stage>` out of CDK context and fill in the defaults.
 *
 * A missing context object is not an error: `cdk synth` has to work in CI and in the agents' sandbox, where
 * there is no account, no domain and no SES identity. What it produces there is an env-agnostic template,
 * which is exactly what the synth check is for — it proves the stack is well formed, not that it is deployed.
 */
export function stageConfig(scope: Construct, stage: StageName): StageConfig {
  const raw = (scope.node.tryGetContext(`sweetspot:${stage}`) ?? {}) as StageContext;
  const ctx: StageContext = {};
  // Empty strings are how cdk.json says "not set yet" for a value a human has to fill in, so they are dropped
  // rather than passed on as a domain of "" or an account of "".
  for (const [key, value] of Object.entries(raw)) {
    if (value === "" || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    (ctx as Record<string, unknown>)[key] = value;
  }
  return { ...DEFAULTS[stage], ...ctx, stage, branch: ctx.branch ?? DEFAULTS[stage].branch };
}

/** The SSM Parameter Store prefix every parameter for a stage lives under (§10.6). */
export function parameterPrefix(stage: StageName): string {
  return `/sweetspot/${stage}`;
}
