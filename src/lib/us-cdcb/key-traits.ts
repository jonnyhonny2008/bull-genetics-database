// ---------------------------------------------------------------------------
// The traits the American side leads with.
//
// The Canadian equivalent (src/lib/key-traits.ts) is a flat list of nine codes,
// which works there because every one is a Lactanet trait read out of traitsJson
// and every one is higher-is-better. Neither holds here, so this carries more
// information per entry:
//
//   * GTPI IS NOT A CDCB TRAIT. CDCB publishes no index of Holstein Association's
//     — we compute it (see index-registry.ts) and store it on its own column. So
//     each entry declares where its value comes from.
//   * RUMP ANGLE HAS AN INTERMEDIATE OPTIMUM. Neither the highest nor the lowest
//     value is best. Sorting it "high to low" or scoring it as higher-is-better
//     would be wrong, and the Canadian rollback engine's own comment records that
//     it assumes every scored trait is higher-is-better — exactly the assumption
//     that silently scores an improvement as a loss. Direction is explicit here so
//     no consumer has to guess.
// ---------------------------------------------------------------------------

/** Where a key trait's value comes from. */
export type UsTraitSource =
  /** A CDCB-published trait, read from the evaluation's GPTA map. */
  | "cdcb"
  /** An index this app computes from CDCB traits. Never an official figure. */
  | "computed";

/**
 * Which way is better.
 *   higher       — more is better (most production and fitness traits)
 *   lower        — less is better (somatic cell score, calving difficulty)
 *   intermediate — there is an optimum; ranking on the raw value is meaningless
 */
export type TraitDirection = "higher" | "lower" | "intermediate";

export interface UsKeyTrait {
  /** CDCB trait code, or the computed index's key. */
  code: string;
  label: string;
  /** Short label for dense table headers. */
  short: string;
  source: UsTraitSource;
  /** The indexed UsEvaluation column, when one exists — sortable in SQL. */
  column: "tpi" | "nmDollar" | "ptat" | "milk" | "rpa" | "dpr" | "ccr";
  direction: TraitDirection;
  unit: string | null;
  /** Decimal places to display. Yield PTAs are whole pounds; type traits aren't. */
  decimals: number;
}

/**
 * The American lead traits, in display order.
 *
 * A commercial decision, not a data one — these are what this stud sells on.
 */
export const US_KEY_TRAITS: UsKeyTrait[] = [
  { code: "GTPI", label: "GTPI (calculated)", short: "GTPI", source: "computed", column: "tpi", direction: "higher", unit: null, decimals: 0 },
  { code: "NM", label: "Net Merit", short: "NM$", source: "cdcb", column: "nmDollar", direction: "higher", unit: "$", decimals: 0 },
  { code: "PTAT", label: "Type (PTAT)", short: "PTAT", source: "cdcb", column: "ptat", direction: "higher", unit: null, decimals: 2 },
  { code: "MILK", label: "Milk", short: "Milk", source: "cdcb", column: "milk", direction: "higher", unit: "lb", decimals: 0 },
  { code: "RPA", label: "Rump Angle", short: "Rump", source: "cdcb", column: "rpa", direction: "intermediate", unit: null, decimals: 2 },
  { code: "DPR", label: "Daughter Pregnancy Rate", short: "DPR", source: "cdcb", column: "dpr", direction: "higher", unit: "%", decimals: 1 },
  { code: "CCR", label: "Cow Conception Rate", short: "CCR", source: "cdcb", column: "ccr", direction: "higher", unit: "%", decimals: 1 },
];

export const US_KEY_TRAIT_CODES = US_KEY_TRAITS.map((t) => t.code);

/** The key traits that can be meaningfully ranked. Excludes intermediate-optimum
 *  traits, where "top of the list" has no meaning. */
export const US_SORTABLE_KEY_TRAITS = US_KEY_TRAITS.filter((t) => t.direction !== "intermediate");

export function usKeyTrait(code: string): UsKeyTrait | undefined {
  return US_KEY_TRAITS.find((t) => t.code === code.toUpperCase());
}

/**
 * Format a key-trait value for display.
 *
 * Yield PTAs and dollar indexes carry an explicit sign because a negative Milk or
 * Net Merit is a normal, meaningful result and must never be mistaken for a
 * positive one. GTPI is a whole number on a ~3,400 scale and takes no sign.
 */
export function formatUsTrait(t: UsKeyTrait, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(t.decimals);
  const signed = t.code !== "GTPI" && v > 0 ? `+${s}` : s;
  return t.unit === "$" ? `$${signed}` : signed;
}
