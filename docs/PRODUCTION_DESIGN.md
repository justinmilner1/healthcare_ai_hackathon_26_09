# Sweet Spot: production design

Status: agreed 2026-10-10 (Justin). This is the document every ticket cites and every reviewer checks against.
Section numbers are stable; add subsections rather than renumbering.

## 1. Goal and scope

Take the hackathon demo to a state a small endocrinology practice can pilot with real patients. "Production-ready"
here means: deployed on AWS with a real domain, Postgres, provider accounts, verified patient links, a compliance
baseline a practice manager will accept (encryption, audit log, retention and deletion, BAAs), background jobs,
monitoring, tests and CI, and a runbook. It does not mean HIPAA certification, EHR integration, or scale beyond a
few practices.

Decisions already made:
- Hosting: AWS end to end (Amplify Hosting for the Next.js app, RDS Postgres, S3, SES, SNS, Bedrock, EventBridge, CloudWatch). One vendor, one set of BAAs.
- Identity: Auth.js magic links for providers; one-time code verification for patient links. No passwords.
- Model gateway unchanged: `lib/llm.ts` against Bedrock's OpenAI-compatible Responses API; the model id is configuration.
- The agent architecture in `docs/AGENT_ARCHITECTURE.md` stands. Code decides, models write.

## 2. Customer flow

2.1 **Practice onboarding.** An admin signs up with their email (magic link), names the practice, invites clinicians and staff by email. Roles: admin, clinician, staff.

2.2 **Visit creation.** Staff add a visit: patient (new or existing by phone/email), visit date and time, visit type, what the patient called about, contact channel, and a recorded consent to be contacted (who recorded it, when, how). A CSV import creates a day's visits in one go. This is the seam a scheduling integration would plug into later.

2.3 **Invite.** The patient receives a text or email with a link. The message contains the practice name and nothing clinical. Opening the link sends a six-digit code to the same phone or email; entering it starts a short-lived patient session bound to that link. A forwarded link alone reveals nothing.

2.4 **Consent screen.** First open only: what Sweetie collects, that it is optional, that a clinician reviews it, and how to delete it. One tap to continue.

2.5 **Sweetie.** The two-question intake as built, voice or text. Optional data panel: Dexcom connect, Dexcom CSV, Timeline JSON, WHOOP CSV. Deterministic safety scan before every model call; a flag stops the interview and tells the patient to call the office or 911. Ends with the patient's summary link.

2.6 **Sour.** Runs as a background job when Sweetie wraps (and on demand). The clinician is emailed a link. Logged in, they see the one-pager, ask follow-ups, print, and mark it reviewed; reviewer and time are recorded. Safety flags are at the top in red.

2.7 **Patient view.** The patient opens their own summary through the same verified link.

2.8 **Afterwards.** Data is kept per the practice's retention setting. A patient deletion request, made through the practice, removes messages, uploads, summaries, and intake, leaving an audit record of the deletion.

## 3. Architecture and stack

3.1 **App.** Next.js 15 App Router, TypeScript, Tailwind, deployed to AWS Amplify Hosting (SSR). One codebase for pages and API routes.

3.2 **Database.** RDS Postgres via Prisma. SQLite is removed; local development and CI run Postgres in Docker (`docker compose up db`).

3.3 **Files.** Uploaded exports go to S3 (server-side encryption, private bucket, presigned PUT from the browser or server-side relay), never into the database. The database keeps parsed rows and metadata.

3.4 **Background jobs.** A `Job` table (kind, payload, status, attempts, run_after, last_error, idempotency key). A runner route `POST /api/jobs/run` drains due jobs; EventBridge Scheduler calls it every minute with a shared secret. Kinds: `sour.run`, `notify.invite`, `notify.summary`, `patient.delete`. Retries with backoff, three attempts, then failed with the error recorded.

3.5 **Model.** `lib/llm.ts` unchanged in shape. Add a per-call timeout, one retry on transient errors, and a circuit that falls back to scripted output when the gateway is down, surfacing the state on the page.

3.6 **Infrastructure as code.** AWS CDK (TypeScript) in `/infra`: Amplify app, RDS, S3, SES identity, SNS, EventBridge schedule, secrets in SSM Parameter Store, CloudWatch alarms. Two stacks: staging and production.

3.7 **Config.** All secrets from environment; `.env.example` documents every variable; the app refuses to start in production if a required one is missing.

## 4. Data model

