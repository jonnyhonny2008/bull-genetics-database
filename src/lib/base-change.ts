// ---------------------------------------------------------------------------
// Published Lactanet genetic base changes.
//
// Every April, Canadian genetic evaluations are re-expressed against a newer
// base population. Because a bull's proof is a DEVIATION from that base, when
// the base rises by X the bull's published number falls by X — with no new data
// about the bull at all. That is the rollback.
//
// These figures are published, not modelled, so an April projection can apply
// the real shift instead of an estimate. Source:
//   https://lactanet.ca/en/base-change-summary/  (Base Change Summary, April 2026)
//
// SIGN CONVENTION — the published table gives the amount the BASE moved. To
// project a bull, SUBTRACT it from his current value: `projectedShift()` already
// returns the value to add (i.e. the negated base change), so callers never have
// to think about the direction.
//
// LPI is deliberately 0: Lactanet absorbs its base change into the constant in
// the LPI formula, so published LPI values are not re-based. Our own backtest
// independently found no April signal in LPI, which agrees.
// ---------------------------------------------------------------------------

/** Breed codes used by the published table. */
export type BreedCode = "AY" | "BS" | "CN" | "GU" | "HO" | "JE" | "MS";

/** Map a breed NAME as stored on Animal.breed to the published table's code. */
export function breedCodeOf(breedName: string | null | undefined): BreedCode | null {
  if (!breedName) return null;
  const n = breedName.trim().toLowerCase();
  if (n.startsWith("holstein")) return "HO";
  if (n.startsWith("jersey")) return "JE";
  if (n.startsWith("ayrshire")) return "AY";
  if (n.startsWith("brown")) return "BS";          // Brown Swiss
  if (n.startsWith("canadienne")) return "CN";
  if (n.startsWith("guernsey")) return "GU";
  if (n.startsWith("milking short") || n.startsWith("shorthorn")) return "MS";
  return null;
}

/**
 * Base change by trait, then breed, for a given April.
 * Traits absent from a year's table have no published base change.
 */
const PUBLISHED: Record<number, Partial<Record<string, Record<BreedCode, number>>>> = {
  // April 2026 versus 2025.
  2026: {
    LPI:      { AY: 0,     BS: 0,     CN: 0,     GU: 0,     HO: 0,    JE: 0,    MS: 0 },
    MILK:     { AY: 83,    BS: 31,    CN: 26,    GU: -31,   HO: 82,   JE: 63,   MS: 20 },
    FAT:      { AY: 3.9,   BS: 1.1,   CN: 0.4,   GU: -0.1,  HO: 7.0,  JE: 3.8,  MS: 0.8 },
    PROT:     { AY: 3.6,   BS: 1.4,   CN: 0.5,   GU: 0.0,   HO: 5.0,  JE: 2.8,  MS: 0.9 },
    CONF:     { AY: 0.69,  BS: 0.14,  CN: -0.02, GU: 0.18,  HO: 0.59, JE: 0.16, MS: -0.01 },
    MAMM:     { AY: 0.61,  BS: 0.29,  CN: 0.00,  GU: 0.10,  HO: 0.61, JE: 0.19, MS: -0.04 },
    FL:       { AY: 0.61,  BS: -0.11, CN: -0.09, GU: 0.18,  HO: 0.42, JE: 0.10, MS: 0.03 },
    DS:       { AY: 0.50,  BS: -0.16, CN: 0.01,  GU: 0.10,  HO: 0.25, JE: 0.06, MS: -0.05 },
    RUMP:     { AY: 0.27,  BS: 0.26,  CN: 0.06,  GU: 0.15,  HO: 0.14, JE: 0.00, MS: 0.10 },
    HL:       { AY: 0.23,  BS: 0.41,  CN: 0.02,  GU: 0.18,  HO: 0.42, JE: 0.19, MS: 0.00 },
    SCS:      { AY: 0.14,  BS: 0.26,  CN: 0.14,  GU: 0.47,  HO: 0.41, JE: 0.15, MS: 0.23 },
    DF:       { AY: -0.30, BS: 0.14,  CN: 0.02,  GU: 0.26,  HO: 0.30, JE: 0.16, MS: -0.03 },
  },
};

/** Years we hold a published table for, newest first. */
export const PUBLISHED_YEARS = Object.keys(PUBLISHED).map(Number).sort((a, b) => b - a);

/** The published base change itself (positive = the base moved up). */
export function publishedBaseChange(year: number, traitCode: string, breed: BreedCode | null): number | null {
  if (!breed) return null;
  const v = PUBLISHED[year]?.[traitCode]?.[breed];
  return v == null ? null : v;
}

/**
 * The amount to ADD to a bull's current value when projecting the April round
 * of `year` — i.e. the negated base change. Returns null when that April's
 * table has not been published yet, so the caller can fall back to an estimate
 * (and say so) rather than silently assuming no rollback.
 */
export function projectedShift(year: number, traitCode: string, breed: BreedCode | null): number | null {
  const bc = publishedBaseChange(year, traitCode, breed);
  return bc == null ? null : -bc;
}

/** True when we hold a published table for that April. */
export function hasPublished(year: number): boolean {
  return PUBLISHED[year] != null;
}

/** The most recent April we hold a published table for. */
export const LATEST_PUBLISHED_YEAR = PUBLISHED_YEARS[0];

/**
 * Best available shift for an April that has NOT been published yet.
 *
 * Last year's published table beats a history-derived guess: base changes are
 * steady in character year to year, and — critically — it carries the
 * STRUCTURAL facts. LPI is the clearest case: Lactanet fixes its base change at
 * zero because the LPI formula's constant already absorbs it, so estimating LPI
 * from past Aprils invents a shift that does not exist.
 */
export function fallbackShift(traitCode: string, breed: BreedCode | null): number | null {
  return projectedShift(LATEST_PUBLISHED_YEAR, traitCode, breed);
}
