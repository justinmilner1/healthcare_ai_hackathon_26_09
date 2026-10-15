-- T18 / design §7.5: "Follow-up questions to Sour are logged with the clinician id and the answer, visible on
-- the page, never emailed."
--
-- One row per question a clinician asked Sour about one visit. `askedBy` is the clinician's user id, opaque
-- and with no foreign key, for the same reason `Visit.reviewedBy` has none (§7.3): the record of who asked
-- outlives the account, and the name is joined at read time.
--
-- `answer` and `answeredAt` are nullable because the question is written *before* the model call, the way
-- §6.2 writes a patient's message before Sweetie's: an outage then leaves the question on the record
-- unanswered rather than losing what the clinician asked.
--
-- Cascade on the visit, so a deleted visit (§10.5) takes the follow-ups with it; the nightly sweep (§10.4)
-- deletes them by visit id (lib/retentionStore.ts), since that keeps the `Visit` row.

CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "askedBy" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FollowUp_visitId_createdAt_idx" ON "FollowUp"("visitId", "createdAt");

ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
