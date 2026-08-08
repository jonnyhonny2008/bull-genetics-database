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
import { parsePedigreeNotes, computePedigreeIndex, type ParsedAncestor, type ResolvedAncestor, type AncestorEval } from "../src/lib/pedigree";

const ALGO = "pa-male-line-v1";
const CHUNK = 200;
// IN-clause batch size for the two bulk lookups below. Kept well under Postgres's
// practical parameter ceiling while cutting the round-trip count from one PER
// ANIMAL to a small constant number overall.
const LOOKUP_CHUNK = 2000;

const PREF_EVAL_SELECT = {
  lpi: true, proDollar: true, conf: true, milk: true, fat: true, prot: true, mamm: true, fl: true, ds: true,
} as const;

/**
 * Split an array into chunks and run an async mapper over each, sequentially
 * (each chunk is one round trip; the DB, not the network, is the bottleneck
 * here, and Supabase's connection cap is shared with everything else running
 * against it — no benefit and real risk in firing chunks concurrently).
 */
async function mapChunked<T, R>(items: T[], size: number, fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await fn(items.slice(i, i + size))));
  return out;
}

export async function computePedigreeIndexAll(prisma: PrismaClient): Promise<{
  animals: number; withIndex: number; highConfidence: number;
}> {
  const refs = await prisma.pedigreeReference.findMany({
    where: { notes: { contains: "SIRE:" } },
    select: { animalId: true, notes: true },
  });

  // Parse every animal's ancestors up front (pure, no DB) so the two lookups
  // below can be sized from the ACTUAL distinct set needed, not guessed.
  const parsedByAnimal = refs.map((ref) => ({ animalId: ref.animalId, ancestors: parsePedigreeNotes(ref.notes) }));

  // ---------------------------------------------------------------------
  // THIS is the fix. The original shape called resolveAncestors() once PER
  // ANIMAL — itself a correct "2 batched queries" for that one animal's ~6
  // ancestors, but multiplied across every animal in the herd that becomes one
  // sequential, awaited round trip pair per animal. At the ~1,000-bull Blondin
  // lineup that was a few thousand round trips and finished in about a minute;
  // at the ~99,800-bull whole-population roster it is ~200,000 sequential round
  // trips to a remote database — hours in the best case, and a single dropped
  // connection anywhere in that chain (which WILL happen at that length) hangs
  // the whole run with no error and no progress logged, because nothing between
  // one row and the next ever gets a chance to report back.
  //
  // The fix batches resolution across EVERY animal at once: collect the union of
  // every distinct ancestor registration referenced anywhere in the herd, look
  // all of them up in a handful of chunked queries, then compute each animal's
  // pedigree index from the resulting in-memory maps with ZERO further DB calls
  // in the per-animal loop. Same two-query SHAPE resolveAncestors uses (an
  // AnimalIdentifier lookup, then an Animal lookup) — just run ONCE for the
  // whole population instead of once per animal, mirroring resolveAncestors'
  // own map-collapse behaviour (last match wins on a duplicate idValue) so
  // results are identical to the old per-animal path, only reachable at scale.
  // ---------------------------------------------------------------------
  const allRegs = [...new Set(parsedByAnimal.flatMap((p) => p.ancestors.map((a) => a.reg).filter((r): r is string => !!r)))];

  const idRows = allRegs.length
    ? await mapChunked(allRegs, LOOKUP_CHUNK, (chunk) =>
        prisma.animalIdentifier.findMany({ where: { idValue: { in: chunk }, animal: { archived: false } }, select: { idValue: true, animalId: true } }))
    : [];
  const regToAnimalId = new Map(idRows.map((r) => [r.idValue, r.animalId]));

  const ancestorAnimalIds = [...new Set(idRows.map((r) => r.animalId))];
  type AncestorAnimalRow = { id: string; sireType: string | null; proofStatus: string | null; evaluations: (AncestorEval | null)[] };
  const ancestorAnimals = ancestorAnimalIds.length
    ? await mapChunked<string, AncestorAnimalRow>(ancestorAnimalIds, LOOKUP_CHUNK, (chunk) =>
        prisma.animal.findMany({
          where: { id: { in: chunk } },
          select: { id: true, sireType: true, proofStatus: true, evaluations: { where: { isPreferred: true }, take: 1, select: PREF_EVAL_SELECT } },
        }))
    : [];
  const byAnimalId = new Map(ancestorAnimals.map((a) => [a.id, a]));

  /** Pure, in-memory equivalent of resolveAncestors() fed from the maps above. */
  function resolveFromMaps(ancestors: ParsedAncestor[]): ResolvedAncestor[] {
    return ancestors.map((a) => {
      const animalId = a.reg ? regToAnimalId.get(a.reg) ?? null : null;
      const animal = animalId ? byAnimalId.get(animalId) : null;
      return {
        ...a,
        animalId: animalId ?? null,
        sireType: animal?.sireType ?? null,
        proofStatus: animal?.proofStatus ?? null,
        evalValues: (animal?.evaluations[0] ?? null) as AncestorEval | null,
      };
    });
  }

  let withIndex = 0, highConfidence = 0;
  const rows: { animalId: string; indexValue: number | null; confidenceScore: number; notes: string }[] = [];

  for (const { animalId, ancestors } of parsedByAnimal) {
    const resolved = resolveFromMaps(ancestors);
    const pi = computePedigreeIndex(resolved);
    if (pi.confidence > 0) withIndex++;
    if (pi.confidence >= 0.85) highConfidence++;
    rows.push({
      animalId,
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
