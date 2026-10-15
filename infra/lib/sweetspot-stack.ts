// The Sweet Spot stack (design §3.6). One class, two instances: staging (T29) and production. Owner: ops.
//
// Everything the app needs that is not the app: the Amplify Hosting app it is served from, the RDS Postgres it
// reads (§3.2), the private S3 bucket uploads land in (§3.3), the SES identity and SNS topics notifications go
// through (§8), the EventBridge schedule that drains the job queue every minute (§3.4), the SSM parameters that
// carry configuration (§3.7, §10.6), and the CloudWatch alarms that say when any of it is broken (§11.1).
//
// Three things to know before reading:
//
//   1. **`cdk synth` has to pass with no AWS account.** CI and both routines synthesize this stack as the check
//      that it is well formed (§12.4), in a sandbox with no credentials, so nothing here may do a context
//      lookup (`Vpc.fromLookup`, `HostedZone.fromLookup`) or read a secret at synth time. Values a deployment
//      has to supply come from `cdk.json` context via lib/stage.ts, and a stage with none still synthesizes.
//
//   2. **Secrets are a deploy step, not a resource.** §10.6 puts them in SSM Parameter Store, and
//      CloudFormation cannot create a SecureString parameter. So the stack creates the *plain* parameters, and
//      the SecureString names it expects are an output and a documented `aws ssm put-parameter` step in
//      docs/DEPLOY.md. The one secret CloudFormation does manage is the database password, which RDS generates
//      into Secrets Manager because that is the only way to not have it pass through a template.
//
//   3. **Amplify Hosting's SSR compute cannot join a VPC.** That is a platform limit, not a choice, and it
//      decides the database's posture: see `database()`.

import * as cdk from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { StageConfig, parameterPrefix } from "./stage";

export interface SweetSpotStackProps extends cdk.StackProps {
  readonly config: StageConfig;
}

/** The env var names whose values are secret, so SSM holds them as SecureStrings a human puts there. */
export const SECURE_PARAMETERS = [
  "DATABASE_URL", // composed from the RDS endpoint and the generated password; see docs/DEPLOY.md
  "AUTH_SECRET", // §5.1, `openssl rand -base64 32`
  "JOBS_SECRET", // §3.4, what the schedule below sends as `Authorization: Bearer`
  "OPENAI_API_KEY", // §3.5, the Bedrock API key; without it the app runs scripted (§11.3)
  "DEXCOM_CLIENT_ID", // §9.2, optional until the Dexcom application exists
  "DEXCOM_CLIENT_SECRET",
] as const;

export class SweetSpotStack extends cdk.Stack {
  readonly config: StageConfig;
  readonly prefix: string;
  readonly parameterPath: string;

  readonly uploads: s3.Bucket;
  readonly db: rds.DatabaseInstance;
  readonly alarmTopic: sns.Topic;
  readonly mailEventTopic: sns.Topic;
  readonly configurationSet?: ses.ConfigurationSet;
  readonly app: amplify.CfnApp;
  private amplifyApp?: amplify.CfnApp;
  readonly appLogs: logs.LogGroup;
  readonly jobsTick: lambda.Function;
  readonly dexcomTokenKey: kms.Key;

  constructor(scope: Construct, id: string, props: SweetSpotStackProps) {
    super(scope, id, props);
    const config = props.config;
    this.config = config;
    // Every physical name is stage-scoped, so staging and production can live in one account without a
    // collision and so an alarm's name says which deployment it is about.
    this.prefix = `sweetspot-${config.stage}`;
    this.parameterPath = parameterPrefix(config.stage);

    this.dexcomTokenKey = this.tokenKey();
    this.uploads = this.uploadsBucket();
    this.alarmTopic = this.topic("Alarms", "alarms", "CloudWatch alarms for this deployment (design §11.1)");
    this.mailEventTopic = this.topic("MailEvents", "mail-events", "SES bounces and complaints, and inbound SMS (design §8.1)");
    this.configurationSet = this.sesIdentity();
    this.db = this.database();
    const { app, branch, logGroup } = this.hosting();
    this.app = app;
    this.appLogs = logGroup;
    this.configParameters();
    this.jobsTick = this.jobRunnerSchedule();
    this.alarms();
    this.outputs(branch);

    cdk.Tags.of(this).add("app", "sweetspot");
    cdk.Tags.of(this).add("stage", config.stage);
  }

