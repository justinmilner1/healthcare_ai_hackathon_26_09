-- T32 / design §13.4: a flag that marks a practice synthetic.
--
-- "Demo mode: a flag on a practice that marks it synthetic; demo practices are excluded from retention
-- sweeps and alarms and are never emailed real addresses." The flag is the whole schema change; the three
-- exclusions are lib/retentionStore.ts, the `demo` log field lib/log.ts allow-lists, and lib/demo.ts.
--
-- Default false with NOT NULL: every practice that already exists is a real one, including the practice the
-- seed makes — `npm run seed` marks that one itself (lib/practice.ts ensureDemoProvider), so re-seeding an
-- existing database flips it rather than leaving a half-demo row behind.
ALTER TABLE "Practice" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
