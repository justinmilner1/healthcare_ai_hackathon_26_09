# HIPAA checklist

Design §10.7. Owner: compliance.

Sweet Spot handles protected health information: a patient's name, phone number, email address, the glucose
and sleep exports they share, the places they went, what they typed to Sweetie, and the brief Sour writes for
their clinician. Everything below is what carries that, who owns it, and what is still missing.

This is a checklist, not a certificate. Read it as two separate claims:

- **The technical safeguards** of the Security Rule (§164.312) are implemented in this repository, and each row
  below names the code and the tickets that implement it. Those rows are checkable: the file is there or it is
  not, the test passes or it does not.
- **The administrative and organisational safeguards** (§164.308, §164.314, §164.316) are mostly *not* done,
  because they are signatures, designations and policies rather than code. [Open items](#open-items) is that
  list. Until it is empty this deployment must not be pointed at a real patient.

Status in every table below is one of:

| Status | Means |
|---|---|
| `in place` | Implemented and covered by a test in this repository |
| `partial` | Implemented for one path, or implemented and waiting on a configuration a deployment supplies |
| `open` | A ticket exists and is not merged |
| `human` | No code can do it: a signature, a named person, a policy, a decision |

Tickets are the `T<nn>` issues of `docs/ROUTINES.md`. A ticket named here without a status of `open` is merged.

## Owners

The repository already names an owner on the first line of every module, and `security/audit-exceptions.json`
uses the same vocabulary. This document uses it too, so an item's owner is the same word here as it is in the
code that implements it.

| Owner | Covers | Accountable today |
|---|---|---|
| `compliance` | audit log, logging hygiene, CSRF, rate limits, the dependency gate, this document | Justin Milner |
| `identity` | sign-in, roles, patient link verification, sessions | Justin Milner |
| `platform` | data model, jobs, Dexcom, configuration, token encryption | Justin Milner |
| `ops` | the AWS stack, deploys, alarms, backups, demo mode | Justin Milner |
| `sweetie` | the patient conversation and the consent screen | Justin Milner |
| `sour` | the clinical brief and the follow-up questions | Justin Milner |
| `quality` | unit tests, the e2e suite, CI | Justin Milner |

One person holds all seven today, which is honest for a pre-launch repository and is itself a finding: §164.308(a)(2)
wants a named Security Official, and §164.308(a)(3) wants the workforce separation that one person cannot
provide. Both are in [Open items](#open-items). Where this document says a *role* is accountable — a practice
admin, an operator — it means the customer's own staff, not ours.

## Business associate agreements

Every third party that stores, transmits or processes PHI on our behalf needs a BAA in place **before** it sees
any. Nothing below is signed: the repository has never been deployed with real data.

| Counterparty | What it would process | BAA | Status | Owner |
|---|---|---|---|---|
| **AWS** | RDS (all of it), S3 (the exports), KMS, SSM, SES (addresses and links), SNS (phone numbers), CloudWatch (logs, which carry no PHI by §10.3), Amplify Hosting (serves every request), Lambda and EventBridge Scheduler (the job tick) | The AWS BAA, accepted once in AWS Artifact for the account | `human` — not accepted | `ops` |
| **Amazon Bedrock** | the model gateway. Sweetie's turns and Sour's input are PHI and both go through it (`lib/llm.ts`) | Covered by the same AWS BAA, and only while `OPENAI_BASE_URL` points at Bedrock | `human` — not accepted | `platform` |
| **Dexcom** | glucose for a patient who connects their account rather than uploading a file (§9.2) | Dexcom's own agreement, part of the production application | `human` — sandbox only today, no production app approved | `platform` |
| **Twilio** | phone numbers and the invite text, only where `SMS_PROVIDER=twilio` | Twilio's BAA | `human` — not needed unless a deployment chooses Twilio over SNS | `ops` |
| **Resend** | email addresses and the invite link, only where `EMAIL_PROVIDER=resend` | Resend's BAA | `human` — not needed unless a deployment chooses Resend over SES | `ops` |

Two things deliberately do **not** need one:

- **GitHub.** It holds this repository, and Amplify clones from it at build time. No PHI goes in: fixtures under
  `data/fixtures/` are synthetic (T25), `.env` and `data/` are gitignored, and the audit page's own screenshots
  are taken against a throwaway database (`docs/screenshots/tickets/t12/README.md`). Keeping it that way is a
  rule both routines follow (`docs/ROUTINES.md`).
- **A direct model vendor.** `OPENAI_BASE_URL` can point anywhere the OpenAI SDK speaks to, and a deployment
  that points it at a vendor's own endpoint has moved PHI to a processor with no agreement. That is a
  configuration mistake, not a supported option — see the risk `R2` below.

AWS is the only counterparty the service cannot run without. The rest are switches, and the BAA is needed only
once the switch is on.

## Access control

§164.312(a)(1) — unique identification, emergency access, automatic logoff, and encryption. §164.312(d) is
authentication and is in the same table because the same code does both.

| Control | How it works here | Where | Tickets | Status | Owner |
|---|---|---|---|---|---|
| Unique user identification | Every provider is a `User` row in a practice, invited by an admin. No shared accounts, no seeded logins outside demo mode | `lib/auth.ts`, `lib/team.ts` | T05, T06 | `in place` | `identity` |
| Authentication, provider | Auth.js magic link to the user's own mailbox. The link is single-use and lives 15 minutes; email possession is the factor | `lib/auth.ts`, `lib/mailer.ts` | T05 | `in place` | `identity` |
| Authentication, patient | A patient link is not a credential on its own: opening it sends a six-digit code to the phone or email on the visit. Ten-minute code, three attempts, then the code is spent | `lib/patientSession.ts` | T08 | `in place` | `identity` |
| Role-based authorisation | Three roles — admin, clinician, staff — and a capability table. A route asks for a capability, never for a role | `lib/access.ts`, `lib/guard.ts` | T06 | `in place` | `identity` |
| Minimum necessary | A patient session is bound to one visit by `visitId`, so one cookie opens one visit and no other. A clinician sees their practice's visits and no other practice's | `lib/patientSession.ts`, `lib/visitStore.ts` | T03, T08 | `in place` | `identity` |
| Automatic logoff | Provider sessions idle out after 12 hours and are refreshed at most every 15 minutes. A verified patient session lives 24 hours | `lib/auth.ts`, `lib/patientSession.ts` | T05, T08 | `in place` | `identity` |
| Brute force and abuse | Rate limits on every public route, by IP before the body is read and by visit once a token has named one | `lib/ratelimit.ts`, `docs/SECURITY.md` §3 | T10 | `in place` | `compliance` |
| Consent before collection | The first screen behind the code says what the check-in collects, that it is optional, that a clinician reads it, and how to have it deleted. The acceptance is stored | `lib/consent.ts` | T07, T09, T51 (`open`) | `partial` | `sweetie` |
| Encryption and decryption | At rest: RDS `storageEncrypted`, S3 SSE, Dexcom refresh tokens under a KMS key with the patient id as the encryption context, so a ciphertext moved into another patient's row fails to decrypt. Keys are per stage, and a production deployment with Dexcom credentials and no `DEXCOM_TOKEN_KMS_KEY_ID` is refused at boot — the locally derived key exists for development and the demo only | `infra/lib/sweetspot-stack.ts`, `lib/dexcom.ts`, `lib/config.ts` | T11, T24, T29, T30, T31 | `in place` | `platform` |
| Emergency access | The database password is generated by RDS into Secrets Manager and an operator can reach the database directly from a CIDR the stage names. There is no break-glass application account, on purpose: an emergency read is a `psql` session that the practice's own audit page does not see | `docs/DEPLOY.md` §"Open the database" | T30 | `partial` — see risk `R1` | `ops` |
| Secrets | SSM Parameter Store, six `SecureString` parameters written by hand once; nothing secret in the repository, the template, the logs or the client bundle. A missing or weak one refuses the boot | `lib/config.ts`, `docs/DEPLOY.md` | T30, T31 | `in place` | `platform` |

## Audit controls

§164.312(b) — "record and examine activity in information systems that contain or use electronic protected
health information". §10.2 names what has to be recorded and `docs/AUDIT.md` is the detail.

| Control | How it works here | Where | Tickets | Status | Owner |
|---|---|---|---|---|---|
| Reads of a visit | One row per part read — `intake`, `messages`, `summary`, `uploads` — with the actor, so "who saw the transcript" is a query | `lib/auditLog.ts`, `lib/auditStore.ts` | T12 | `in place` | `compliance` |
| Patient link verification | `patient.verified`, with the method and not the code | `lib/patientSession.ts` | T08, T12 | `in place` | `compliance` |
| Every send | `invite.sent`, `code.sent`, `summary.sent`, `deletion.sent`, and what the provider said about delivery | `lib/notifyStore.ts` | T19, T12 | `in place` | `compliance` |
| Every deletion | `patient.deleted` for the staff action, one `retention.swept` row per visit the nightly job clears, and `storage.orphans_purged` when a later pass empties a prefix the object store had refused | `lib/retention.ts`, `lib/retentionStore.ts` | T14, T70 | `in place` | `compliance` |
| Clinical sign-off | `summary.reviewed`, and `summary.question` for each follow-up put to the model | `lib/review.ts`, `lib/followUps.ts` | T16, T18 | `in place` | `sour` |
| No PHI in the record | `detail` goes through an allow-list, and `lib/auditLog.test.ts` feeds it every shape PHI arrives in and reads the JSON back | `lib/auditLog.ts` | T12 | `in place` | `compliance` |
| Readable by the practice | `app/provider/audit`, admin-only, filterable by action, actor, visit, upload and date range | `app/provider/audit` | T12 | `in place` | `compliance` |
| Exportable | CSV from the same screen, with the same filters applied | `lib/auditLog.ts` | T12 | `in place` | `compliance` |
| Application logs carry no PHI | One JSON line per event with a request id; every field outside the allow-list is dropped, ids included deliberately. A lint rule plus `lib/log.test.ts` stop application code writing to stdout at all | `lib/log.ts`, `docs/LOGGING.md` | T13, T40, T58 | `in place` | `compliance` |
| Log review | CloudWatch metric filters and six alarms to an SNS topic: 5xx rate, job failures, model failures, model degraded, the job tick, database storage | `infra/lib/sweetspot-stack.ts`, `docs/DEPLOY.md` §"The alarms" | T29, T30 | `partial` — the alarms fire and both groups expire (30 days staging, 90 production in `infra/lib/stage.ts`; a month on the jobs-tick group); nobody is named to read them, because `alarmEmail` is empty for both stages in `infra/cdk.json`, so the topic has no subscriber | `ops` |
| The audit record survives the data | §10.4's sweep deletes a visit and leaves its rows | `lib/retention.ts` | T14 | `in place` | `compliance` |
| Tamper resistance | None beyond database access control: a row is an ordinary Postgres row and nothing in the app writes to it twice, but anyone with the database password can delete one | — | — | `open` — risk `R4` | `compliance` |

## Integrity

§164.312(c)(1) — PHI is not improperly altered or destroyed. §164.312(c)(2) wants a mechanism to corroborate it.

| Control | How it works here | Where | Tickets | Status | Owner |
|---|---|---|---|---|---|
| One shape for the data | `lib/types.ts` is the contract both ends depend on, and the migration that moved the hackathon schema onto the visit model is a script with its own tests | `lib/types.ts`, `lib/migrateVisits.ts` | T02, T03 | `in place` | `platform` |
| Parsers refuse bad input rather than guess | Size cap of 20 MB checked before the body is read, type sniffing, parse on the server, and a plain-language reason on failure. Deterministic and unit-tested against fixtures | `lib/uploads.ts`, `lib/glucose.ts`, `lib/location.ts`, `lib/sleep.ts` | T11, T25, T42 (`open`) | `partial` | `platform` |
| Uploads are stored once and never rewritten | S3 is private, versioned and TLS-only; the key is server-side and the browser never receives another patient's | `lib/storage.ts`, `infra/lib/sweetspot-stack.ts` | T11 | `in place` | `platform` |
| Jobs do not duplicate or lose work | The queue has attempts, backoff and an idempotency key, so a retried `sour.run` replaces its own output instead of writing a second brief | `lib/jobs.ts`, `lib/sourRun.ts`, `docs/JOBS.md` | T04, T15 | `in place` | `platform` |
| The brief is attributable | A summary carries who signed it off and when, and the sign-off is an audit row as well as a column | `lib/review.ts` | T16, T17 | `in place` | `sour` |
| The model never silently invents | Sour's patterns must cite the data they came from, the agent never diagnoses or changes medication, and a gateway failure degrades to a visible scripted state rather than a plausible blank | `lib/prompts.ts`, `lib/sourRun.ts`, `lib/sweetie.ts` | T20, T63 (`open`) | `partial` | `sour` |
| Safety scan before anything else | Each patient message goes through a deterministic red-flag regex before the model sees it, and a flag changes what the patient is told | `lib/sweetie.ts` | T21, T66 (`open`) | `partial` | `sweetie` |
| Configuration cannot drift | Every variable is declared with a level and a validator, and a production boot with a required one missing or weak is refused | `lib/config.ts` | T31 | `in place` | `platform` |
| Corroboration | Typecheck, lint, unit tests for every `lib/` module with a coverage table, the `/infra` synth and its tests, and a Playwright suite over both flows, on every pull request | `scripts/agent-check.sh`, `.github/workflows/ci.yml` | T25, T26, T29, T38 (`open`), T42 (`open`) | `partial` | `quality` |
| Transport integrity | `rds.force_ssl=1`, TLS-only bucket policy, CSRF on every state-changing route — see the next table | — | T27, T30 | `in place` | `compliance` |

## Transmission security

§164.312(e)(1) — integrity controls and encryption in transit.

| Control | How it works here | Where | Tickets | Status | Owner |
|---|---|---|---|---|---|
| HTTPS to the browser | Amplify Hosting serves TLS; HSTS is set in middleware | `middleware.ts`, `lib/security.ts` | T27 | `in place` | `compliance` |
| TLS to the database | `rds.force_ssl=1` in the parameter group, so the *server* refuses a plaintext connection, and `sslmode=require` in the URL | `infra/lib/sweetspot-stack.ts`, `docs/DEPLOY.md` | T30 | `in place` | `ops` |
| TLS to S3 | A bucket policy that denies anything arriving without it | `infra/lib/sweetspot-stack.ts` | T11, T29 | `in place` | `platform` |
| TLS to every other service | SES, SNS, KMS, SSM, Bedrock and Dexcom are all HTTPS endpoints reached through their SDKs with no plaintext fallback | `lib/email.ts`, `lib/sms.ts`, `lib/dexcom.ts`, `lib/llm.ts` | T19, T24 | `in place` | `platform` |
| Security headers | CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, frame and permissions policy, set in middleware for every response | `middleware.ts`, `docs/SECURITY.md` §1 | T27 | `in place` | `compliance` |
| CSRF | Middleware refuses an unsafe method with no token. Client code that changes something calls `apiFetch`, never bare `fetch`, and the three exemptions are written down and tested | `lib/csrf.ts`, `docs/SECURITY.md` §2 | T27 | `in place` | `compliance` |
| Webhook authenticity | The SES and SNS delivery feed verifies the message signature before it is believed | `lib/snsSignature.ts`, `lib/snsEvents.ts` | T19 | `in place` | `ops` |
| Nothing clinical in a message | Every one of the five templates carries a link and a practice name, never a number or a finding, so an intercepted text or a bounce notification discloses nothing | `lib/notify.ts`, `docs/NOTIFICATIONS.md` | T19 | `in place` | `ops` |
| Links expire | Sign-in link 15 minutes, patient code 10 minutes, patient session 24 hours, and a link token never reaches a log line | `lib/auth.ts`, `lib/patientSession.ts`, `lib/log.ts` | T05, T08, T13 | `in place` | `identity` |
| Dependency surface | `npm audit` at high and above gates CI; an advisory either gets fixed or gets a dated, owned, expiring entry in `security/audit-exceptions.json` | `lib/audit.ts`, `security/audit-exceptions.json`, `docs/SECURITY.md` §4 | T27 | `in place` | `compliance` |
| The database is reachable from the internet | Amplify's SSR compute cannot join a VPC. TLS, a 32-character generated password and a security group that opens to nothing until a stage names a CIDR carry the weight instead | `docs/DEPLOY.md` | T30 | `partial` — risk `R1` | `ops` |

## Contingency plan

§164.308(a)(7) — data backup, disaster recovery, emergency mode operation, testing, and criticality analysis.

| Control | How it works here | Where | Tickets | Status | Owner |
|---|---|---|---|---|---|
| Data backup | RDS automated backups, 7-day retention, per stage, taken in a window the stack pins (07:00–07:30 UTC) so a restore can name the snapshot it is reaching for; a failed backup publishes an RDS event to the alarm topic, because there is no metric for one; deletion protection on any stage that retains data | `infra/lib/sweetspot-stack.ts` | T30, T33 | `in place` | `ops` |
| Uploaded files | The bucket is versioned, so an overwrite or a delete is recoverable until the version is | `infra/lib/sweetspot-stack.ts` | T11 | `in place` | `platform` |
| Restore procedure | A point-in-time restore to a second instance, step by step, with the expected output of each command and the three flags a hurried restore gets wrong — and a verification step that is a script rather than an eyeball, because a restore always *succeeds* | `docs/BACKUPS.md`, `lib/restore.ts`, `scripts/restore-drill.ts` | T33 | `partial` — written, and its verification step rehearsed on every check run; no drill has been run end to end because no stage is deployed | `ops` |
| Disaster recovery | A redeploy of the previous tag, migrations as a pre-deploy step, and a rollback that is the same workflow run with an older tag; where the schema moved, a restore is the way back | `docs/RUNBOOK.md`, `.github/workflows/release.yml`, `docs/BACKUPS.md` | T30, T33 | `partial` — an RPO of 5 minutes and an RTO of 60 are now stated (`docs/BACKUPS.md`), but neither has been measured against a real restore and nothing is tested across a region | `ops` |
| Emergency mode operation | The service degrades instead of failing: Sweetie answers from its scripted path, Sour defers with a visible state and retries, uploads retry, and `GET /api/health` says which dependency is down | `lib/llm.ts`, `lib/health.ts`, `lib/sourRun.ts` | T20, T28 | `in place` | `platform` |
| Testing and revision | The drill's verification step runs on every `scripts/agent-check.sh`, against the database the Playwright suite has just driven, and its four checks are unit-tested against the ways a restore comes back wrong | `scripts/agent-check.sh`, `lib/restore.test.ts` | T33 | `partial` — the part that needs no AWS account is rehearsed every run; the drill itself is quarterly, needs a deployed stage, and the record table in `docs/BACKUPS.md` has no rows yet | `ops` |
| Operational procedures | Deploy, rollback, rotating each of the six secrets, restoring a backup, a bounce or a complaint, a deletion request, and what to do about each of the six alarms — each written out as commands, with what it costs while it is half-done | `docs/RUNBOOK.md`, `docs/BACKUPS.md` | T30, T33, T35 | `in place` | `ops` |
| Criticality analysis | The database is the only irreplaceable thing. Uploads are re-uploadable by the patient, a brief is re-derivable from them, and the job queue is re-drainable | `docs/JOBS.md` | T04 | `partial` — written here, not in a signed document | `ops` |
| Retention and disposal | A nightly `retention.sweep` deletes visit data past the practice's window, default 365 days, leaving the audit row. A staff deletion removes a patient end to end, S3 objects included, and records it | `lib/retention.ts`, `lib/storage.ts` | T14 | `in place` | `compliance` |

## Risk assessment

§164.308(a)(1)(ii)(A). Each risk is to the confidentiality, integrity or availability of PHI. "Likelihood" and
"impact" are this document's own judgement, not a vendor's score, and `L`/`M`/`H` is the whole scale.

| Id | Risk | L | I | What reduces it today | Ticket | Owner |
|---|---|---|---|---|---|---|
| `R1` | **The database answers from the internet.** Amplify SSR cannot join a VPC, and a stage that names `0.0.0.0/0` in `dbAllowedCidrs` to let the build connect has only TLS and a password between an attacker and every row | M | H | `rds.force_ssl=1`, a 32-character RDS-generated password that never passes through the template or the repository, a group that opens to nothing by default, and a `cdk synth` warning while the list is empty. Closing it properly needs VPC-attached compute or a bastion | T30; a VPC ticket does not exist yet | `ops` |
| `R2` | **PHI to a model gateway with no BAA.** `OPENAI_BASE_URL` points wherever it is told, and Sweetie's turns are PHI | M | H | §10.6 keeps the value in SSM where only an operator sets it, and `npm run config:check` lists it among the variables an operator reviews. Nothing refuses a non-Bedrock host | T31 for the gate; a host allow-list does not exist yet | `platform` |
| `R3` | **Browser speech sends the patient's voice to the browser vendor.** Sweetie's listen button is the Web Speech API, which in Chrome means audio leaves the device to a service that is not ours and has no BAA | M | M | Voice is opt-in and press-to-talk, the transcript is what the app stores, and server-side speech is a §14 non-goal. The consent screen does not mention it, which it should | needs a ticket — see [Open items](#open-items) | `sweetie` |
| `R4` | **The audit log is an ordinary table.** Anyone with the database password can delete the record of what they read | L | H | Access to that password is the control, and §10.6 keeps it in SSM. An append-only store or a periodic export off-box is what would actually fix it | needs a ticket | `compliance` |
| `R5` | **One person holds every role.** No separation of duties, no second pair of eyes, and nobody to escalate to | H | M | Pull-request review by a second routine, CI that cannot be bypassed, and the branch protections in `docs/RUNBOOK.md` §"What a human has to have done once" | The protections are written down; applying them and naming the official are `human` | `ops` |
| `R6` | **A provider mailbox is the whole factor.** A magic link means whoever reads that inbox is the clinician | M | H | 15-minute single-use links, 12-hour idle sessions, every read audited, and the practice's own admin can remove a user. No MFA | needs a ticket | `identity` |
| `R7` | **The uploads fallback is a footgun in production.** No `UPLOADS_BUCKET` means `lib/storage.ts` writes exports to local disk, where they are unencrypted at rest, lost on the next redeploy and invisible to the other instance | L | H | `UPLOADS_BUCKET` is `recommended`, so a production boot without it warns and names the consequence, and `STORAGE_BACKEND=s3` with no bucket is a refusal. A warning is not a refusal, which is the gap. The sibling fallback — a locally derived Dexcom token key — *is* refused in production (§3.7), and this one could be too | T31 | `platform` |
| `R8` | **Retention is a number a practice can raise.** The default is 365 days; nothing caps it | L | M | The sweep runs nightly and writes a row per visit it clears, and a patient can ask for deletion at any time from the consent screen's own wording | T14 | `compliance` |
| `R9` | **Demo and real data in one deployment.** A synthetic practice shares the database with real ones | L | M | Demo practices are flagged, excluded from retention sweeps and alarms, never emailed a real address, and marked in the dashboard | T32 | `ops` |
| `R10` | **A dependency advisory is waived rather than fixed.** Four are waived today | L | M | Every exception needs a reason, a named owner and an expiry no more than 90 days out, and the gate fails once an expiry passes. All four are build-time or dev-only and none is in the server runtime or the client bundle | T27 | `compliance` |

A real risk assessment is also an asset inventory, a threat list and a dated sign-off by the Security Official.
This table is the engineering half of one.

## Open items

Nothing here can be closed by writing code, except where a ticket is named.

| Item | Rule | What it needs | Owner |
|---|---|---|---|
| Accept the AWS BAA in AWS Artifact | §164.308(b), §164.314(a) | Someone with the AWS account's legal authority | `ops` |
| Dexcom production agreement | §164.308(b) | The production application Dexcom has to approve (§9.2) | `platform` |
| Designate a Security Official and a Privacy Official | §164.308(a)(2), §164.530(a) | A named person, written down. One person may hold both; it cannot be "the team" | `ops` |
| Workforce security, training, and a sanction policy | §164.308(a)(3), (a)(5) | Policies, and a record that each person was trained | `ops` |
| Written policies and procedures, kept six years | §164.316 | A document store outside this repository | `compliance` |
| An incident response procedure | §164.308(a)(6) | `docs/RUNBOOK.md` is the repair for each alarm and each failure mode. What is not written is the process around it: who is on call, how an alarm becomes an incident, where it is recorded, and at what point it becomes the breach assessment in the row below | `ops` |
| Breach notification procedure | §164.400–414 | Who decides, who notifies, in what order, inside 60 days | `compliance` |
| Notice of Privacy Practices, and patient rights | §164.520, §164.524, §164.526 | The practice's own, plus a path for a patient to get a copy of or amend what we hold. The app has deletion (§10.5) and no export-to-patient | `compliance` |
| Run the restore drill once for real | §164.308(a)(7)(ii)(B), (D) | The procedure is written (`docs/BACKUPS.md`, T33) and its verification step runs on every check; running the whole thing needs a deployed stage, and the record table there is empty until somebody does | `ops` |
| Ratify the RPO and the RTO | §164.308(a)(7) | `docs/BACKUPS.md` states 5 minutes and 60 minutes, derived from what the backup settings give rather than from what a practice needs. A product decision has not confirmed them, and no drill has measured them | `ops` |
| Somebody subscribed to the alarm topic, and the log retention written down as a decision | §164.308(a)(1)(ii)(D), §164.316(b)(2) | `alarmEmail` is empty for both stages, so every alarm of §11.1 and every RDS event of §11.4 publishes to a topic with no subscriber. The groups do expire — 30 days staging, 90 production — but nobody has recorded that those are the right numbers; six years is the Rule's floor for the records it names, and application logs are not those records, which is the argument and is written nowhere | `ops` |
| Disclose browser speech on the consent screen | §164.520, risk `R3` | A line in T09's screen, or the listen button off by default. Needs a ticket | `sweetie` |
| MFA for providers, or a documented decision not to | risk `R6` | A ticket. A magic link is one factor | `identity` |
| Audit log tamper resistance | §164.312(b), risk `R4` | A ticket: append-only, or an export off-box | `compliance` |

## Keeping this current

This document is wrong the moment a control changes and it does not. Three habits keep it honest:

- A pull request that changes a control named here updates its row in the same pull request. `grep` for the
  ticket number: every row that cites one is a place that has to agree with the code.
- The reviewer routine's sweep (`docs/ROUTINES.md`) treats a row that no longer matches the code as a bug, and
  files it like any other.
- Every exception in `security/audit-exceptions.json` has an expiry, and the dependency gate fails when one
  passes. That is the one part of this checklist that enforces its own review.
