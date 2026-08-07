// ---------------------------------------------------------------------------
// WHICH AMERICAN TRAITS CAN BE RANGE-FILTERED, AND WHY ONLY THESE.
//
// Every trait here is backed by a REAL INDEXED COLUMN on UsEvaluation. That is
// not a stylistic preference — it is the whole reason the feature is usable.
//
// CDCB publishes ~50 traits per bull and this app stores all of them, but the
// other ~30 live only inside gptaJson, a TEXT column. Filtering on one of those
// means casting 68,721 rows of text to jsonb on every page load, and the cost
// was measured against the production database rather than guessed at:
//
//     one trait  (STA <= 1.0)            13.6 s
//     two traits (STA <= 1.0, DFM >= 1)  19.1 s   ... 34.4 s on a second run
//
// A filter that takes a quarter of a minute and gets SLOWER under load is not a
// filter, so those traits are absent rather than offered and slow. The gap is
// closed by giving them columns, not by making this file cleverer: see
// prisma/pending/add-us-trait-columns.md, which is written and ready and needs
// a schema push nobody has authorised yet.
//
// DIRECTION IS FOR LABELLING ONLY. A range is direction-agnostic — that is its
// point, and it is why this replaces the Specialists finder rather than sitting
// beside it. Specialists had to exclude Rump Angle because "top of the list" is
// meaningless on an intermediate optimum; a range says "between -0.5 and +1.0"
// and asks nothing about which end is better. The direction is carried here only
// so the picker can tell the reader which way to lean.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { rangeFilter, type TraitRange } from "../trait-range";
import { usTrait, type UsTraitDirection } from "./trait-catalog";

export interface UsRangeTrait {
  code: string;
  name: string;
  /** Section heading in the picker. */
  group: string;
  /** The indexed UsEvaluation column. Every entry has one — see the header. */
  column: keyof Prisma.UsEvaluationWhereInput & string;
  unit: string | null;
  decimals: number;
  direction: UsTraitDirection;
  /**
   * Whether a positive value takes an explicit "+".
   *
   * True for anything published as a DEVIATION from a base, because a negative
   * Milk or Net Merit is a normal result that must never be mistaken for a
   * positive one. False for the absolute scales — GTPI, JPI, SCS and a
   * reliability percentage are not deviations and "+2800" would be wrong.
   * Matches formatUsTrait() in key-traits.ts, so a filter chip and the column
   * underneath it read the same way.
   */
  signed: boolean;
  /** Shown under the trait in the picker when the plain name is not enough. */
  note?: string;
}

// Direction comes from US_TRAIT_CATALOG wherever that catalogue carries the
// code, so the picker, the linear graphs and the bull card cannot drift apart.
// It is stated inline ONLY for the four computed indexes and the reliability
// figure, none of which are CDCB traits and none of which appear there.
const dir = (code: string, fallback: UsTraitDirection = "higher"): UsTraitDirection =>
  usTrait(code)?.direction ?? fallback;

