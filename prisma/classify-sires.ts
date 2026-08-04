// ---------------------------------------------------------------------------
// Derive the four sire roles onto Animal, in SQL, so the lineup lists can filter
// and paginate on them without loading every bull into memory.
//
//   sireType        proven | genomic   — from the LATEST round's Lactanet
//                                        proof-activity code (see src/lib/sire-class.ts)
//   proofStatus     active | inactive  — active = the sire appears in the most
//                                        recent proof round on file
//   rollbackCount                      — how many April rounds the sire has been
//                                        through (Lactanet re-bases every April;
//                                        every other round is updated information)
//   proofRoundCount / latestProofDate / latestProofRun / latestActivityCode
//
// Idempotent: safe to re-run any time. Called automatically at the end of an
// import, and available standalone as `npm run classify:sires`.
//
// Usage: npx tsx prisma/classify-sires.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";

type Client = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

export async function classifySires(prisma: Client): Promise<{
  latestRound: string | null; active: number; inactive: number; proven: number; genomic: number;
}> {
  // A round is "April" by its evaluationDate month; evaluationDate is built from
  // the file's GERUN (YYMM) so it is always the 1st of the run's month, in UTC.
  //
  // Counts are of DISTINCT ROUNDS, not rows: an official and an interim file for
  // the same month are two rows of one round, and must count once. The `latest`
  // row's tiebreak prefers the official file so sireType / latestActivityCode are
  // read from the settled proof, not from whichever file was inserted last.
  await prisma.$executeRawUnsafe(`
    WITH latest AS (
      SELECT DISTINCT ON ("animalId")
             "animalId", "evaluationDate", "proofRun", "sireType", "activityCode"
      FROM "GeneticEvaluation"
      WHERE "approvalStatus" = 'approved'
      ORDER BY "animalId", "evaluationDate" DESC,
               CASE "runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END,
               "lpi" DESC NULLS LAST, "evaluationId" DESC
    ),
    agg AS (
      SELECT "animalId",
             COUNT(DISTINCT "proofRun")::int AS rounds,
             COUNT(DISTINCT "proofRun") FILTER (WHERE EXTRACT(MONTH FROM "evaluationDate") = 4)::int AS rollbacks
      FROM "GeneticEvaluation"
      WHERE "approvalStatus" = 'approved'
      GROUP BY "animalId"
    ),
    newest AS (
      SELECT MAX("evaluationDate") AS d FROM "GeneticEvaluation" WHERE "approvalStatus" = 'approved'
    )
    UPDATE "Animal" a SET
      "sireType"           = l."sireType",
      "latestProofDate"    = l."evaluationDate",
      "latestProofRun"     = l."proofRun",
      "latestActivityCode" = l."activityCode",
      "rollbackCount"      = g.rollbacks,
      "proofRoundCount"    = g.rounds,
      "proofStatus"        = CASE WHEN l."evaluationDate" = (SELECT d FROM newest) THEN 'active' ELSE 'inactive' END
    FROM latest l
    JOIN agg g ON g."animalId" = l."animalId"
    WHERE a."id" = l."animalId"
  `);

  // Animals with no approved proof at all are inactive with no sire type.
  await prisma.$executeRawUnsafe(`
    UPDATE "Animal" a SET
      "sireType" = NULL, "proofStatus" = 'inactive', "rollbackCount" = 0, "proofRoundCount" = 0,
      "latestProofDate" = NULL, "latestProofRun" = NULL, "latestActivityCode" = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM "GeneticEvaluation" e
      WHERE e."animalId" = a."id" AND e."approvalStatus" = 'approved'
    )
  `);

  const rows = (await prisma.$queryRawUnsafe(`
    SELECT
      (SELECT "proofRun" FROM "GeneticEvaluation" WHERE "approvalStatus"='approved'
         ORDER BY "evaluationDate" DESC LIMIT 1) AS "latestRound",
      COUNT(*) FILTER (WHERE "proofStatus" = 'active')::int  AS active,
      COUNT(*) FILTER (WHERE "proofStatus" = 'inactive')::int AS inactive,
      COUNT(*) FILTER (WHERE "sireType"    = 'proven')::int   AS proven,
      COUNT(*) FILTER (WHERE "sireType"    = 'genomic')::int  AS genomic
    FROM "Animal" WHERE "archived" = false
  `)) as { latestRound: string | null; active: number; inactive: number; proven: number; genomic: number }[];
  return rows[0];
}

// Standalone entry point.
if (process.argv[1] && /classify-sires\.ts$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  classifySires(prisma)
    .then((s) => {
      console.log(`[classify] latest round on file: ${s.latestRound ?? "—"}`);
      console.log(`[classify] active ${s.active} · inactive ${s.inactive}`);
      console.log(`[classify] proven ${s.proven} · genomic ${s.genomic}`);
    })
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