4.1 `Practice` (id, name, retentionDays, createdAt).
4.2 `User` (id, practiceId, email, name, role: admin|clinician|staff, createdAt) plus Auth.js `Account`, `Session`, `VerificationToken`.
4.3 `Patient` (id, practiceId, name, phone, email, createdAt, deletedAt). A patient persists across visits.
4.4 `Visit` (id, patientId, providerUserId, scheduledAt, visitType, reason, status: invited|verified|in_intake|intake_done|summary_ready|reviewed|cancelled, token, tokenExpiresAt, consentRecordedBy, consentRecordedAt, consentChannel, reviewedBy, reviewedAt). Everything that today hangs off `Patient` (intake, messages, uploads, summaries, Dexcom connection) moves to `Visit`, except the Dexcom connection, which stays per patient.
4.5 `PatientSession` (id, visitId, codeHash, codeExpiresAt, verifiedAt, expiresAt, attempts).
4.6 `Upload` (id, visitId, kind, filename, s3Key, bytes, parsedRows, createdAt). Parsed data stored as JSON in a separate `UploadData` row to keep the main table small.
4.7 `Message`, `Summary` as today, keyed by visit. `Summary` gains `reviewedBy`, `reviewedAt`.
4.8 `AuditLog` (id, practiceId, actorType: user|patient|system, actorId, action, entityType, entityId, at, detail JSON without PHI).
4.9 `Job` as in 3.4.
4.10 `DexcomConnection` as today, keyed by patient, tokens encrypted with a KMS-backed key.
4.11 Migration path: a one-time script moves each existing patient row into a patient plus one visit. Seed data updated.

## 5. Identity and access

5.1 Providers sign in with Auth.js email magic links sent through SES. Sessions are database-backed, 12-hour idle expiry, 7-day absolute.
5.2 Roles: admin manages users and practice settings; clinician sees and reviews summaries; staff creates visits and sends invites. Every API route checks practice membership and role; a user never sees another practice's data.
5.3 Patient links: the token in the invite identifies the visit. Opening it triggers a six-digit code to the phone or email on file; three wrong attempts invalidate the code; codes expire in ten minutes. A verified patient session lasts 24 hours and is a signed, httpOnly cookie bound to the visit.
5.4 Rate limits on `/api/sweetie`, `/api/upload`, the code endpoints, and the invite link route, keyed by IP and by visit.
5.5 Staff can regenerate a link, which invalidates the old token.

## 6. Sweetie

6.1 Contract unchanged: `GET/POST /api/sweetie` with message or upload event; `lib/sweetie.ts` owns the template, safety scan, extraction, backstop, direction, and speech.
6.2 Every patient message is stored before any model call; the transcript survives a crash.
6.3 Model calls have a 20-second timeout; on failure the scripted path answers and the page shows a quiet "assistant unavailable, questions continue" note.
6.4 The intake page meets WCAG 2.1 AA: labels, focus order, contrast, reduced-motion respected, voice controls keyboard-operable, screen-reader text for state changes.
6.5 Mobile first: the page is tested at 375px width; no horizontal scroll; the stepper fits without scrolling.
6.6 Voice stays browser-native. A later ticket may add server-side speech; not in scope here.

## 7. Sour

7.1 `runSour` is enqueued as a `sour.run` job when intake wraps, when a Dexcom import completes, and on demand from the provider page. Idempotent per visit and input hash; a second run with unchanged inputs returns the existing summary.
7.2 The provider page shows job state (queued, running, failed with reason) and lets the clinician retry.
7.3 Mark as reviewed: a button records reviewer and time, moves the visit to `reviewed`, and shows in the dashboard.
7.4 Print view: a clean one-pager with no navigation, used by the Print button and by a `GET /provider/visit/[id]/print` route.
7.5 Follow-up questions to Sour are logged with the clinician id and the answer, visible on the page, never emailed.

## 8. Notifications

8.1 SES for email with a verified sending domain, DKIM, and a bounce/complaint topic that marks addresses undeliverable. SNS for SMS with a registered origination number; `STOP` is honored and recorded on the patient.
8.2 Templates: invite, code, summary-ready (provider), summary-ready (patient), deletion confirmation. No clinical content in any message; links only.
8.3 Delivery results are recorded on the visit (channel, provider message id, status) and shown to staff.
8.4 Twilio and Resend remain as alternative senders behind the existing provider selection, for local use only.

## 9. Data sources

