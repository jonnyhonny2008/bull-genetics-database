-- Sire classification columns (additive only — no drops, no data loss).
-- Generated from `prisma migrate diff` and made idempotent so it is safe to re-run.
--
--   Animal.sireType            proven | genomic  (from the latest round's Lactanet activity code)
--   Animal.proofStatus         active | inactive (active = present in the most recent round on file)
--   Animal.rollbackCount       number of April (base-change) rounds the sire has been through
--   GeneticEvaluation.*Code    raw Lactanet codes for that round — see src/lib/sire-class.ts

ALTER TABLE "Animal"
  ADD COLUMN IF NOT EXISTS "sireType"           TEXT,
  ADD COLUMN IF NOT EXISTS "proofStatus"        TEXT,
  ADD COLUMN IF NOT EXISTS "rollbackCount"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "proofRoundCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "latestProofDate"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "latestProofRun"     TEXT,
  ADD COLUMN IF NOT EXISTS "latestActivityCode" TEXT;

ALTER TABLE "GeneticEvaluation"
  ADD COLUMN IF NOT EXISTS "activityCode" TEXT,
  ADD COLUMN IF NOT EXISTS "officialCode" TEXT,
  ADD COLUMN IF NOT EXISTS "genotyped"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "daughters"    INTEGER,
  ADD COLUMN IF NOT EXISTS "herds"        INTEGER,
  ADD COLUMN IF NOT EXISTS "sireType"     TEXT;

CREATE INDEX IF NOT EXISTS "Animal_sireType_idx"                      ON "Animal"("sireType");
CREATE INDEX IF NOT EXISTS "Animal_proofStatus_idx"                   ON "Animal"("proofStatus");
CREATE INDEX IF NOT EXISTS "Animal_archived_sireType_proofStatus_idx" ON "Animal"("archived", "sireType", "proofStatus");
CREATE INDEX IF NOT EXISTS "Animal_birthDate_idx"                     ON "Animal"("birthDate");
