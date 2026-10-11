-- T05 / design §5.1: provider sessions are database-backed with two clocks.
--
-- `Session.expires` is the idle clock; Auth.js rolls it forward by 12 hours on every request, so on its own it
-- would let a session live for ever. `createdAt` never moves, which is what the 7-day absolute cap is measured
-- against (lib/authAdapter.ts drops the row when it is past). Rows that predate this column (there are none in
-- a fresh database, and at most a handful of hackathon sessions elsewhere) get the time of the migration, so
-- their absolute window starts now rather than being treated as already expired.
ALTER TABLE "Session" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
