// ---------------------------------------------------------------------------
// Materialise rollback resistance onto Animal so every bull profile and list can
// show it without recomputing 15k evaluations per page load.
//
//   proofPerformance    0-100. Mean retention across EVERY consecutive pair of
//                       proof rounds — how much of each trait the bull carried
//                       into the next round (holding or gaining = 100),
//                       averaged over every step and weighted across traits.
//
//   rollbackResistance  base 100. The same retention measure but computed from
//                       APRIL ROUNDS ONLY — the annual base change is the round
//                       where numbers move for reasons other than new data.
//                       Expressed the way Lactanet expresses health and
//                       fertility traits: 100 = cohort average, 5 points = one
//                       standard deviation.
//
// The cohort is every sire — active AND inactive — that has been through the
// SAME NUMBER of April base changes. Two reasons:
//
//   1. It removes a bias. A bull with one April has one observation and has had
//      no time to give anything back; pooled against veterans he tops the list
//      for the wrong reason. Comparing 3-rollback bulls only with other
//      3-rollback bulls fixes that at source.
//   2. Inactive sires belong in it. An inactive bull was active once, and what
//      he did at his third base change is the right yardstick for a current bull
//      facing his third. It also makes each cohort far larger, and therefore its
//      mean and spread far more stable.
//
// Idempotent: safe to re-run. Called at the end of an import, and standalone as
//   npx dotenv -e .env.production -- npx tsx prisma/compute-rollback.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { computeRollback, baselineOf, buildCohortBaselines, cohortRating } from "../src/lib/rollback";
import { attachTraits, traitDefMap } from "../src/lib/eval-traits";

const CHUNK = 1000; // animals per evaluation fetch — keeps the pooler happy

export async function computeRollbackRatings(prisma: PrismaClient): Promise<{
  scored: number; rated: number; withRollback: number; baselineN: number; mean: number; sd: number;
  cohorts: { steps: number; n: number; mean: number; sd: number }[];
}> {
  const defMap = await traitDefMap();

  // Only bulls with more than one round can have a round-to-round score.
  const multi = await prisma.geneticEvaluation.groupBy({
    by: ["animalId"], _count: { animalId: true }, having: { animalId: { _count: { gt: 1 } } },
  });
  const ids = multi.map((m) => m.animalId);

  type Score = { perf: number; perfSteps: number; rbRaw: number | null; rbSteps: number };
  const scores = new Map<string, Score>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const animals = await prisma.animal.findMany({
      where: { id: { in: batch } },
      select: { id: true, evaluations: { orderBy: { evaluationDate: "asc" } } },
    });
    for (const a of animals) {
      const r = computeRollback(
        attachTraits(a.evaluations, defMap).map((e) => ({
          evaluationDate: e.evaluationDate, proofRun: e.proofRun,
          reliabilityOverall: e.reliabilityOverall, traitValues: e.traitValues,
        })),
      );
      if (r.proofPerformance != null) {
        scores.set(a.id, {
          perf: r.proofPerformance, perfSteps: r.proofSteps,
          rbRaw: r.rollbackRaw, rbSteps: r.rollbackSteps,
        });
      }
    }
  }

  // Baseline for Rollback Resistance: EVERY sire that has been through at least
  // one April, STRATIFIED BY HOW MANY. A bull with 3 rollbacks is measured
  // against every other bull that has been through 3 rollbacks, so a young sire
  // with one April cannot outrank a veteran simply for having had less time to
  // drift.
  //
  // Inactive sires are deliberately IN the baseline. An inactive bull was active
  // once, and what he did at his third base change is exactly the right yardstick
  // for a current bull now facing his third — the comparison is like-for-like on
  // career stage, not on whether he is still in the lineup today. It also makes
  // the cohorts far larger and therefore far more stable.
  const baseEntries = [...scores.values()]
    .filter((v) => v.rbRaw != null && v.rbSteps >= 1)
    .map((v) => ({ steps: v.rbSteps, raw: v.rbRaw as number }));
  const cohorts = buildCohortBaselines(baseEntries);
  // Reported as a single figure for the log line only; the real scale is per-cohort.
  const baseline = baselineOf(baseEntries.map((e) => e.raw));

  // One bulk UPDATE per chunk via jsonb_to_recordset — the pooler charges per
  // round-trip, so 935 individual updates would be far slower than 1.
  const rows = [...scores.entries()].map(([id, v]) => ({
    id, perf: v.perf, perfSteps: v.perfSteps,
    rbRaw: v.rbRaw, rbSteps: v.rbSteps,
    rating: cohortRating(v.rbRaw, v.rbSteps, cohorts),
    cohortN: cohorts.get(v.rbSteps)?.n ?? null,
  }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await prisma.$executeRawUnsafe(
      `UPDATE "Animal" a SET
         "proofPerformance"   = v."perf",
         "proofSteps"         = v."perfSteps",
         "rollbackRaw"        = v."rbRaw",
         "rollbackResistance" = v."rating",
         "rollbackSteps"      = v."rbSteps",
         "rollbackCohortN"    = v."cohortN"
       FROM jsonb_to_recordset($1::jsonb)
         AS v("id" text, "perf" double precision, "perfSteps" int,
              "rbRaw" double precision, "rating" int, "rbSteps" int, "cohortN" int)
       WHERE a."id" = v."id"`,
      JSON.stringify(chunk),
    );
  }

  // Clear stale values on bulls that no longer qualify (e.g. rounds removed).
  await prisma.$executeRawUnsafe(
    `UPDATE "Animal" SET "proofPerformance" = NULL, "proofSteps" = NULL,
       "rollbackRaw" = NULL, "rollbackResistance" = NULL, "rollbackSteps" = NULL,
       "rollbackCohortN" = NULL
     WHERE "proofPerformance" IS NOT NULL
       AND "id" NOT IN (SELECT "animalId" FROM "GeneticEvaluation" GROUP BY "animalId" HAVING COUNT(*) > 1)`,
  );

  return {
    scored: scores.size, rated: rows.length, withRollback: baseEntries.length,
    baselineN: baseline.n,
    mean: Math.round(baseline.mean * 100) / 100, sd: Math.round(baseline.sd * 1000) / 1000,
    cohorts: [...cohorts.entries()].sort((a, b) => a[0] - b[0]).map(([steps, b]) => ({
      steps, n: b.n, mean: Math.round(b.mean * 100) / 100, sd: Math.round(b.sd * 100) / 100,
    })),
  };
}

// CLI entry point — only when run directly, not when imported by the importer.
if (process.argv[1] && /compute-rollback\.ts$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  computeRollbackRatings(prisma)
    .then((r) => {
      console.log(`[rollback] Proof Performance scored for ${r.scored} bulls`);
      console.log(`[rollback] Rollback Resistance: ${r.withRollback} sires have >=1 April step (pooled mean=${r.mean}% sd=${r.sd})`);
      console.log(`[rollback] cohort baselines (each bull is rated against its own April count):`);
      for (const c of r.cohorts) {
        console.log(`             ${c.steps} April${c.steps === 1 ? " " : "s"} → n=${String(c.n).padStart(4)} mean=${c.mean}% sd=${c.sd}`);
      }
      console.log(`[rollback] wrote proofPerformance / rollbackRaw / rollbackResistance for ${r.rated} bulls`);
    })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
