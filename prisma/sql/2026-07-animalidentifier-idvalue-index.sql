-- Pedigree ancestor resolution looks registration numbers up by idValue ALONE:
-- the pedigree text on a proof does not say which registry a number belongs to,
-- so resolveAncestors() (src/lib/pedigree.ts) cannot supply idType. The existing
-- composite @@index([idType, idValue]) cannot seek on its second column, so that
-- lookup was falling back to a sequential scan on every Family Tree tab render.
--
-- Additive and re-runnable: IF NOT EXISTS so applying twice is harmless.
CREATE INDEX IF NOT EXISTS "AnimalIdentifier_idValue_idx" ON "AnimalIdentifier"("idValue");
