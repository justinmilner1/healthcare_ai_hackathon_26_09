-- T14 / design §10.4: the nightly retention sweep marks each visit it has cleared.
--
-- The sweep removes a visit's intake, notes, messages, uploads and summaries once the visit is older than the
-- practice's retention setting, and leaves the row and the audit record of the deletion (§2.8). Without a mark
-- it would have no way to tell "already swept" from "nothing to remove" and would reconsider the same visits,
-- and write the same audit rows, every night. Nullable with no default: every visit that exists today is
-- inside its practice's window or will be judged on its own age the first time the sweep runs.
ALTER TABLE "Visit" ADD COLUMN "retentionSweptAt" TIMESTAMP(3);

-- The sweep asks for unswept visits across the practice, so the index is on the mark. Postgres indexes nulls,
-- which is the side the query wants.
CREATE INDEX "Visit_retentionSweptAt_idx" ON "Visit"("retentionSweptAt");