9.1 CSV and JSON uploads: size cap 20 MB, type sniffing, parse on the server, reject on parse failure with a plain-language reason. Raw files to S3; the browser never receives another patient's key.
9.2 Dexcom: the sandbox OAuth flow stays as built. Production OAuth is the same code behind a `DEXCOM_ENV` switch once Dexcom approves the app; the approval application is a ticket but does not block anything.
9.3 Google Maps Timeline and WHOOP: upload only.
9.4 Parsers in `lib/` stay deterministic and unit-tested; every parser has fixture files under `data/fixtures/`.

## 10. Security and compliance

10.1 Encryption in transit everywhere (HTTPS, TLS to RDS); at rest for RDS, S3, and backups; Dexcom tokens encrypted with KMS.
10.2 Audit log: every read of a visit's intake, summary, messages, or uploads by a user, every patient-link verification, every send, every deletion. Readable by practice admins on an audit page; exportable.
10.3 Logging hygiene: application logs never contain names, phone numbers, emails, message text, or summary text. A lint rule or log wrapper enforces field allow-lists.
10.4 Retention: a nightly `retention.sweep` job deletes visit data older than the practice's retention setting (default 365 days), leaving the audit record.
10.5 Deletion: a staff action deletes a patient's data end to end (S3 objects included) and records it.
10.6 Secrets in SSM Parameter Store; no secrets in the repo, in logs, or in client bundles. `.env` is for local only.
10.7 HIPAA checklist document: BAAs needed (AWS covers all services used; Dexcom; Twilio only if used), access control, audit, integrity, transmission security, contingency plan, risk assessment, and the named owner for each. Kept in `docs/COMPLIANCE.md`.
10.8 Security headers, CSRF protection on state-changing routes, dependency audit in CI.

## 11. Reliability and observability

11.1 Structured JSON logs to CloudWatch with request ids; alarms on 5xx rate, job failures, and model timeout rate, delivered to an SNS topic.
11.2 Health endpoint `GET /api/health` checks database, S3, and model gateway reachability.
11.3 Graceful degradation: Sweetie scripted mode, Sour deferred with a visible state, uploads retried.
11.4 Backups: RDS automated backups with 7-day retention; a documented restore drill.

## 12. Quality and CI

12.1 Unit tests (`node --test` via tsx) for every module in `lib/`: parsers, spike detection, matching, Sweetie state transitions and safety scan, Sour brief building and flags, notification templates.
12.2 End-to-end tests with Playwright covering both flows against a seeded database: staff creates a visit, patient verifies and completes intake in scripted mode, Sour summary appears, clinician marks reviewed.
12.3 Screenshots: the e2e run writes screenshots of every screen to `e2e/screenshots/`; builders commit the relevant ones under `docs/screenshots/tickets/<ticket>/` with each pull request.
12.4 `scripts/agent-check.sh` is the gate: typecheck, lint, unit, e2e against Postgres, dependency audit, run by whoever pushes, on the tree they push. GitHub Actions runs the same check on every push to main as a second opinion.
12.5 Accessibility checks with axe in the e2e suite on the patient pages.

## 13. Environments and operations

13.1 Local: Docker Postgres, `.env`, scripted model mode by default; `npm run seed` for demo data.
13.2 Staging: the same CDK stack with a staging domain and a seeded demo practice; every merge to main deploys here.
13.3 Production: deploys from tagged releases; migrations run as a pre-deploy step; a rollback is a redeploy of the previous tag.
13.4 Demo mode: a flag on a practice that marks it synthetic; demo practices are excluded from retention sweeps and alarms and are never emailed real addresses.
13.5 Runbook in `docs/RUNBOOK.md`: deploy, rollback, rotate a secret, restore a backup, handle a bounce, handle a deletion request, what each alarm means.

## 14. Non-goals

EHR integration, insurance or billing, scheduling, server-side speech, multi-language, native apps, analytics across practices, and any feature that interprets glucose for the patient.

## 15. Ticket conventions

- Tickets are GitHub issues titled `T<nn>: <imperative summary>`, numbered in dependency order. Each cites the sections it fulfills and lists acceptance criteria.
- Labels carry state: `ready`, `in-progress`, `review`, `changes-requested`, `blocked`. The reviewer closes the issue once what landed on `main` meets it.
- One ticket is one run of `T<nn>:` commits on `main`. If a ticket turns out to need two, the builder splits it and files the second.
- Every hand-off to review includes: what changed, the commit range, how it was verified (commands run), screenshots of affected screens, and the design sections it fulfills.
