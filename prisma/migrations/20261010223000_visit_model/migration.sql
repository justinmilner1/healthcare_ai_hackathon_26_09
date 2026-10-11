-- T02 / design §4: the hackathon shape becomes the visit-centric model.
--
-- This runs as one transaction and carries existing rows forward, so a hackathon database keeps its data:
--   Provider            -> Practice + User (role admin), ids preserved so /provider/<id> links still work
--   Patient             -> Patient (practiceId) + exactly one Visit holding token, appointment, intake, notes
--   Upload/Message/Summary -> re-keyed to that visit; Upload.raw/parsed move into UploadData
--   DexcomConnection / DexcomOAuthState -> unchanged, still per patient (§4.10)
-- On an empty database (CI, scripts/agent-check.sh) every copy step moves zero rows.
--
-- `prisma migrate deploy` cannot pause for a script, so the bulk conversion lives here. Patients that
-- arrive without a visit afterwards (old code mid-deploy) are picked up by scripts/migrate-visits.ts.

-- --------------------------------------------------------------------------------------------------
-- 1. Release the old foreign keys and indexes so the columns underneath can move.
-- --------------------------------------------------------------------------------------------------
ALTER TABLE "Message" DROP CONSTRAINT "Message_patientId_fkey";
ALTER TABLE "Patient" DROP CONSTRAINT "Patient_providerId_fkey";
ALTER TABLE "Summary" DROP CONSTRAINT "Summary_patientId_fkey";
ALTER TABLE "Upload" DROP CONSTRAINT "Upload_patientId_fkey";
DROP INDEX "Message_patientId_idx";
DROP INDEX "Patient_token_key";
DROP INDEX "Summary_patientId_audience_idx";
DROP INDEX "Upload_patientId_kind_idx";

-- --------------------------------------------------------------------------------------------------
-- 2. The new tables (§4.1-§4.9).
-- --------------------------------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "Practice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 365,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Practice_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'staff',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);
-- CreateTable
CREATE TABLE "Visit" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "providerUserId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "visitType" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "token" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "consentRecordedBy" TEXT,
    "consentRecordedAt" TIMESTAMP(3),
    "consentChannel" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "intake" TEXT,
    "optIn" BOOLEAN NOT NULL DEFAULT false,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "PatientSession" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeExpiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PatientSession_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "UploadData" (
    "uploadId" TEXT NOT NULL,
    "parsed" TEXT NOT NULL,
    "raw" TEXT,

    CONSTRAINT "UploadData_pkey" PRIMARY KEY ("uploadId")
);
-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- --------------------------------------------------------------------------------------------------
-- 3. New columns on the tables that stay, nullable for now so existing rows survive the copy.
-- --------------------------------------------------------------------------------------------------
ALTER TABLE "Patient" ADD COLUMN "practiceId" TEXT,
                      ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Upload"  ADD COLUMN "visitId" TEXT,
                      ADD COLUMN "s3Key" TEXT,
                      ADD COLUMN "bytes" INTEGER NOT NULL DEFAULT 0,
                      ADD COLUMN "parsedRows" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "visitId" TEXT;
ALTER TABLE "Summary" ADD COLUMN "visitId" TEXT,
                      ADD COLUMN "reviewedBy" TEXT,
                      ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- --------------------------------------------------------------------------------------------------
