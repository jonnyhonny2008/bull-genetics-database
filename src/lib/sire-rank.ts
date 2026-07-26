// Ranking helper for lists whose primary row is NOT the genetic evaluation.
//
// LPI and Conformation live on the animal's preferred GeneticEvaluation. Prisma
// can order a query by a to-one relation's scalar, but not by a filtered row of
// a to-many relation — so a milk or classification record cannot be ordered by
// "the sire's LPI" directly.
//
// This resolves the ordering separately: one indexed query returns the animal ids
// in trait order, and the caller sorts its own rows by that rank in memory.
//
// Kept out of sire-class.ts on purpose: that module is imported by the Prisma
// import scripts (plain tsx, no "@/" alias resolution), so it must stay free of
// any @/lib/db import.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Animal id → rank (0 = first) ordered by a preferred-evaluation column.
 * Animals with no value for the column are absent from the map; callers should
 * sort those to the bottom.
 */
export async function rankAnimalsByEvalColumn(
  col: "lpi" | "conf",
  dir: "asc" | "desc",
  animalAND: Prisma.AnimalWhereInput[] = [],
): Promise<Map<string, number>> {
  const rows = await prisma.geneticEvaluation.findMany({
    where: {
      isPreferred: true,
      [col]: { not: null },
      ...(animalAND.length ? { animal: { AND: animalAND } } : {}),
    },
    orderBy: { [col]: dir },
    select: { animalId: true },
  });
  return new Map(rows.map((r, i) => [r.animalId, i] as const));
}

/**
 * Counts for the four sire-role pills, in ONE query.
 *
 * proven/genomic and active/inactive are independent axes, so a single
 * groupBy over both columns yields every bucket — four `count()` calls would
 * cost four connections from a pool that is only a handful deep.
 */
export async function sireRoleCounts(
  where: Prisma.AnimalWhereInput = { archived: false },
): Promise<Record<string, number>> {
  const groups = await prisma.animal.groupBy({
    by: ["sireType", "proofStatus"],
    where,
    _count: { _all: true },
  });
  const counts: Record<string, number> = { proven: 0, genomic: 0, active: 0, inactive: 0 };
  for (const g of groups) {
    if (g.sireType && g.sireType in counts) counts[g.sireType] += g._count._all;
    if (g.proofStatus && g.proofStatus in counts) counts[g.proofStatus] += g._count._all;
  }
  return counts;
}
