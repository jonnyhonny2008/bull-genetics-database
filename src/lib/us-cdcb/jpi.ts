// ---------------------------------------------------------------------------
// JPI — the American Jersey Cattle Association's Jersey Performance Index.
//
// Same versioned-registry discipline as TPI (see index-registry.ts): a round is
// scored with the formula that was IN FORCE FOR THAT ROUND, and the engine
// refuses rather than guessing for a round it does not cover.
//
// WHERE THE CONSTANTS COME FROM — this took finding, and the obvious sources are
// dead ends worth recording so nobody re-treads them:
//   * AJCA's standalone `JPISummary2020.pdf` — still linked from the Green Book
//     home page as "the JPI Formula" — prints every divisor as the literal token
//     "SD". So do every Green Book edition from 2015 through April 2023.
//   * The academic and extension literature publishes only relative-emphasis
//     PERCENTAGES (Cole 2021 JDS; Choi 2025 JABG), and its citation chain
//     dead-ends in AJCA press copy. No paper carries the divisors.
//   * The NUMBERS ARE PRINTED IN THE GREEN BOOK ITSELF — the Jersey Genetic
//     Summary print edition, page 5 — and only from the DECEMBER 2023 edition
//     onward (they also appeared in the 2010-2014 editions, then vanished for
//     nearly a decade).
//
// TWO CORRECTIONS TO THE OBVIOUS ASSUMPTIONS:
//   1. JPI2023 IS NOT CURRENT. JPI2025 is — approved 30 Jan 2025, effective the
//      April 2025 round. Same ten traits and weights, but different divisors, a
//      different udder optimum, and a constant that JPI2023 does not have.
//   2. The Green Book ALSO prints a current-population SD table (page 4). Those
//      are NOT the formula divisors — same order of magnitude, different numbers.
//      The divisors are frozen at formula adoption. Do not substitute one for the
//      other.
//
// VALIDATION: computed against AJCA's own published Green Book values with ZERO
// fitted parameters — 1698/1699 exact at round 2604, 1683/1683 at 2512,
// 1706/1707 at 2504. (A blind least-squares recovery run before the document was
// found independently reproduced these same constants to within ~1%, which is
// what first proved they were real rather than a lucky fit.)
// ---------------------------------------------------------------------------

import { roundOrdinal, type IndexConfidence } from "./index-registry";

/** CDCB trait codes JPI reads. Present for 100% of Jersey animals. */
export const JPI_REQUIRED_TRAITS = ["PRO", "FAT", "PL", "CCR", "DPR", "SCS", "MAS", "UDP", "FUA", "RUH"] as const;

export interface JpiTraits {
  /** CDCB PRO — AJCA prints it as PROT. */
  PRO: number;
  FAT: number;
  PL: number;
  CCR: number;
  DPR: number;
  SCS: number;
  /** CDCB MAS — AJCA prints it as MAST (mastitis resistance). */
  MAS: number;
  /** CDCB UDP — AJCA prints it as UD (udder depth). Two-way, with an optimum. */
  UDP: number;
  /** CDCB FUA — AJCA prints it as FU (fore udder). Capped. */
  FUA: number;
  /** Rear udder height. Capped. */
  RUH: number;
}

interface JpiVersion {
  label: string;
  from: number;
  to: number | null;
  confidence: IndexConfidence;
  source: string;
  /** Divisors, frozen at formula adoption — NOT the population SDs. */
  sd: { PRO: number; FAT: number; PL: number; CCR: number; DPR: number; SCS: number; MAS: number; UDP: number; FUA: number; RUH: number };
  /** Udder depth is scored on distance from an intermediate optimum. */
  udOptimum: number;
  /** Fore udder and rear udder height are capped — more is not better past here. */
  fuCap: number;
  ruhCap: number;
  /** Added after the weighted sum. JPI2023 has none. */
  constant: number;
}

/** Weights are identical across both versions; only the constants moved. */
const W = { PRO: 30, FAT: 25, PL: 10, CCR: 8, DPR: 7, SCS: -5, MAS: 5, UDP: 4, FUA: 4, RUH: 2 };

