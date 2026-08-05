import "server-only";

// ---------------------------------------------------------------------------
// Specialists — bulls with SOLIDLY POSITIVE values for a chosen set of traits.
//
// Lives in the Animals list, not as a report: pick a few traits and the list
// narrows to the sires that are clearly good at all of them at once (long teats
// AND fast milking AND clean bone, say). "Solidly positive" is measured against
// the lineup's own spread so it is fair across scales — a milk deviation in kg
// and a −15..+15 linear trait can't share one fixed cut-off.
//
// It reads each bull's PREFERRED proof off traitsJson, so ANY trait works,
// including the linear type traits and the 100-scale functional ones that have
// no indexed column. It returns a set of animal ids, which the Animals page
// folds into its normal query — so paging, sorting and the other filters all
// keep working.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import type { Prisma } from "@prisma/client";
import { unpackTraits, traitDefMap } from "./eval-traits";

/** 100-scale functional ratings: "positive" means above 100, not above 0. */
const RATING_CODES = new Set([
  "SCS", "HL", "DF", "MR", "MDR", "CA", "DCA", "MSPD", "MTMP", "LP", "FE", "METH", "HH", "BMR", "CO", "CH", "BCS", "SEMFERT",
]);
export function traitBaseline(code: string): number {
  return RATING_CODES.has(code) ? 100 : 0;
}

export interface SpecialistTrait {
  code: string;
  name: string;
  group: string; // optgroup / section label
  order: number;
}

/**
 * Traits worth "specialising" in — every dairy numeric trait a bull carries
 * EXCEPT the aggregate indexes (LPI, Pro$, PI, …). A specialist is defined by
 * the individual traits he excels at, not by an overall index.
 */
export async function specialistTraits(): Promise<SpecialistTrait[]> {
  const defs = await prisma.traitDefinition.findMany({
    where: { domain: "genetic", active: true, speciesType: "dairy" },
    select: { traitCode: true, traitName: true, category: true, displayOrder: true, isLinear: true, graphGroup: true },
  });
  const SKIP_CAT = new Set(["Index", "Genomics", "Descriptive"]);
  return defs
    .filter((d) => !SKIP_CAT.has(d.category ?? ""))
    .map((d) => ({
      code: d.traitCode,
      name: d.traitName,
      group: d.isLinear ? `Type — ${d.graphGroup ?? "Linear"}` : d.category ?? "Other",
      order: d.displayOrder,
    }))
    .sort((a, b) => a.order - b.order);
}

export type SpecialistLevel = "positive" | "solid" | "strong";
export const SPECIALIST_LEVELS: { code: SpecialistLevel; label: string; sd: number; hint: string }[] = [
  { code: "positive", label: "Positive", sd: 0, hint: "above the trait's neutral point" },
  { code: "solid", label: "Solidly positive", sd: 0.5, hint: "at least ½ SD above the lineup average" },
  { code: "strong", label: "Strong", sd: 1, hint: "at least 1 SD above the lineup average" },
];
export function parseLevel(v: string | undefined): SpecialistLevel {
  return v === "positive" || v === "strong" ? v : "solid";
}

export interface SpecialistResult {
  ids: string[];
  poolN: number;
  bars: { code: string; name: string; baseline: number; threshold: number | null }[];
}

/**
 * Which animals in `poolWhere` are solidly positive for EVERY code in `codes`.
 *
 * The bar for each trait is `baseline + level.sd × (lineup SD for that trait)`,
 * computed over the same pool being filtered — so "solid" means solid relative
 * to the bulls in view. A bull missing a queried trait cannot qualify.
 */
export async function specialistFilter(
  poolWhere: Prisma.AnimalWhereInput,
  codes: string[],
  level: SpecialistLevel,
): Promise<SpecialistResult> {
  const codesU = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!codesU.length) return { ids: [], poolN: 0, bars: [] };

  const defMap = await traitDefMap();
  const nameOf = (c: string) => defMap.get(c)?.name ?? c;
  const sdMult = SPECIALIST_LEVELS.find((l) => l.code === level)?.sd ?? 0.5;

  const bulls = await prisma.animal.findMany({
    where: poolWhere,
    select: { id: true, evaluations: { where: { isPreferred: true }, take: 1, select: { traitsJson: true } } },
  });

  // Per-bull value map for the queried traits.
  const values = new Map<string, Map<string, number>>();
  const seriesByCode = new Map<string, number[]>(codesU.map((c) => [c, []]));
  for (const b of bulls) {
    const ev = b.evaluations[0];
    if (!ev) continue;
    const vm = new Map<string, number>();
    for (const t of unpackTraits(ev.traitsJson, defMap)) {
      if (t.numericValue != null && seriesByCode.has(t.traitCode)) {
        vm.set(t.traitCode, t.numericValue);
        seriesByCode.get(t.traitCode)!.push(t.numericValue);
      }
    }
    values.set(b.id, vm);
  }

  // Threshold per trait: baseline + sdMult × population SD (of the pool).
  const bars = codesU.map((code) => {
    const xs = seriesByCode.get(code) ?? [];
    const baseline = traitBaseline(code);
    let threshold: number | null = null;
    if (xs.length) {
      const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length);
      threshold = baseline + sdMult * sd;
    }
    return { code, name: nameOf(code), baseline, threshold };
  });

  const passes = (v: number, code: string): boolean => {
    const bar = bars.find((b) => b.code === code)!;
    // "Positive" (sdMult 0) is strictly beyond the baseline; the graded levels use
    // the SD-based bar (which is already above the baseline).
    if (sdMult === 0) return v > bar.baseline;
    return bar.threshold != null && v >= bar.threshold;
  };

  const ids: string[] = [];
  for (const [id, vm] of values) {
    let ok = true;
    for (const code of codesU) {
      const v = vm.get(code);
      if (v == null || !passes(v, code)) { ok = false; break; }
    }
    if (ok) ids.push(id);
  }
  return { ids, poolN: bulls.length, bars };
}
