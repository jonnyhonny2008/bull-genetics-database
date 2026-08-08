-- ---------------------------------------------------------------------------
-- Per-table autovacuum tuning for the bulk-import workload.
--
-- Postgres defaults assume a table changes gradually. These tables do not: a
-- proof round rewrites essentially all of them at once, 3-4 times a year, and
-- every bull changes every round. The default autovacuum_vacuum_scale_factor of
-- 0.2 means a table is not even CONSIDERED for vacuuming until a fifth of it is
-- dead — on GeneticEvaluation that is ~200,000 dead rows of backlog, on a
-- 2-core instance that is already cost-throttled.
--
-- Measured consequence of leaving it at the default: after the first
-- whole-population import, GeneticEvaluation held 617 MB on disk for 207 MB of
-- live data (65% dead space) on an 8 GB volume that also has to hold pg_wal.
--
-- These settings are STORAGE PARAMETERS on the table itself, so they survive
-- `prisma db push` (which does not manage them) and every redeploy. Re-running
-- this file is harmless.
--
-- Apply with:  npm run db:tune:prod
-- ---------------------------------------------------------------------------

-- Vacuum at 2% dead rather than 20%, analyze at 1% rather than 10%, and reduce
-- the pause between vacuum work units so a burst is cleared in minutes not hours.
ALTER TABLE "GeneticEvaluation" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2
);

ALTER TABLE "UsEvaluation" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2
);

-- Animal additionally gets fillfactor 90. It is UPDATE-heavy rather than
-- INSERT-heavy (every derived column — sireType, proofStatus, rollbackResistance,
-- proofPerformance, the latest-proof fields — is rewritten each round), and
-- leaving 10% free space per page lets those updates be HOT: the new row version
-- stays on the same page and Postgres can skip updating the 11 indexes for
-- columns that did not change. Without page slack, every update is non-HOT.
ALTER TABLE "Animal" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 2,
  fillfactor = 90
);

ALTER TABLE "AnimalIdentifier" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

ALTER TABLE "PedigreeIndexResult" SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);
