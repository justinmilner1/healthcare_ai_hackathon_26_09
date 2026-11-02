-- T220 / design §10.2, §10.7: a coalesced audit row has to say what span it covers.
--
-- Read coalescing (`absorbed` in lib/auditStore.ts) counts a repeated identical read on the row already
-- there instead of writing a second one. It used to look for that row by `at >= now - READ_COALESCE_MS`
-- and then move `at` to now, so the window was measured from the *last* absorbed read and slid forward
-- with it: a read every 59 seconds absorbed into one row for ever, and that row described itself to an
-- admin as a one-minute window. Measured on the reviewer run of 2026-11-02: eight reads 1.5s apart under a
-- 2s window became one row standing for 10.6s, 5.3x the window it claimed.
--
-- `firstAt` is when the row's first event happened and is never written again. The lookup now bounds on it,
-- so the window is anchored on the row's own start and `at - firstAt` can never exceed READ_COALESCE_MS;
-- `at` still carries the latest of the group, so the pair is the span and the page and the CSV print it.
--
-- Existing rows take `at`, which is the only time they have: a row written before this migration stands
-- for a span nothing recorded, and claiming it began at the moment of the migration would be worse than
-- claiming it began at its only timestamp. A pre-existing coalesced row therefore reads as a zero-length
-- span, which is what the record actually supports.
ALTER TABLE "AuditLog" ADD COLUMN "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "AuditLog" SET "firstAt" = "at";
