// Re-derive each evaluation's proven/genomic (sireType) with the corrected
// classifyRound — the LPI official code (full EBV vs GPA) now wins over the
// activity code, which fixes MACE sires that were mislabelled genomic. Works off
// the stored officialCode / activityCode / daughters columns; no file re-read.
//
// Idempotent. Re-run classify-sires afterwards so Animal.sireType follows.
//   npx dotenv -e .env.production -- npx tsx prisma/backfill-sire-type.ts
import { PrismaClient } from "@prisma/client";
import { classifyRound } from "../src/lib/sire-class";
const prisma = new PrismaClient();
const CHUNK = 2000;

async function main() {
  const evals = await prisma.geneticEvaluation.findMany({
    select: { evaluationId: true, sireType: true, officialCode: true, activityCode: true, daughters: true },
  });
  const patches: { id: string; s: string }[] = [];
  for (const e of evals) {
    const s = classifyRound({ officialCode: e.officialCode, activityCode: e.activityCode, daughters: e.daughters });
    if (s !== e.sireType) patches.push({ id: e.evaluationId, s });
  }
  console.log(`evaluations: ${evals.length} · sireType changes: ${patches.length}`);
  for (let i = 0; i < patches.length; i += CHUNK) {
    await prisma.$executeRawUnsafe(
      `UPDATE "GeneticEvaluation" g SET "sireType" = v.s
         FROM jsonb_to_recordset($1::jsonb) AS v(id text, s text)
        WHERE g."evaluationId" = v.id`,
      JSON.stringify(patches.slice(i, i + CHUNK)),
    );
    process.stdout.write(`\r  written ${Math.min(i + CHUNK, patches.length)}/${patches.length}`);
  }
  console.log(`\n[sire-type] done.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