  // -----------------------------------------------------------------------------------------------
  // Keys, files, topics

  /**
   * §10.1: the Dexcom refresh tokens in the database are encrypted with KMS, not with a key derived from the
   * client secret (which is what lib/dexcom.ts falls back to for local development). The app reads the id of
   * this key from `DEXCOM_TOKEN_KMS_KEY_ID`.
   */
  private tokenKey(): kms.Key {
    return new kms.Key(this, "DexcomTokenKey", {
      alias: `alias/${this.prefix}-dexcom-tokens`,
      description: "Encrypts stored Dexcom refresh tokens (design §4.10, §10.1)",
      enableKeyRotation: true,
      // A deleted key is unreadable ciphertext, which is worse than an orphaned key: retain in both stages.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }

  /**
   * §3.3: the bytes of an uploaded export never go in the database. Private bucket, encrypted at rest (§10.1),
   * TLS-only, versioned so a bad parse cannot destroy the original, and no public access of any kind — the
   * browser reaches it through a presigned PUT, which is why the CORS rule exists at all.
   */
  private uploadsBucket(): s3.Bucket {
    const bucket = new s3.Bucket(this, "Uploads", {
      bucketName: `${this.prefix}-uploads-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      publicReadAccess: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Patient uploads. Even in staging the bucket outlives the stack rather than being emptied by a
      // `cdk destroy` nobody meant to run; §10.5 deletion is a staff action in the app, not a stack action.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
        { id: "expire-old-versions", noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
    });
    bucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      // The presigned PUT is signed for one object for a few minutes; the origin that may use it is this
      // deployment's own. A stage with no domain yet gets the Amplify default domain pattern.
      allowedOrigins: [this.config.appUrl ?? `https://*.amplifyapp.com`],
      allowedHeaders: ["*"],
      maxAge: 300,
    });
    return bucket;
  }

  private topic(id: string, name: string, description: string): sns.Topic {
    const topic = new sns.Topic(this, id, { topicName: `${this.prefix}-${name}`, displayName: description });
    // §10.1 in transit: SNS accepts HTTP as well as HTTPS unless told otherwise.
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
        conditions: { Bool: { "aws:SecureTransport": "false" } },
      }),
    );
    if (id === "Alarms" && this.config.alarmEmail) {
      topic.addSubscription(new subscriptions.EmailSubscription(this.config.alarmEmail));
    }
    return topic;
  }

  /**
   * §8: email goes out through SES. The identity (a domain, or one address while the account is in the SES
   * sandbox) is verified by a human — DNS records for a domain, a click for an address — so the stack can only
   * declare it and print what to verify. The configuration set is what makes §8.1 possible: it publishes every
   * bounce, complaint and delivery to the topic `POST /api/notifications/sns` reads.
   */
  private sesIdentity(): ses.ConfigurationSet | undefined {
    const identity = this.config.emailIdentity;
    if (!identity) return undefined; // a stage that has not chosen a sending domain yet still synthesizes

    const configurationSet = new ses.ConfigurationSet(this, "MailConfigurationSet", {
      configurationSetName: this.prefix,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE, // §10.1: never deliver in plain text
      reputationMetrics: true,
      sendingEnabled: true,
    });
    configurationSet.addEventDestination("MailEvents", {
      destination: ses.EventDestination.snsTopic(this.mailEventTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.DELIVERY, ses.EmailSendingEvent.REJECT],
    });
    new ses.EmailIdentity(this, "MailIdentity", {
      identity: identity.includes("@") ? ses.Identity.email(identity) : ses.Identity.domain(identity),
      configurationSet,
      dkimSigning: true,
    });
    return configurationSet;
  }

  // -----------------------------------------------------------------------------------------------
  // Database

