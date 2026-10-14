-- T07 / design §2.2, §8.3: the contact channel staff chose for a visit, and what each channel did with the
-- messages sent to it.
--
-- `Visit.contactChannel` is nullable rather than defaulted, so a row that predates this migration is
-- distinguishable from one where staff chose "both". lib/visitIntake.ts reads a null as "both", which is the
-- behaviour every existing row was created with: /api/book sent on every channel the patient had.
--
-- `VisitDelivery` is one row per visit per channel, replaced by each send (§8.3 asks for the delivery result,
-- not an audit trail of attempts — lib/log.ts already has every attempt, and §10.2's audit log is T12).
-- Cascade on the visit, because a deleted visit (§10.5) must take its delivery bookkeeping with it.

ALTER TABLE "Visit" ADD COLUMN "contactChannel" TEXT;

CREATE TABLE "VisitDelivery" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VisitDelivery_visitId_channel_key" ON "VisitDelivery"("visitId", "channel");
CREATE INDEX "VisitDelivery_visitId_idx" ON "VisitDelivery"("visitId");

ALTER TABLE "VisitDelivery" ADD CONSTRAINT "VisitDelivery_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
