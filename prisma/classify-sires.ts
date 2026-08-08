// ---------------------------------------------------------------------------
// Derive the four sire roles onto Animal, in SQL, so the lineup lists can filter
// and paginate on them without loading every bull into memory.
//
//   sireType        proven | genomic   — full EBV vs GPA, from the LATEST round's
//                                        LPI official code (see src/lib/sire-class.ts)
//   proofStatus     active | inactive  — active = carries a NAAB stud code (is
//                                        available to breed to); inactive = none.
//                                        NOT proof-recency; a NAAB code is the rule.
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
    )
    UPDATE "Animal" a SET
      "sireType"           = l."sireType",
      "latestProofDate"    = l."evaluationDate",
      "latestProofRun"     = l."proofRun",
      "latestActivityCode" = l."activityCode",
      "rollbackCount"      = g.rollbacks,
      "proofRoundCount"    = g.rounds
    FROM latest l
    JOIN agg g ON g."animalId" = l."animalId"
    WHERE a."id" = l."animalId"
      -- Skip rows already holding the right values. A round ships 4-5 files and
      -- this runs once per file, so without the guard files 2-5 rewrite all
      -- ~99,793 Animal rows to change nothing. Animal carries 11 indexes, so
      -- those are non-HOT updates: dead tuples plus index churn, for no effect.
      -- On the FIRST file of a round almost everything genuinely does change and
      -- this guard saves little — that is expected and honest.
      AND (a."sireType", a."latestProofDate", a."latestProofRun",
           a."latestActivityCode", a."rollbackCount", a."proofRoundCount")
          IS DISTINCT FROM
          (l."sireType", l."evaluationDate", l."proofRun",
           l."activityCode", g.rollbacks, g.rounds)
  `);

  // proofStatus (active / inactive) is NOT proof-derived: a sire is ACTIVE when
  // he carries a NAAB stud (semen) code — i.e. he is available to breed to — and
  // INACTIVE when he does not, regardless of how recent his proof is. Set it for
  // every animal in one pass so the rule is uniform.
  // Change-only: computing the value in a subquery and comparing lets Postgres
  // skip rows that already hold it. Unguarded, this rewrote EVERY non-archived
  // animal (~99,793 row versions x 11 indexes) on every run, to flip a handful.
  await prisma.$executeRawUnsafe(`
    UPDATE "Animal" a SET "proofStatus" = x.v
    FROM (
      SELECT "id",
             CASE WHEN EXISTS (
               SELECT 1 FROM "AnimalIdentifier" i
               WHERE i."animalId" = "Animal"."id" AND i."idType" = 'naab' AND i."active" = true
             ) THEN 'active' ELSE 'inactive' END AS v
      FROM "Animal" WHERE "archived" = false
    ) x
    WHERE a."id" = x."id" AND a."proofStatus" IS DISTINCT FROM x.v
  `);

  // Animals with no approved proof at all keep no sire type / counts (proofStatus
  // is already set above from their NAAB code).
  await prisma.$executeRawUnsafe(`
    UPDATE "Animal" a SET
      "sireType" = NULL, "rollbackCount" = 0, "proofRoundCount" = 0,
      "latestProofDate" = NULL, "latestProofRun" = NULL, "latestActivityCode" = NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM "GeneticEvaluation" e
      WHERE e."animalId" = a."id" AND e."approvalStatus" = 'approved'
    )
      -- Only rows that still carry stale values; without this the clear-out
      -- rewrites every proofless animal on every run to set NULL over NULL.
      AND (a."sireType" IS NOT NULL OR a."latestProofDate" IS NOT NULL
           OR a."latestProofRun" IS NOT NULL OR a."latestActivityCode" IS NOT NULL
           OR a."rollbackCount" <> 0 OR a."proofRoundCount" <> 0)
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
