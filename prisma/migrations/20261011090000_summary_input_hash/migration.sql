-- T15 (design §7.1): remember which inputs a summary was generated from, so a second run over unchanged
-- intake and uploads returns the saved pair instead of calling the model twice again. Nullable, and null on
-- purpose for the placeholder a degraded run writes: those must never be reused.
ALTER TABLE "Summary" ADD COLUMN "inputHash" TEXT;

CREATE INDEX "Summary_visitId_inputHash_idx" ON "Summary"("visitId", "inputHash");
