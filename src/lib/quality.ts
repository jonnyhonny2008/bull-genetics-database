import "server-only";
import { prisma } from "./db";

// ---------------------------------------------------------------------------
// Data-quality indicators + duplicate detection
// ---------------------------------------------------------------------------

export interface QualityFlag {
  code: string;
  label: string;
  severity: "info" | "warn" | "error";
}

type AnimalWithRels = Awaited<ReturnType<typeof loadAnimalForQuality>>;

async function loadAnimalForQuality(animalId: string) {
  return prisma.animal.findUnique({
    where: { id: animalId },
    include: {
      identifiers: true,
      roles: true,
      evaluations: true,
      milkRecords: true,
      classifications: true,
      captures: true,
    },
  });
}

export function qualityFlagsFor(a: NonNullable<AnimalWithRels>): QualityFlag[] {
  const flags: QualityFlag[] = [];
  if (!a.breedId) flags.push({ code: "no_breed", label: "Missing breed", severity: "warn" });
  if (!a.sex) flags.push({ code: "no_sex", label: "Missing sex", severity: "warn" });
  if (!a.identifiers.some((i) => i.isPrimary && i.active))
    flags.push({ code: "no_primary_id", label: "No primary identifier", severity: "warn" });
  if (a.identifiers.length === 0)
    flags.push({ code: "no_id", label: "No identifiers", severity: "error" });
  if (a.evaluations.length === 0)
    flags.push({ code: "no_proof", label: "No genetic proof records", severity: "info" });
  if (a.sex === "F" && a.milkRecords.length === 0)
    flags.push({ code: "no_milk", label: "No milk records", severity: "info" });
  if (a.sex === "F" && a.classifications.length === 0)
    flags.push({ code: "no_class", label: "No classification records", severity: "info" });
  if (
    a.evaluations.every((e) => !e.sourceId) &&
    a.evaluations.length > 0
  )
    flags.push({ code: "no_source", label: "Proof has no source attached", severity: "warn" });
  return flags;
}

// Possible-duplicate detection across all animals.
export interface DuplicateGroup {
  reason: string;
  key: string;
  animals: { id: string; primaryName: string; breedName?: string | null }[];
}

// Efficient at ~100k rows: find shared high-signal identifier values via a DB
// groupBy, then fetch just the animals for the (capped) duplicate groups.
export async function findDuplicateGroups(maxGroups = 50): Promise<DuplicateGroup[]> {
  const strongTypes = ["registration_ca", "registration_us", "registration_int", "naab", "semen_code"];
  const dup = await prisma.animalIdentifier.groupBy({
    by: ["idType", "idValue"],
    where: { idType: { in: strongTypes } },
    _count: { idValue: true },
    having: { idValue: { _count: { gt: 1 } } },
  });

  const groups: DuplicateGroup[] = [];
  for (const d of dup.slice(0, maxGroups)) {
    const idfs = await prisma.animalIdentifier.findMany({
      where: { idType: d.idType, idValue: d.idValue },
      include: { animal: { include: { breed: true } } },
      take: 12,
    });
    const seen = new Set<string>();
    const animals: DuplicateGroup["animals"] = [];
    for (const i of idfs) {
      if (seen.has(i.animalId)) continue;
      seen.add(i.animalId);
      animals.push({ id: i.animalId, primaryName: i.animal.primaryName, breedName: i.animal.breed?.breedName });
    }
    if (animals.length > 1)
      groups.push({ reason: `Shared identifier (${d.idType})`, key: `${d.idType}:${d.idValue}`, animals });
  }
  return groups;
}

// Lightweight duplicate check when creating one animal (used by import matching too).
export async function matchExistingAnimals(input: {
  name?: string;
  identifiers?: { idType: string; idValue: string }[];
  breedId?: string | null;
  sex?: string | null;
}): Promise<{ id: string; primaryName: string; confidence: number; why: string }[]> {
  const results = new Map<string, { id: string; primaryName: string; confidence: number; why: string }>();

  if (input.identifiers?.length) {
    for (const id of input.identifiers) {
      if (!id.idValue) continue;
      const hits = await prisma.animalIdentifier.findMany({
        where: { idType: id.idType, idValue: id.idValue },
        include: { animal: true },
      });
      for (const h of hits) {
        results.set(h.animalId, {
          id: h.animalId,
          primaryName: h.animal.primaryName,
          confidence: 0.98,
          why: `Exact identifier match (${id.idType})`,
        });
      }
    }
  }

  if (input.name) {
    const norm = input.name.trim();
    const nameHits = await prisma.animal.findMany({
      where: { primaryName: { contains: norm } },
      take: 10,
    });
    for (const h of nameHits) {
      if (results.has(h.id)) continue;
      let conf = 0.5;
      if (input.breedId && h.breedId === input.breedId) conf += 0.15;
      if (input.sex && h.sex === input.sex) conf += 0.1;
      results.set(h.id, { id: h.id, primaryName: h.primaryName, confidence: conf, why: "Name similarity" });
    }
  }

  return [...results.values()].sort((a, b) => b.confidence - a.confidence);
}
