// ---------------------------------------------------------------------------
// Materialise the Pedigree Index onto PedigreeIndexResult so it persists and can
// later be listed/sorted, and so the placeholder becomes real data.
//
// Uses the SAME src/lib/pedigree functions the profile page uses, so the stored
// value can never drift from what a bull's Pedigree tab computes live.
//
//   indexValue       = headline LPI pedigree index (null when no ancestor held)
//   confidenceScore  = share of the ½+¼+⅛ obtainable ancestor weight resolved
//   algorithmVersion = "pa-male-line-v1"
//   notes            = JSON of every per-trait pedigree index + contributors
//
// Idempotent: clears prior rows for each animal it recomputes. Run standalone:
//   npx dotenv -e .env.production -- npx tsx prisma/compute-pedigree-index.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { parsePedigreeNotes, resolveAncestors, computePedigreeIndex } from "../src/lib/pedigree";

const ALGO = "pa-male-line-v1";
const CHUNK = 200;

export async function computePedigreeIndexAll(prisma: PrismaClient): Promise<{
  animals: number; withIndex: number; highConfidence: number;
}> {
  const refs = await prisma.pedigreeReference.findMany({
    where: { notes: { contains: "SIRE:" } },
    select: { animalId: true, notes: true },
  });

  let withIndex = 0, highConfidence = 0;
  const rows: { animalId: string; indexValue: number | null; confidenceScore: number; notes: string }[] = [];

  for (const ref of refs) {
    const ancestors = parsePedigreeNotes(ref.notes);
    const resolved = await resolveAncestors(prisma, ancestors);
    const pi = computePedigreeIndex(resolved);
    if (pi.confidence > 0) withIndex++;
    if (pi.confidence >= 0.85) highConfidence++;
    rows.push({
      animalId: ref.animalId,
      indexValue: pi.lpi,
      confidenceScore: Math.round(pi.confidence * 1000) / 1000,
      notes: JSON.stringify({
        traits: pi.traits.filter((t) => t.value != null).map((t) => ({ code: t.code, value: t.value })),
        contributors: pi.contributors.map((c) => ({ relation: c.relation, weight: c.weight, name: c.name })),
      }),
    });
  }

  // Replace prior results for exactly the animals we recomputed, then insert.
  const animalIds = rows.map((r) => r.animalId);
  for (let i = 0; i < animalIds.length; i += CHUNK) {
    await prisma.pedigreeIndexResult.deleteMany({ where: { animalId: { in: animalIds.slice(i, i + CHUNK) }, algorithmVersion: ALGO } });
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.pedigreeIndexResult.createMany({
      data: rows.slice(i, i + CHUNK).map((r) => ({
        animalId: r.animalId,
        indexValue: r.indexValue,
        confidenceScore: r.confidenceScore,
        algorithmVersion: ALGO,
        calculationDate: new Date(),
        sourceReference: "Ancestor evaluations held in this database (proof pedigree).",
        notes: r.notes,
      })),
    });
  }

  return { animals: refs.length, withIndex, highConfidence };
}

// CLI entry point — only when run directly.
if (process.argv[1] && /compute-pedigree-index\.ts$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  computePedigreeIndexAll(prisma)
    .then((r) => {
      console.log(`[pedigree-index] processed ${r.animals} animals`);
      console.log(`[pedigree-index] ${r.withIndex} got an index (≥1 male-line ancestor held), ${r.highConfidence} at ≥85% confidence`);
    })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
