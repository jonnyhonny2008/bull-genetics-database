// Enforce the invariant: exactly ONE preferred GeneticEvaluation per animal —
// the latest approved proof round. Safe to re-run any time (idempotent).
// Uses a window function so it's a single fast pass regardless of table size.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const before = await prisma.geneticEvaluation.count({ where: { isPreferred: true } });
  const animals = await prisma.animal.count();

  await prisma.$executeRawUnsafe(`UPDATE "GeneticEvaluation" SET "isPreferred" = false WHERE "isPreferred" = true`);
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT "evaluationId",
             ROW_NUMBER() OVER (
               PARTITION BY "animalId"
               ORDER BY "evaluationDate" DESC, "lpi" DESC NULLS LAST, "evaluationId" DESC
             ) AS rn
      FROM "GeneticEvaluation"
      WHERE "approvalStatus" = 'approved'
    )
    UPDATE "GeneticEvaluation" g
    SET "isPreferred" = true
    FROM ranked r
    WHERE g."evaluationId" = r."evaluationId" AND r.rn = 1
  `);

  const after = await prisma.geneticEvaluation.count({ where: { isPreferred: true } });
  console.log(`[normalize] preferred evals: ${before} -> ${after} (animals: ${animals})`);
  if (after !== animals) console.warn(`[normalize] NOTE: ${animals - after} animal(s) have no approved eval (expected 0 mismatch if all have proofs).`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
