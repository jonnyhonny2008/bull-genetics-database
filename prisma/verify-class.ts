// Sanity-check the sire classification against the raw Lactanet codes now that
// they are in the database.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function q<T>(sql: string): Promise<T[]> { return (await prisma.$queryRawUnsafe(sql)) as T[]; }

async function main() {
  console.log("=== rounds by activity code (with daughters / official code) ===");
  for (const r of await q<any>(`
    SELECT "activityCode" AS code, COUNT(*)::int AS rounds,
           COUNT(*) FILTER (WHERE COALESCE("daughters",0) > 0)::int AS with_dtrs,
           ROUND(AVG(COALESCE("daughters",0)))::int AS avg_dtrs,
           MAX("daughters")::int AS max_dtrs,
           STRING_AGG(DISTINCT COALESCE("officialCode",'-'), '/') AS official_codes
    FROM "GeneticEvaluation" GROUP BY "activityCode" ORDER BY rounds DESC`))
    console.log(`  code ${r.code ?? "-"}: ${String(r.rounds).padStart(6)} rounds | withDaughters ${String(r.with_dtrs).padStart(5)} | avgDtrs ${String(r.avg_dtrs).padStart(4)} | maxDtrs ${String(r.max_dtrs).padStart(5)} | LPI official codes ${r.official_codes}`);

  console.log("\n=== bulls: latest-round class vs 'ever had a proven round' ===");
  for (const r of await q<any>(`
    SELECT a."sireType" AS latest_class, COUNT(*)::int AS bulls,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM "GeneticEvaluation" e WHERE e."animalId"=a."id" AND e."sireType"='proven'))::int AS ever_proven,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM "GeneticEvaluation" e WHERE e."animalId"=a."id" AND COALESCE(e."daughters",0) > 0))::int AS ever_had_daughters
    FROM "Animal" a WHERE a."archived"=false GROUP BY a."sireType"`))
    console.log(`  latest=${r.latest_class ?? "(none)"}: ${r.bulls} bulls | ever a proven round: ${r.ever_proven} | ever had daughters: ${r.ever_had_daughters}`);

  console.log("\n=== active/inactive x proven/genomic ===");
  for (const r of await q<any>(`
    SELECT "proofStatus", "sireType", COUNT(*)::int AS n FROM "Animal"
    WHERE "archived"=false GROUP BY 1,2 ORDER BY 1,2`))
    console.log(`  ${r.proofStatus ?? "-"} / ${r.sireType ?? "-"}: ${r.n}`);

  console.log("\n=== latest rounds on file (is one global 'latest round' right?) ===");
  for (const r of await q<any>(`
    SELECT "proofRun", "breedContext", COUNT(DISTINCT "animalId")::int AS bulls, MAX("evaluationDate") AS d
    FROM "GeneticEvaluation" GROUP BY 1,2 ORDER BY d DESC LIMIT 12`))
    console.log(`  ${r.proofRun} [${r.breedContext}]: ${r.bulls} bulls`);

  console.log("\n=== April rollback tally ===");
  for (const r of await q<any>(`
    SELECT "rollbackCount" AS n, COUNT(*)::int AS bulls FROM "Animal"
    WHERE "archived"=false GROUP BY 1 ORDER BY 1`))
    console.log(`  ${r.n} rollback(s): ${r.bulls} bulls`);

  console.log("\n=== sample: top 8 active bulls by LPI ===");
  for (const r of await q<any>(`
    SELECT a."primaryName", a."sireType", a."proofStatus", a."rollbackCount", a."proofRoundCount",
           a."latestProofRun", a."latestActivityCode", e."lpi", e."conf", e."daughters"
    FROM "Animal" a JOIN "GeneticEvaluation" e ON e."animalId"=a."id" AND e."isPreferred"
    WHERE a."archived"=false AND a."proofStatus"='active' ORDER BY e."lpi" DESC NULLS LAST LIMIT 8`))
    console.log(`  ${String(r.primaryName).slice(0, 34).padEnd(34)} ${r.sireType}/${r.proofStatus} LPI ${r.lpi} Conf ${r.conf} dtrs ${r.daughters ?? 0} · ${r.proofRoundCount} rounds, ${r.rollbackCount} rollbacks · ${r.latestProofRun} (code ${r.latestActivityCode})`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