  /**
   * §3.2: RDS Postgres, the same major version `docker-compose.yml` runs locally.
   *
   * The posture needs explaining. Amplify Hosting's SSR compute cannot be attached to a VPC, so an app served
   * from Amplify cannot reach a database in a private subnet — there is no NAT path to buy and no VPC endpoint
   * to add. The database is therefore reachable from outside the VPC, and three things carry the weight
   * instead: `force_ssl` in the parameter group, so §10.1's "TLS to RDS" is the server's rule and not a client
   * courtesy; a security group that opens to nothing by default and only to the CIDRs a deployment names in
   * `dbAllowedCidrs`; and the generated password, which never appears in a template or in this repo.
   *
   * Amplify publishes no stable egress range, so `dbAllowedCidrs` is how a deployment opens the door — an
   * operator's office range for migrations and psql, or `0.0.0.0/0` for a staging deployment that accepts a
   * password-and-TLS-only perimeter. docs/DEPLOY.md spells out that trade; production (T30) is where a
   * VPC-attached compute, or a bastion, earns its cost.
   */
  private database(): rds.DatabaseInstance {
    // Two AZs because RDS requires a subnet group spanning two, and no NAT gateway because nothing in the VPC
    // needs outbound internet: the isolated subnets exist for the database alone.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const securityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      description: "Postgres 5432, open only to the CIDRs this stage names in dbAllowedCidrs",
      allowAllOutbound: false,
    });
    const allowed = this.config.dbAllowedCidrs ?? [];
    for (const cidr of allowed) {
      securityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(5432), `Postgres from ${cidr}`);
    }
    if (allowed.length === 0) {
      // Said out loud at synth time, because the failure it describes is a deployed app that builds, boots and
      // then cannot answer a single request. Amplify publishes no egress range to allow, so a deployment
      // either accepts `0.0.0.0/0` behind force_ssl and a generated password, or moves the compute into the
      // VPC — a decision for a human, written down in docs/DEPLOY.md rather than defaulted to here.
      cdk.Annotations.of(this).addWarningV2(
        "sweetspot:db-closed",
        `dbAllowedCidrs is empty for ${this.config.stage}: nothing, including the Amplify app, can connect to the database. See docs/DEPLOY.md.`,
      );
    }

    const parameterGroup = new rds.ParameterGroup(this, "DbParameters", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_10 }),
      description: "force_ssl so the server, not the client, is what requires TLS (design §10.1)",
      parameters: { "rds.force_ssl": "1", log_min_duration_statement: "2000" },
    });

    return new rds.DatabaseInstance(this, "Database", {
      instanceIdentifier: `${this.prefix}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_10 }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        this.config.dbInstanceClass === "medium" ? ec2.InstanceSize.MEDIUM : ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true, // see the comment above this method
      securityGroups: [securityGroup],
      parameterGroup,
      databaseName: "sweetspot",
      // The password is generated into Secrets Manager and read from there by the operator composing
      // DATABASE_URL. It is the one secret in this stack CloudFormation is allowed to know about, and it
      // still never passes through the template.
      credentials: rds.Credentials.fromGeneratedSecret("sweetspot", { secretName: `${this.prefix}/db` }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100, // storage autoscaling, so a full disk is a bill and not an outage
      storageEncrypted: true, // §10.1 at rest
      multiAz: this.config.multiAz,
      backupRetention: cdk.Duration.days(this.config.backupRetentionDays), // §11.4
      copyTagsToSnapshot: true,
      deleteAutomatedBackups: false,
      autoMinorVersionUpgrade: true,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      deletionProtection: this.config.retainData,
      removalPolicy: this.config.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.SNAPSHOT,
    });
  }

  // -----------------------------------------------------------------------------------------------
  // Hosting

  /**
   * §3.1 and §13.2: the app is Next.js SSR on Amplify Hosting, built from this repository, and every merge to
   * the stage's branch deploys.
   *
   * Connecting the repository needs a GitHub token with `repo` scope, which is a human step: it arrives as the
   * `GitHubAccessToken` template parameter (NoEcho) at deploy time rather than living in SSM, because Amplify
   * stores it itself once given and CloudFormation cannot read a SecureString here.
   *
   * The build spec is where §3.7 and §13.2 meet: it pulls this stage's parameters out of SSM into
   * `.env.production`, runs the migrations, and runs `npm run config:check -- --production` so a deployment
   * missing something required fails the build instead of serving.
   */
  private hosting(): { app: amplify.CfnApp; branch: amplify.CfnBranch; logGroup: logs.LogGroup; role: iam.Role } {
    const accessToken = new cdk.CfnParameter(this, "GitHubAccessToken", {
      type: "String",
      noEcho: true,
      description: "GitHub personal access token with repo scope, for Amplify to clone and watch the repository. Pass an empty string to create the app unconnected and connect it in the console instead.",
    });

    const role = new iam.Role(this, "AppRole", {
      roleName: `${this.prefix}-app`,
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Amplify build and SSR compute role for Sweet Spot",
    });
    // Configuration (§3.7, §10.6). GetParametersByPath is what the build spec below uses; the decrypt is for
    // the SecureStrings in that path, and is narrowed to calls that come through SSM.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [
          cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: `${this.parameterPath.slice(1)}/*` }, this),
          cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: this.parameterPath.slice(1) }, this),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
      }),
    );
    this.uploads.grantReadWrite(role); // §3.3
    this.dexcomTokenKey.grantEncryptDecrypt(role); // §4.10
    this.mailEventTopic.grantPublish(role);
    role.addToPolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["sns:Publish"], resources: ["*"], conditions: { StringEquals: { "sns:Protocol": "sms" } } }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup", "logs:DescribeLogGroups"], resources: ["*"] }));

    // Amplify refuses a repository without a token to clone it with, so the pair is all-or-nothing: with no
    // token the app is created unconnected and a human connects it in the console, which is the same click
    // that authorizes the GitHub app anyway.
    const hasToken = new cdk.CfnCondition(this, "HasAccessToken", {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(accessToken.valueAsString, "")),
    });
    const whenConnected = (value: string) => cdk.Fn.conditionIf(hasToken.logicalId, value, cdk.Aws.NO_VALUE).toString();

    const app = new amplify.CfnApp(this, "App", {
      name: this.prefix,
      description: `Sweet Spot ${this.config.stage} (design §3.1, §13.2)`,
      platform: "WEB_COMPUTE", // Next.js SSR, not a static export
      repository: this.config.repository ? whenConnected(this.config.repository) : undefined,
      accessToken: this.config.repository ? whenConnected(accessToken.valueAsString) : undefined,
      iamServiceRole: role.roleArn,
      enableBranchAutoDeletion: false,
      buildSpec: this.buildSpec(),
    });
    // `appUrl()` reads the app's generated domain for a stage with no domain of its own, so the environment
    // can only be built once the app exists. L1 properties are writable, which is what makes that order legal.
    this.amplifyApp = app;
    app.environmentVariables = this.appEnvironment();

    const branch = new amplify.CfnBranch(this, "Branch", {
      appId: app.attrAppId,
      branchName: this.config.branch,
      stage: this.config.stage === "production" ? "PRODUCTION" : "BETA",
      enableAutoBuild: true, // §13.2: every merge to this branch deploys
      framework: "Next.js - SSR",
      // APP_URL belongs here rather than with the app's other variables: for a stage with no domain of its own
      // it is built from the app's generated domain, and CloudFormation refuses a resource that reads one of
      // its own attributes. Amplify merges a branch's variables over the app's, so the effect is the same.
      environmentVariables: [
        { name: "NODE_ENV", value: "production" },
        { name: "APP_URL", value: this.appUrl() },
      ],
    });

    // §11.1: the app's JSON log lines land in Amplify's own log group for the app. The group is declared here
    // so its retention is configured and so the metric filters in `alarms()` have something to attach to —
    // a filter cannot be created against a log group that does not exist yet, and Amplify would otherwise
    // create it on the first request, after the deploy. Amplify writes into an existing group happily; if a
    // previous deploy of this app already created it, import it rather than letting CloudFormation collide
    // (docs/DEPLOY.md).
    const logGroup = new logs.LogGroup(this, "AppLogs", {
      logGroupName: `/aws/amplify/${app.attrAppId}`,
      retention: this.config.logRetentionDays === 90 ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    return { app, branch, logGroup, role };
  }

  /** `.env.production` from SSM, migrations, the §3.7 gate, then the build. */
  private buildSpec(): string {
    return [
      "version: 1",
      "frontend:",
      "  phases:",
      "    preBuild:",
      "      commands:",
      "        - npm ci",
      // One parameter per line as NAME=value, which is what Next.js reads and what `npm run config:check`
      // judges. --with-decryption covers the SecureStrings a human put there (§10.6).
      `        - aws ssm get-parameters-by-path --path "${this.parameterPath}/" --recursive --with-decryption --query 'Parameters[].[Name,Value]' --output text | awk -F'\\t' '{ sub(/.*\\//, "", $1); printf "%s=%s\\n", $1, $2 }' > .env.production`,
      "        - npx prisma migrate deploy", // §13.2 staging migrates on deploy; §13.3 production gates it on a tag
      "        - npm run config:check -- --production",
      "    build:",
      "      commands:",
      "        - npm run build",
      "  artifacts:",
      "    baseDirectory: .next",
      "    files:",
      "      - '**/*'",
      "  cache:",
      "    paths:",
      "      - node_modules/**/*",
      "      - .next/cache/**/*",
      "",
    ].join("\n");
  }

  /**
   * The non-secret half of §3.7, set on the Amplify app so the SSR compute has it without a lookup. The secret
   * half is in SSM as SecureStrings and has to be entered in the Amplify console once (docs/DEPLOY.md): the
   * build spec above reads SSM, but Amplify's compute environment is set from the app configuration.
   */
  private appEnvironment(): amplify.CfnApp.EnvironmentVariableProperty[] {
    const vars: Record<string, string | undefined> = {
      CONFIG_PARAMETER_PATH: this.parameterPath,
      UPLOADS_BUCKET: this.uploads.bucketName,
      UPLOADS_REGION: this.region,
      STORAGE_BACKEND: "s3", // never silently fall back to the filesystem on a deployment (§3.3)
      DEXCOM_TOKEN_KMS_KEY_ID: this.dexcomTokenKey.keyArn,
      EMAIL_PROVIDER: this.config.emailIdentity ? "ses" : undefined,
      EMAIL_FROM: this.config.emailFrom,
      SES_CONFIGURATION_SET: this.configurationSet?.configurationSetName,
      SNS_TOPIC_ARNS: this.mailEventTopic.topicArn,
      JOBS_RUNNER: "scheduled", // the schedule below is what drains the queue (§3.4)
      OPENAI_BASE_URL: this.config.modelBaseUrl,
      BEDROCK_OPENAI_MODEL_ID: this.config.modelId,
      NODE_ENV: "production",
    };
    return Object.entries(vars)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => ({ name, value }));
  }

  /**
   * The public base URL (`APP_URL`, §3.7): a stage's own domain once it has one, otherwise the branch URL
   * Amplify generates, `https://<branch>.<appId>.amplifyapp.com`. Every patient and provider link is built
   * from this, so a stage that has a domain must set it in context before the first invite goes out.
   */
  private appUrl(): string {
    if (this.config.appUrl) return this.config.appUrl;
    if (!this.amplifyApp) throw new Error("appUrl() needs the Amplify app: call it after hosting()");
    return `https://${this.config.branch}.${this.amplifyApp.attrDefaultDomain}`;
  }

  // -----------------------------------------------------------------------------------------------
  // Configuration parameters

  /**
   * §10.6: configuration lives in SSM Parameter Store, under one path per stage. The values here are the ones
   * that are not secrets — the bucket, the topic, the model, the URL — written by the stack so that they are
   * never copied by hand from a console. The six secret names are in `SECURE_PARAMETERS`, and docs/DEPLOY.md
   * has the `aws ssm put-parameter --type SecureString` line for each: CloudFormation has no SecureString.
   */
  private configParameters(): void {
    const values: Record<string, string> = {
      APP_URL: this.appUrl(),
      UPLOADS_BUCKET: this.uploads.bucketName,
      UPLOADS_REGION: this.region,
      STORAGE_BACKEND: "s3",
      DEXCOM_TOKEN_KMS_KEY_ID: this.dexcomTokenKey.keyArn,
      SNS_TOPIC_ARNS: this.mailEventTopic.topicArn,
      JOBS_RUNNER: "scheduled",
    };
    if (this.config.emailFrom) values.EMAIL_FROM = this.config.emailFrom;
    if (this.config.emailIdentity) values.EMAIL_PROVIDER = "ses";
    if (this.configurationSet) values.SES_CONFIGURATION_SET = this.configurationSet.configurationSetName;
    if (this.config.modelBaseUrl) values.OPENAI_BASE_URL = this.config.modelBaseUrl;
    if (this.config.modelId) values.BEDROCK_OPENAI_MODEL_ID = this.config.modelId;

    for (const [name, value] of Object.entries(values)) {
      new ssm.StringParameter(this, `Param${name.replace(/_/g, "")}`, {
        parameterName: `${this.parameterPath}/${name}`,
        stringValue: value,
        description: `Sweet Spot ${this.config.stage}: ${name}`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }
  }

  // -----------------------------------------------------------------------------------------------
  // The job runner schedule

  /**
   * §3.4: `POST /api/jobs/run` drains due jobs and EventBridge Scheduler calls it every minute with the shared
   * secret. Scheduler's targets are AWS APIs, not arbitrary URLs, so the call is made by a very small Lambda
   * that reads `JOBS_SECRET` out of SSM and POSTs. It is plain JavaScript on the Node runtime's own `fetch`
   * with no dependencies, so there is nothing to bundle and `cdk synth` needs no Docker — which matters,
   * because the sandbox both routines run in has no Docker daemon.
   */
  private jobRunnerSchedule(): lambda.Function {
    const secretParameter = `${this.parameterPath}/JOBS_SECRET`;
    const logGroup = new logs.LogGroup(this, "JobsTickLogs", {
      logGroupName: `/aws/lambda/${this.prefix}-jobs-tick`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, "JobsTick", {
      functionName: `${this.prefix}-jobs-tick`,
      description: "Calls POST /api/jobs/run once a minute with the shared secret (design §3.4)",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/jobs-tick"),
      timeout: cdk.Duration.seconds(60), // one drain pass; the queue's own retries handle the rest
      memorySize: 256,
      logGroup,
      environment: {
        JOBS_URL: `${this.appUrl()}/api/jobs/run`,
        JOBS_SECRET_PARAMETER: secretParameter,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: secretParameter.slice(1) }, this)],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
      }),
    );

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Lets EventBridge Scheduler invoke the job tick",
    });
    fn.grantInvoke(schedulerRole);

    new scheduler.CfnSchedule(this, "JobsSchedule", {
      name: `${this.prefix}-jobs`,
      description: "Drains the Sweet Spot job queue every minute (design §3.4)",
      flexibleTimeWindow: { mode: "OFF" }, // a minute late is a minute of unsent invites
      scheduleExpression: "rate(1 minute)",
      state: "ENABLED",
      target: {
        arn: fn.functionArn,
        roleArn: schedulerRole.roleArn,
        // No retries: the next tick is sixty seconds away, and every job carries its own attempt count and
        // backoff in the `Job` table (§3.4).
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    });
    return fn;
  }

  // -----------------------------------------------------------------------------------------------
  // Alarms

  /**
   * §11.1: alarms on the 5xx rate, on job failures and on the model timeout rate, delivered to an SNS topic.
   *
   * All three read the app's own JSON log lines (§10.3, lib/log.ts): one line per request carries `status`, and
   * the queue and the model client name what went wrong in `event`. A metric filter turns each into a
   * CloudWatch metric, so the alarms measure what the app said happened rather than what a load balancer
   * guessed — and the lines contain no names, no phone numbers and no message text, which is the only reason
   * they can be read by an alarm at all.
   */
  private alarms(): void {
    const namespace = `SweetSpot/${this.config.stage}`;
    const action = new actions.SnsAction(this.alarmTopic);

    const counter = (id: string, metricName: string, pattern: string): cloudwatch.Metric => {
      new logs.MetricFilter(this, id, {
        logGroup: this.appLogs,
        filterName: `${this.prefix}-${metricName}`,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricNamespace: namespace,
        metricName,
        metricValue: "1",
        defaultValue: 0,
      });
      return new cloudwatch.Metric({ namespace, metricName, statistic: "Sum" });
    };

    const alarm = (id: string, metric: cloudwatch.Metric, props: { threshold: number; periodMinutes: number; description: string }) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `${this.prefix}-${id}`,
        alarmDescription: props.description,
        metric: metric.with({ period: cdk.Duration.minutes(props.periodMinutes) }),
        threshold: props.threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // A quiet staging deployment emits no lines at all; silence is not a failure.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
      return a;
    };

    alarm("http-5xx", counter("Http5xxFilter", "http_5xx", "{ $.status >= 500 }"), {
      threshold: 5,
      periodMinutes: 5,
      description: "The app answered 5xx five or more times in five minutes (design §11.1)",
    });
    alarm("job-failed", counter("JobFailedFilter", "job_failed", '{ $.event = "job_failed" }'), {
      threshold: 1,
      periodMinutes: 15,
      description: "A job exhausted its three attempts: an invite, a summary or a deletion did not happen (design §3.4)",
    });
    // §3.5's timeout and §11.3's degraded mode: lib/llm.ts logs `llm_call_failed` for each failed attempt
    // (a timeout among them) and `llm_circuit_opened` when it gives up and goes scripted. The first is a rate
    // worth knowing about, the second means every patient is currently reading scripted replies.
    alarm("model-failures", counter("ModelFailedFilter", "llm_call_failed", '{ $.event = "llm_call_failed" }'), {
      threshold: 10,
      periodMinutes: 15,
      description: "Ten or more model calls timed out or errored in fifteen minutes (design §3.5, §11.1)",
    });
    alarm("model-degraded", counter("ModelCircuitFilter", "llm_circuit_opened", '{ $.event = "llm_circuit_opened" }'), {
      threshold: 1,
      periodMinutes: 15,
      description: "The model circuit opened: Sweetie and Sour are answering from their scripted paths (design §6.3, §11.3)",
    });

    // Not from §11.1, but the two failures that would otherwise be silent: nothing drains the queue, and the
    // database runs out of disk.
    const tickErrors = new cloudwatch.Alarm(this, "jobs-tick-errors", {
      alarmName: `${this.prefix}-jobs-tick-errors`,
      alarmDescription: "The minute schedule could not call POST /api/jobs/run: nothing is draining the queue (design §3.4)",
      metric: this.jobsTick.metricErrors({ period: cdk.Duration.minutes(15), statistic: "Sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    tickErrors.addAlarmAction(action);

    const storage = new cloudwatch.Alarm(this, "db-storage", {
      alarmName: `${this.prefix}-db-storage`,
      alarmDescription: "Less than 2 GiB of database storage left (design §11.4)",
      metric: this.db.metricFreeStorageSpace({ period: cdk.Duration.minutes(15), statistic: "Minimum" }),
      threshold: 2 * 1024 * 1024 * 1024,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    storage.addAlarmAction(action);
  }

  // -----------------------------------------------------------------------------------------------

  /** What an operator needs after a deploy, in the order docs/DEPLOY.md asks for it. */
  private outputs(branch: amplify.CfnBranch): void {
    const out = (id: string, value: string, description: string) => new cdk.CfnOutput(this, id, { value, description });
    out("AmplifyAppId", this.app.attrAppId, "Amplify app id");
    out("AppUrl", this.appUrl(), "Public base URL of this deployment (APP_URL)");
    out("BranchName", branch.branchName, "Branch that deploys to this stage");
    out("DatabaseEndpoint", this.db.dbInstanceEndpointAddress, "RDS endpoint; DATABASE_URL needs ?sslmode=require");
    out("DatabaseSecretArn", this.db.secret?.secretArn ?? "none", "Secrets Manager secret holding the generated database password");
    out("UploadsBucket", this.uploads.bucketName, "Private uploads bucket (UPLOADS_BUCKET)");
    out("AlarmTopicArn", this.alarmTopic.topicArn, "SNS topic every alarm publishes to");
    out("MailEventTopicArn", this.mailEventTopic.topicArn, "SNS topic for SES bounces and complaints (SNS_TOPIC_ARNS)");
    out("ConfigParameterPath", this.parameterPath, "SSM path this deployment reads its configuration from");
    out("SecureParametersNeeded", SECURE_PARAMETERS.join(","), "SecureString parameters a human must put in that path before the first deploy");
  }
}