const JPI_VERSIONS: JpiVersion[] = [
  {
    label: "JPI2025", from: 202504, to: null,
    confidence: "verified",
    source: "AJCA Jersey Genetic Summary (Green Book) April 2025 / April 2026 print edition, p.5",
    sd: { PRO: 22.94, FAT: 28.54, PL: 1.56, CCR: 1.63, DPR: 1.57, SCS: 0.11, MAS: 1.31, UDP: 1.23, FUA: 0.99, RUH: 0.93 },
    udOptimum: 1.8, fuCap: 2.1, ruhCap: 3.5, constant: 48,
  },
  {
    label: "JPI2023", from: 202312, to: 202412,
    confidence: "verified",
    source: "AJCA Jersey Genetic Summary (Green Book) December 2023 print edition, p.5",
    sd: { PRO: 21.81, FAT: 27.10, PL: 1.53, CCR: 1.58, DPR: 1.49, SCS: 0.11, MAS: 1.19, UDP: 1.25, FUA: 1.01, RUH: 0.91 },
    // "SUM of above values" — JPI2023 genuinely has no constant.
    udOptimum: 2.5, fuCap: 3, ruhCap: 4, constant: 0,
  },
];

export type JpiUnavailableReason = "no_formula_published" | "round_unknown";

export class JpiUnavailable extends Error {
  constructor(public reason: JpiUnavailableReason, public roundCode: string, message: string) {
    super(message);
  }
}

/**
 * Resolve the JPI version for a round.
 *
 * Rounds before December 2023 are NOT computable and never will be from public
 * sources: JPI2015, JPI2017 and JPI2020 print "/ SD" as a symbol in every edition
 * AJCA published. That is a permanent gap, not a to-do.
 */
export function resolveJpiFormula(roundCode: string): JpiVersion {
  const ord = roundOrdinal(roundCode);
  const v = JPI_VERSIONS.find((x) => ord >= x.from && (x.to === null || ord <= x.to));
  if (v) return v;
  if (ord < 202312) {
    throw new JpiUnavailable(
      "no_formula_published", roundCode,
      `JPI cannot be computed for ${roundCode}. AJCA published the JPI2015/2017/2020 formulas with their divisors shown only as the symbol "SD", so the constants for that era are not public.`,
    );
  }
  throw new JpiUnavailable(
    "round_unknown", roundCode,
    `JPI is not available for the ${roundCode} evaluation — the AJCA formula in force for that round has not been verified.`,
  );
}

export interface JpiResult {
  value: number;
  raw: number;
  version: JpiVersion;
  confidence: IndexConfidence;
  terms: { key: keyof JpiTraits; input: number; scored: number; weight: number; sd: number; contribution: number }[];
}

/**
 * Compute JPI for one Jersey at one round.
 *
 * Returns null when any required trait is missing — a partial index is a wrong
 * index.
 *
 * ELIGIBILITY IS THE CALLER'S JOB. AJCA does not publish JPI for crossbreds, and
 * computing it for them ranks `XD`-coded / low-BBR animals at the very top of the
 * list (values up to 281). Filter to purebred Jerseys before displaying a ranking
 * — the AJCA_PJA percent-Jersey-ancestry file is the right eligibility source.
 */
export function computeJpi(traits: Partial<Record<string, number | null | undefined>>, roundCode: string): JpiResult | null {
  const version = resolveJpiFormula(roundCode);

  const collected: Record<string, number> = {};
  for (const code of JPI_REQUIRED_TRAITS) {
    const v = traits[code];
    if (v == null || !Number.isFinite(v)) return null;
    collected[code] = v;
  }
  const t = collected as unknown as JpiTraits;

  // Three traits are not scored linearly:
  //   SCS  is a deviation from 3.0 and is negatively weighted (lower is better);
  //   UDP  is two-way — credit falls off on BOTH sides of an intermediate optimum;
  //   FUA and RUH are capped, so more stops helping past the cap.
  const scored: Record<keyof JpiTraits, number> = {
    PRO: t.PRO, FAT: t.FAT, PL: t.PL, CCR: t.CCR, DPR: t.DPR,
    SCS: t.SCS - 3,
    MAS: t.MAS,
    UDP: version.udOptimum - Math.abs(t.UDP - version.udOptimum),
    FUA: Math.min(t.FUA, version.fuCap),
    RUH: Math.min(t.RUH, version.ruhCap),
  };

  const terms = (Object.keys(W) as (keyof JpiTraits)[]).map((key) => {
    const weight = W[key], sd = version.sd[key];
    return { key, input: t[key], scored: scored[key], weight, sd, contribution: (weight * scored[key]) / sd };
  });

  const raw = terms.reduce((s, x) => s + x.contribution, 0) + version.constant;
  // AJCA rounds half-up; JS Math.round already does for positives, and for
  // negatives half-up means -0.5 -> 0, which Math.round also gives.
  return { value: Math.round(raw), raw, version, confidence: version.confidence, terms };
}

export const JPI_REGISTRY = JPI_VERSIONS;
