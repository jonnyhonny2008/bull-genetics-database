import "server-only";

// ---------------------------------------------------------------------------
// WHICH CANADIAN TRAITS CAN BE RANGE-FILTERED.
//
// The same rule as the American side (src/lib/us-cdcb/range-traits.ts): a trait
// is offered only if it has a REAL INDEXED COLUMN on GeneticEvaluation, which
// here means exactly the keys of TRAIT_COLUMNS. Everything else lives only in
// traitsJson, and the Canadian lineup is 53,052 animals — not the ~1,000 house
// bulls it is easy to picture — so a JSON scan is no cheaper here than it is in
// America. The Specialists finder this replaces did exactly that scan, loading
// every bull's traitsJson into Node on each page load, which is a large part of
// why it had to go.
//
// TWO THINGS ARE READ FROM THE DATABASE RATHER THAN WRITTEN DOWN HERE:
//
//   * The NAME and CATEGORY, so an admin renaming a trait renames it in the
//     picker too.
//   * WHICH WAY IS BETTER — TraitDefinition.higherIsBetter. Canada publishes
//     several traits on a 100-centred rating scale where the good end is not the
//     obvious one, and the configuration row is this app's answer for that
//     everywhere else (see caFavourableEnd in ca-linear.ts). Restating it here
//     would create a second answer that could disagree with the linear graphs.
//
// THE 100-SCALE MATTERS FOR A RANGE IN A WAY IT DID NOT FOR SPECIALISTS. On the
// functional ratings a bull sits near 100, not near 0, so "at least 5" would
// match every bull alive. The baseline travels with the trait and the picker
// prefills from it, so nobody has to know which scale they are on.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { TRAIT_COLUMNS } from "./eval-traits";
import { isCaIntermediateOptimum } from "./ca-linear";
import { rangeFilter, type TraitRange } from "./trait-range";

/**
 * Canadian traits published on a 100-centred rating scale.
 *
 * Same list Specialists used for the same reason, kept here because it is the
 * only place still consuming it once that file is gone. A trait NOT on this list
 * is a deviation from zero.
 */
const RATING_CODES = new Set(["SCS", "HL", "DF", "MR", "MDR", "CA", "DCA"]);

export interface CaRangeTrait {
  code: string;
  name: string;
  /** Section heading in the picker — the trait's own category. */
  group: string;
  /** The indexed GeneticEvaluation column. */
  column: string;
  unit: string | null;
  decimals: number;
  /** Labelling only. A range never assumes a direction — that is its point. */
  direction: "higher" | "lower" | "intermediate";
  /** The trait's neutral point: 100 for the functional ratings, else 0. */
  baseline: number;
  /**
   * Whether a positive value takes an explicit "+".
   *
   * Only the zero-centred deviations do. On a 100-scale rating "+105" is
   * meaningless, and on an aggregate index like LPI it is noise — nobody writes
   * "+3200 LPI".
   */
  signed: boolean;
}

const TTL_MS = 60_000;
let cache: { v: CaRangeTrait[]; at: number } | null = null;
let inflight: Promise<CaRangeTrait[]> | null = null;

/**
 * The Canadian range catalogue. Cached for a minute, in-flight-deduped — the
 * same pattern as src/lib/reference.ts, and for the same reason: this sits on
 * the animals list's critical path and the underlying rows change perhaps
 * monthly.
 */
export async function caRangeTraits(): Promise<CaRangeTrait[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v;
  if (inflight) return inflight;
  inflight = build()
    .then((v) => { cache = { v, at: Date.now() }; inflight = null; return v; })
    .catch((e) => { inflight = null; throw e; });
  return inflight;
}

async function build(): Promise<CaRangeTrait[]> {
  const defs = await prisma.traitDefinition.findMany({
    where: { domain: "genetic", active: true, traitCode: { in: Object.keys(TRAIT_COLUMNS) } },
    orderBy: [{ category: "asc" }, { displayOrder: "asc" }],
    select: { traitCode: true, traitName: true, category: true, unit: true, higherIsBetter: true },
  });

  return defs.flatMap((d) => {
    const column = TRAIT_COLUMNS[d.traitCode];
    // A definition can outlive its column if TRAIT_COLUMNS is edited. Dropping it
    // is right: an offered trait with nothing behind it would silently return an
    // unfiltered list under a filter chip.
    if (!column) return [];
    const rating = RATING_CODES.has(d.traitCode);
    return [{
      code: d.traitCode,
      name: d.traitName,
      group: d.category ?? "Other",
      column,
      unit: d.unit,
      // Percentages and the 100-scale ratings are whole numbers in practice; the
      // component percentages (Fat %, Protein %) are the only two that are not.
      decimals: d.traitCode.endsWith("PCT") ? 2 : 0,
      direction: isCaIntermediateOptimum(d.traitCode, d.traitName)
        ? "intermediate"
        : d.higherIsBetter ? "higher" : "lower",
      baseline: rating ? 100 : 0,
      signed: !rating && d.category !== "Index",
    } as CaRangeTrait];
  });
}

/**
 * All the Canadian range bounds, as ONE condition on the preferred evaluation.
 *
 * They must share a single `some`. Written as one clause per trait, a bull could
 * satisfy LPI >= 3000 on one evaluation row and CONF >= 10 on another and be
 * returned as though he met both — and the schema deliberately allows a pending
 * row to sit alongside an approved one for the same round, so more than one row
 * per animal is a real state, not a hypothetical.
 *
 * Returns null when nothing is filtered, so the caller can skip the clause
 * entirely rather than push an empty `some` that matches only animals WITH an
 * evaluation.
 */
export function caRangeWhere(ranges: TraitRange[], traits: CaRangeTrait[]): Prisma.AnimalWhereInput | null {
  const byCode = new Map(traits.map((t) => [t.code, t]));
  const bounds: Record<string, { gte?: number; lte?: number }> = {};
  for (const r of ranges) {
    const t = byCode.get(r.code);
    if (!t) continue;
    bounds[t.column] = rangeFilter(r);
  }
  if (!Object.keys(bounds).length) return null;
  return {
    evaluations: {
      some: { isPreferred: true, approvalStatus: "approved", ...bounds } as Prisma.GeneticEvaluationWhereInput,
    },
  };
}
