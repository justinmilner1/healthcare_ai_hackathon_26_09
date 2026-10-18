-- T70 / design §10.5: "a staff action deletes a patient's data end to end (S3 objects included)."
--
-- One row per storage prefix the object store refused to empty. Until now a refused delete was counted into
-- the `patient.deleted` audit row as `orphans: n` and then forgotten: the purge deletes the `Visit` rows
-- immediately afterwards, so the prefix — `visits/<visitId>/` — was derivable from nothing that still
-- existed, and neither a retry of the job nor a second press of *Delete data* ever asked the bucket again.
--
-- The prefix is the primary key, so re-attempting one visit updates a row instead of appending to a list,
-- and a prefix that comes back empty has its row deleted. No foreign keys on purpose: the row has to outlive
-- the `Visit` it describes and the `Patient` whose deletion left it, which is the only reason it exists.
CREATE TABLE "StorageOrphan" (
    "prefix" TEXT NOT NULL,
    "practiceId" TEXT NOT NULL,
    "patientId" TEXT,
    "objects" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTriedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageOrphan_pkey" PRIMARY KEY ("prefix")
);

CREATE INDEX "StorageOrphan_patientId_idx" ON "StorageOrphan"("patientId");

CREATE INDEX "StorageOrphan_practiceId_idx" ON "StorageOrphan"("practiceId");
