// Sanity-check the materialised Proof Performance / Rollback Resistance values.
//   npx dotenv -e .env.production -- npx tsx prisma/verify-rollback.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.$queryRawUnsafe<{ bucket: string; n: bigint }[]>(`
    SELECT CASE
             WHEN "rollbackResistance" IS NULL THEN 'no April round'
             WHEN "rollbackResistance" >= 110 THEN '110+  well above'
             WHEN "rollbackResistance" >= 105 THEN '105-109 above'
             WHEN "rollbackResistance" >=  96 THEN '96-104 average'
             WHEN "rollbackResistance" >=  91 THEN '91-95  below'
             ELSE '<91   well below'
           END AS bucket,
           COUNT(*) AS n
    FROM "Animal" WHERE archived = false
    GROUP BY 1 ORDER BY 1 DESC
  `);
  console.log("Rollback Resistance distribution (all non-archived bulls):");
  for (const r of rows) console.log(`  ${r.bucket.padEnd(18)} ${r.n}`);

  const perCohort = await prisma.$queryRawUnsafe<{ steps: number; n: bigint; cohortn: number; rawavg: number; avg: number; sd: number; min: number; max: number }[]>(`
    SELECT "rollbackSteps" steps, COUNT(*) n, MAX("rollbackCohortN") cohortn,
           AVG("rollbackRaw") rawavg, AVG("rollbackResistance") avg,
           STDDEV_POP("rollbackResistance") sd,
           MIN("rollbackResistance") min, MAX("rollbackResistance") max
    FROM "Animal" WHERE "rollbackResistance" IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `);
  console.log("\nPer-cohort (each should centre on 100 with sd ~5 by construction):");
  console.log("  Aprils   n  cohortN  rawAvg%   mean    sd   range");
  for (const c of perCohort) {
    console.log(`  ${String(c.steps).padStart(6)} ${String(c.n).padStart(3)} ${String(c.cohortn).padStart(8)} ${Number(c.rawavg).toFixed(2).padStart(8)} ${Number(c.avg).toFixed(2).padStart(6)} ${Number(c.sd).toFixed(2).padStart(5)}   ${c.min}-${c.max}`);
  }

  const perf = await prisma.$queryRawUnsafe<{ n: bigint; avg: number; min: number; max: number }[]>(`
    SELECT COUNT(*) n, AVG("proofPerformance") avg, MIN("proofPerformance") min, MAX("proofPerformance") max
    FROM "Animal" WHERE "proofPerformance" IS NOT NULL
  `);
  const p = perf[0];
  console.log(`\nProof Performance: n=${p.n} mean=${Number(p.avg).toFixed(2)} range ${Number(p.min).toFixed(1)}-${Number(p.max).toFixed(1)}`);

  const top = await prisma.animal.findMany({
    where: { rollbackResistance: { not: null } },
    orderBy: { rollbackResistance: "desc" }, take: 5,
    select: { primaryName: true, rollbackResistance: true, rollbackRaw: true, proofPerformance: true, rollbackSteps: true, proofRoundCount: true },
  });
  const bottom = await prisma.animal.findMany({
    where: { rollbackResistance: { not: null } },
    orderBy: { rollbackResistance: "asc" }, take: 5,
    select: { primaryName: true, rollbackResistance: true, rollbackRaw: true, proofPerformance: true, rollbackSteps: true, proofRoundCount: true },
  });
  const show = (label: string, list: typeof top) => {
    console.log(`\n${label}`);
    for (const a of list) {
      console.log(`  ${String(a.rollbackResistance).padStart(3)}  raw ${String(a.rollbackRaw).padStart(5)}%  perf ${String(a.proofPerformance).padStart(5)}  ${a.rollbackSteps}A/${a.proofRoundCount}R  ${a.primaryName}`);
    }
  };
  show("Best Rollback Resistance (active):", top);
  show("Worst Rollback Resistance (active):", bottom);

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exitCode = 1; });
