-- Proof Performance + Rollback Resistance, materialised on Animal.
--
--   proofPerformance    0-100. Mean retention across EVERY consecutive pair of
--                       proof rounds. Absolute and self-contained.
--   rollbackResistance  base 100. Mean retention across APRIL rounds only (the
--                       annual base change), at 5 points per standard deviation.
--                       The baseline is the COHORT of sires (active and inactive)
--                       with the same number of Aprils, so career stage is held
--                       constant. rollbackRaw keeps the un-scaled 0-100 input so
--                       the scale can be re-based later.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- only, so it is safe to re-run and it never touches existing data.
--
-- The two DROPs below remove an interim column name ("rollbackStep" /
-- "rollbackRating") from an earlier revision of this same file. They were never
-- populated — the backfill had not run yet — so nothing is lost.
--
-- Apply with:
--   npx dotenv -e .env.production -- npx prisma db execute --file prisma/sql/2026-07-rollback-rating.sql --schema prisma/schema.prisma
-- then backfill with:
--   npx dotenv -e .env.production -- npx tsx prisma/compute-rollback.ts

DROP INDEX IF EXISTS "Animal_rollbackRating_idx";
ALTER TABLE "Animal" DROP COLUMN IF EXISTS "rollbackRating";
ALTER TABLE "Animal" DROP COLUMN IF EXISTS "rollbackStep";

ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "proofPerformance"   DOUBLE PRECISION;
ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "proofSteps"         INTEGER;
ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "rollbackRaw"        DOUBLE PRECISION;
ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "rollbackResistance" INTEGER;
ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "rollbackSteps"      INTEGER;
ALTER TABLE "Animal" ADD COLUMN IF NOT EXISTS "rollbackCohortN"    INTEGER;

CREATE INDEX IF NOT EXISTS "Animal_rollbackResistance_idx" ON "Animal" ("rollbackResistance");
CREATE INDEX IF NOT EXISTS "Animal_proofPerformance_idx"   ON "Animal" ("proofPerformance");
