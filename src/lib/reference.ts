import { prisma } from "./db";
import { TRAIT_COLUMNS } from "./eval-traits";
import type { TraitScales } from "./rollback";

// ---------------------------------------------------------------------------
// Cached getters for rarely-changing REFERENCE data (breeds, sources, the trait
// definitions used by the animals filters). These identical queries were being
// re-run on nearly every page; under the serverless connection_limit=1 they add
// serialized round-trips to the hot path.
//
// Same module-memo pattern already used by traitDefMap() in eval-traits.ts, but
// with a short TTL so an admin's edit to a breed/source/trait still shows within
// ~a minute. Per serverless instance (a cold start refetches once); the in-flight
// dedup also collapses concurrent callers into a single query. Returns live rows
// (no serialization), so callers get the exact same shapes as the inline queries.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;

function memoTTL<T>(fn: () => Promise<T>): () => Promise<T> {
  let cached: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.v;
    if (inflight) return inflight;
    inflight = fn()
      .then((v) => { cached = { v, at: Date.now() }; inflight = null; return v; })
      .catch((e) => { inflight = null; throw e; });
    return inflight;
  };
}

/** Active breeds, A→Z — matches the inline `breed.findMany` used on the forms/list. */
export const getActiveBreeds = memoTTL(() =>
  prisma.breed.findMany({ where: { active: true }, orderBy: { breedName: "asc" } }),
);

/** All sources, A→Z — matches the inline `source.findMany` used across the forms. */
export const getAllSources = memoTTL(() =>
  prisma.source.findMany({ orderBy: { sourceName: "asc" } }),
);

/**
 * Per-trait step SDs written by prisma/compute-rollback.ts. Used to score
 * zero-centred traits SD-relative in the LIVE per-bull rollback views, on the same
 * scale as the materialised proofPerformance / rollbackResistance columns. Empty
 * (⇒ percent-change fallback) until the batch has run once.
 */
export const getRollbackTraitScales = memoTTL(async (): Promise<TraitScales> => {
  const row = await prisma.environmentConfig.findUnique({ where: { key: "rollbackTraitScales" }, select: { value: true } });
  if (!row?.value) return {};
  try { return JSON.parse(row.value) as TraitScales; } catch { return {}; }
});

/** The genetic trait defs the Animals filter bar offers (indexed columns only). */
export const getGeneticTraitDefsForFilters = memoTTL(() =>
  prisma.traitDefinition.findMany({
    where: { domain: "genetic", active: true, traitCode: { in: Object.keys(TRAIT_COLUMNS) } },
    orderBy: [{ category: "asc" }, { displayOrder: "asc" }],
    select: { traitCode: true, traitName: true, category: true },
  }),
);