export const US_RANGE_TRAITS: UsRangeTrait[] = [
  // --- Indexes --------------------------------------------------------------
  { code: "GTPI", name: "GTPI (calculated)", group: "Indexes", column: "tpi", unit: null, decimals: 0, direction: "higher", signed: false, note: "Calculated here, not published by Holstein Association USA" },
  { code: "JPI", name: "JPI (calculated)", group: "Indexes", column: "jpi", unit: null, decimals: 0, direction: "higher", signed: false, note: "Jersey bulls only" },
  { code: "NM", name: "Net Merit", group: "Indexes", column: "nmDollar", unit: "$", decimals: 0, direction: dir("NM"), signed: true },
  { code: "CM", name: "Cheese Merit", group: "Indexes", column: "cmDollar", unit: "$", decimals: 0, direction: dir("CM"), signed: true },
  { code: "FM", name: "Fluid Merit", group: "Indexes", column: "fmDollar", unit: "$", decimals: 0, direction: dir("FM"), signed: true },
  { code: "GM", name: "Grazing Merit", group: "Indexes", column: "gmDollar", unit: "$", decimals: 0, direction: dir("GM"), signed: true },

  // --- Production. PTAs in POUNDS — never a Canadian EBV in kilograms. -------
  { code: "MILK", name: "Milk", group: "Production", column: "milk", unit: "lb", decimals: 0, direction: dir("MILK"), signed: true },
  { code: "FAT", name: "Fat", group: "Production", column: "fat", unit: "lb", decimals: 0, direction: dir("FAT"), signed: true },
  { code: "PRO", name: "Protein", group: "Production", column: "pro", unit: "lb", decimals: 0, direction: dir("PRO"), signed: true },
  { code: "FATPCT", name: "Fat %", group: "Production", column: "fatPct", unit: "%", decimals: 2, direction: dir("FATPCT"), signed: true },
  { code: "PROPCT", name: "Protein %", group: "Production", column: "proPct", unit: "%", decimals: 2, direction: dir("PROPCT"), signed: true },

  // --- Fitness --------------------------------------------------------------
  { code: "PL", name: "Productive Life", group: "Fitness", column: "pl", unit: "mo", decimals: 1, direction: dir("PL"), signed: true },
  { code: "LIV", name: "Cow Livability", group: "Fitness", column: "liv", unit: "%", decimals: 1, direction: dir("LIV"), signed: true },
  { code: "DPR", name: "Daughter Pregnancy Rate", group: "Fitness", column: "dpr", unit: "%", decimals: 1, direction: dir("DPR"), signed: true },
  { code: "CCR", name: "Cow Conception Rate", group: "Fitness", column: "ccr", unit: "%", decimals: 1, direction: dir("CCR"), signed: true },
  // The one trait on this list where a LOW number is the good one, and CDCB does
  // not publish it as a deviation from zero — a bull sits near 2.9, not near 0.
  // That is why Specialists refused to offer it at all; a range handles it
  // correctly by asking for a ceiling instead of a floor.
  { code: "SCS", name: "Somatic Cell Score", group: "Fitness", column: "scs", unit: null, decimals: 2, direction: dir("SCS", "lower"), signed: false, note: "Lower is better — set a maximum, not a minimum" },

  // --- Type -----------------------------------------------------------------
  { code: "PTAT", name: "Type (PTAT)", group: "Type", column: "ptat", unit: null, decimals: 2, direction: dir("PTAT"), signed: true },
  { code: "UDC", name: "Udder Composite", group: "Type", column: "udc", unit: null, decimals: 2, direction: "higher", signed: true },
  { code: "FLC", name: "Feet & Legs Composite", group: "Type", column: "flc", unit: null, decimals: 2, direction: "higher", signed: true },
  // PUBLISHED by Holstein Association USA, not derived here, and null for every
  // bull they did not publish — so a range on it also narrows to their release.
  { code: "HCC", name: "Conformation Composite (HCC)", group: "Type", column: "hcc", unit: null, decimals: 2, direction: "higher", signed: true, note: "Published by HAUSA; only their released bulls carry one" },
  // Intermediate optimum. A range is the only filter that can express it.
  { code: "RPA", name: "Rump Angle", group: "Type", column: "rpa", unit: null, decimals: 2, direction: dir("RPA", "intermediate"), signed: true, note: "Intermediate optimum — a window, not a floor" },

  // --- Proof strength -------------------------------------------------------
  // The same figure the Daughter-proven / Parent-average split is read from, so
  // a reader can set their own bar instead of accepting ours.
  { code: "MILKREL", name: "MILK reliability", group: "Proof strength", column: "milkRel", unit: "%", decimals: 0, direction: "higher", signed: false, note: "Daughter-proven is read from this — see the note under the role pills" },
];

export const US_RANGE_TRAIT_CODES = new Set(US_RANGE_TRAITS.map((t) => t.code));

export function usRangeTrait(code: string): UsRangeTrait | undefined {
  return US_RANGE_TRAITS.find((t) => t.code === code.toUpperCase());
}

/**
 * The range clauses, as ordinary Prisma conditions on indexed columns.
 *
 * Each is a separate entry in the caller's AND array rather than one merged
 * object, so the page can drop any single clause when it recomputes the "what
 * would this pill give me" counts.
 */
export function usRangeWhere(ranges: TraitRange[]): Prisma.UsEvaluationWhereInput[] {
  const out: Prisma.UsEvaluationWhereInput[] = [];
  for (const r of ranges) {
    const t = usRangeTrait(r.code);
    if (!t) continue;
    out.push({ [t.column]: rangeFilter(r) } as Prisma.UsEvaluationWhereInput);
  }
  return out;
}
