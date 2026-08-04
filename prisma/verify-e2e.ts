// End-to-end data integrity check after the official import + run-kind rewire.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

function ok(cond: boolean, label: string, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  console.log("=== totals ===");
  const total = await p.geneticEvaluation.count();
  console.log(`  evaluations: ${total}`);

  const byKind = await p.geneticEvaluation.groupBy({ by: ["runKind"], _count: { _all: true } });
  const kind = Object.fromEntries(byKind.map((r) => [String(r.runKind), r._count._all]));
  console.log("  by runKind:", JSON.stringify(kind));
  ok((kind["official"] ?? 0) > 1000, "official rows now present", `${kind["official"] ?? 0}`);
  ok((kind["interim"] ?? 0) > 10000, "interim rows retained", `${kind["interim"] ?? 0}`);

  console.log("\n=== no duplicate (animal, round, kind) ===");
  const dup = await p.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM (
       SELECT "animalId","proofRun","runKind" FROM "GeneticEvaluation"
       GROUP BY 1,2,3 HAVING COUNT(*) > 1) d`,
  );
  ok(Number(dup[0].n) === 0, "no duplicate animal|round|kind groups", `${Number(dup[0].n)} dup groups`);

  console.log("\n=== preferred now prefers official where both exist ===");
  // For each (animal, round) that has BOTH kinds, the preferred row must be official.
  const both = await p.$queryRawUnsafe<{ animalId: string; proofRun: string }[]>(
    `SELECT "animalId","proofRun" FROM "GeneticEvaluation"
     WHERE "runKind" IN ('official','interim') GROUP BY 1,2
     HAVING COUNT(DISTINCT "runKind") = 2`,
  );
  console.log(`  rounds with both official & interim for a bull: ${both.length}`);
  // Of those, how many have the interim row flagged preferred (should be 0)?
  const wrongPref = await p.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "GeneticEvaluation" g
     WHERE g."isPreferred" = true AND g."runKind" = 'interim'
       AND EXISTS (
         SELECT 1 FROM "GeneticEvaluation" o
         WHERE o."animalId" = g."animalId" AND o."proofRun" = g."proofRun"
           AND o."runKind" = 'official' AND o."approvalStatus" = 'approved')`,
  );
  ok(Number(wrongPref[0].n) === 0, "no interim row is preferred when an official twin exists", `${Number(wrongPref[0].n)} wrong`);

  const prefKinds = await p.geneticEvaluation.groupBy({ by: ["runKind"], where: { isPreferred: true }, _count: { _all: true } });
  console.log("  preferred rows by kind:", JSON.stringify(Object.fromEntries(prefKinds.map((r) => [String(r.runKind), r._count._all]))));

  console.log("\n=== exactly one preferred per animal ===");
  const multiPref = await p.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM (
       SELECT "animalId" FROM "GeneticEvaluation" WHERE "isPreferred" = true
       GROUP BY 1 HAVING COUNT(*) > 1) d`,
  );
  ok(Number(multiPref[0].n) === 0, "no animal has >1 preferred evaluation", `${Number(multiPref[0].n)} offenders`);

  console.log("\n=== rollback / classification derived columns ===");
  const rb = await p.animal.count({ where: { rollbackResistance: { not: null } } });
  const perf = await p.animal.count({ where: { proofPerformance: { not: null } } });
  console.log(`  bulls with Rollback Resistance: ${rb};  with Proof Performance: ${perf}`);
  ok(rb > 100, "rollback resistance populated", `${rb}`);

  // rollbackCount must now be distinct April ROUNDS, so <= number of distinct April rounds on file.
  const aprRounds = await p.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(DISTINCT "proofRun") AS n FROM "GeneticEvaluation"
     WHERE EXTRACT(MONTH FROM "evaluationDate") = 4 AND "approvalStatus" = 'approved'`,
  );
  const maxRbCount = await p.animal.aggregate({ _max: { rollbackCount: true } });
  console.log(`  distinct April rounds on file: ${Number(aprRounds[0].n)};  max rollbackCount on any bull: ${maxRbCount._max.rollbackCount}`);
  ok((maxRbCount._max.rollbackCount ?? 0) <= Number(aprRounds[0].n), "no bull's April count exceeds distinct April rounds", `max ${maxRbCount._max.rollbackCount} <= ${Number(aprRounds[0].n)}`);

  console.log("\n=== proofRoundCount is distinct rounds, not rows ===");
  // Pick a bull that has an official+interim pair and check his proofRoundCount
  // equals his distinct proofRun count, not his row count.
  if (both.length) {
    const a = both[0].animalId;
    const rows = await p.geneticEvaluation.count({ where: { animalId: a } });
    const rounds = await p.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(DISTINCT "proofRun") AS n FROM "GeneticEvaluation" WHERE "animalId" = $1`, a);
    const stored = await p.animal.findUnique({ where: { id: a }, select: { proofRoundCount: true, primaryName: true } });
    console.log(`  ${stored?.primaryName}: rows=${rows}, distinct rounds=${Number(rounds[0].n)}, stored proofRoundCount=${stored?.proofRoundCount}`);
    ok(stored?.proofRoundCount === Number(rounds[0].n), "proofRoundCount equals distinct rounds", `${stored?.proofRoundCount} vs ${Number(rounds[0].n)}`);
  }

  console.log("\n=== a spot-check bull: LATIF / a known official bull ===");
  const sample = await p.geneticEvaluation.findMany({
    where: { proofRun: "April 2025", runKind: "official" },
    select: { animalId: true, lpi: true, animal: { select: { primaryName: true } } },
    orderBy: { lpi: "desc" }, take: 3,
  });
  for (const s of sample) console.log(`  ${s.animal.primaryName}: official April 2025 LPI ${s.lpi}`);
  ok(sample.length > 0, "official April 2025 rows queryable", `${sample.length}`);

  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