-- 4. Carry the hackathon rows forward. One practice per provider: in the hackathon a provider *was*
--    the practice, and T06 is where practices get their own identity.
-- --------------------------------------------------------------------------------------------------
-- The ids this migration mints have to look like the ones the app mints, because other code reads the
-- shape: lib/log.ts only lets a cuid-shaped id past the PHI scrubber (T40, §10.3), and a `prac_<id>` or
-- `v_<id>` would be rewritten on the way to the log. So they are derived rather than invented: the same
-- provider or patient always yields the same id, which is what lets the child rows below find their visit
-- without a temporary column.
CREATE FUNCTION pg_temp.cuid(prefix text, source text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT 'c' || substr(md5(prefix || ':' || source), 1, 24) $$;

INSERT INTO "Practice" ("id", "name", "retentionDays", "createdAt")
SELECT pg_temp.cuid('practice', "id"), COALESCE(NULLIF("practice", ''), "name"), 365, "createdAt" FROM "Provider";

INSERT INTO "User" ("id", "practiceId", "email", "name", "role", "createdAt")
SELECT "id", pg_temp.cuid('practice', "id"), "email", "name", 'admin', "createdAt" FROM "Provider";

UPDATE "Patient" SET "practiceId" = pg_temp.cuid('practice', "providerId");

-- One visit per patient, id derived from the patient id so the child rows below can find it.
INSERT INTO "Visit" (
  "id", "patientId", "providerUserId", "scheduledAt", "visitType", "reason", "status",
  "token", "notes", "intake", "optIn", "isSandbox", "createdAt"
)
SELECT
  pg_temp.cuid('visit', p."id"), p."id", p."providerId", p."apptAt", p."visitType", p."reason",
  CASE
    WHEN EXISTS (SELECT 1 FROM "Summary" s WHERE s."patientId" = p."id") THEN 'summary_ready'
    WHEN p."intake" LIKE '%"wrapped":true%' THEN 'intake_done'
    WHEN EXISTS (SELECT 1 FROM "Message" m WHERE m."patientId" = p."id" AND m."role" = 'patient') THEN 'in_intake'
    ELSE 'invited'
  END,
  p."token", p."notes", p."intake", p."optIn", p."isSandbox", p."createdAt"
FROM "Patient" p;

UPDATE "Upload" SET
  "visitId" = pg_temp.cuid('visit', "patientId"),
  "bytes" = length("raw"),
  -- Every parsed payload is a JSON array (lib/types.ts); anything else counts as zero rows.
  "parsedRows" = CASE WHEN left(btrim("parsed"), 1) = '[' THEN json_array_length("parsed"::json) ELSE 0 END;

INSERT INTO "UploadData" ("uploadId", "parsed", "raw")
SELECT "id", "parsed", "raw" FROM "Upload";

UPDATE "Message" SET "visitId" = pg_temp.cuid('visit', "patientId");
UPDATE "Summary" SET "visitId" = pg_temp.cuid('visit', "patientId");

-- --------------------------------------------------------------------------------------------------
-- 5. Everything is carried over: the new columns are now required.
-- --------------------------------------------------------------------------------------------------
ALTER TABLE "Patient" ALTER COLUMN "practiceId" SET NOT NULL;
ALTER TABLE "Upload"  ALTER COLUMN "visitId" SET NOT NULL;
ALTER TABLE "Message" ALTER COLUMN "visitId" SET NOT NULL;
ALTER TABLE "Summary" ALTER COLUMN "visitId" SET NOT NULL;

-- --------------------------------------------------------------------------------------------------
-- 6. Indexes and foreign keys for the new shape.
-- --------------------------------------------------------------------------------------------------
-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_practiceId_idx" ON "User"("practiceId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_token_key" ON "Visit"("token");

-- CreateIndex
CREATE INDEX "Visit_patientId_idx" ON "Visit"("patientId");

-- CreateIndex
CREATE INDEX "Visit_providerUserId_idx" ON "Visit"("providerUserId");

-- CreateIndex
CREATE INDEX "PatientSession_visitId_idx" ON "PatientSession"("visitId");

-- CreateIndex
CREATE INDEX "AuditLog_practiceId_at_idx" ON "AuditLog"("practiceId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Message_visitId_idx" ON "Message"("visitId");

-- CreateIndex
CREATE INDEX "Patient_practiceId_idx" ON "Patient"("practiceId");

-- CreateIndex
CREATE INDEX "Summary_visitId_audience_idx" ON "Summary"("visitId", "audience");

-- CreateIndex
CREATE INDEX "Upload_visitId_kind_idx" ON "Upload"("visitId", "kind");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientSession" ADD CONSTRAINT "PatientSession_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadData" ADD CONSTRAINT "UploadData_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Summary" ADD CONSTRAINT "Summary_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_practiceId_fkey" FOREIGN KEY ("practiceId") REFERENCES "Practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- --------------------------------------------------------------------------------------------------
-- 7. The hackathon columns are empty now. Drop them, and the Provider table with them.
-- --------------------------------------------------------------------------------------------------
ALTER TABLE "Patient" DROP COLUMN "providerId",
                      DROP COLUMN "token",
                      DROP COLUMN "optIn",
                      DROP COLUMN "apptAt",
                      DROP COLUMN "visitType",
                      DROP COLUMN "reason",
                      DROP COLUMN "notes",
                      DROP COLUMN "intake",
                      DROP COLUMN "isSandbox";
ALTER TABLE "Upload"  DROP COLUMN "patientId", DROP COLUMN "raw", DROP COLUMN "parsed";
ALTER TABLE "Message" DROP COLUMN "patientId";
ALTER TABLE "Summary" DROP COLUMN "patientId";
DROP TABLE "Provider";
