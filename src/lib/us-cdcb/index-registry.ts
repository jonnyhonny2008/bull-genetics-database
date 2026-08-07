// ---------------------------------------------------------------------------
// Versioned US selection-index registry.
//
// WHY THIS IS A REGISTRY AND NOT A FORMULA
//
// Holstein Association USA revises TPI periodically, and a round must be scored
// with the formula that was in force FOR THAT ROUND. Applying the current
// formula to April 2020 data is wrong by +431 points — not a rounding nuisance,
// a different animal ranking.
//
// Worse, FIVE LAYERS VERSION INDEPENDENTLY: the TPI weights, and separately the
// FE$, FI and HT sub-indexes and the UDC/FLC/BWC composites. The proof is the
// August 2024 change: HAUSA moved the Fertility Index from (.7 DPR + .1 CCR) to
// (.4 DPR + .4 CCR) WITHOUT changing the TPI formula image at all — same image
// file, same constant. A registry keyed on the TPI formula alone computes rounds
// 2408 and 2412 wrong by ~15 points on every bull, which silently reorders the
// top 100. So each layer is resolved separately, by round.
//
// Measured cost of resolving the wrong version (real 2026 bulls vs HAUSA's list):
//     April 2021 formula          -477
//     April 2025 weights           +20   (7 of 101 within +/-2)
//     correct weights, stale FI    -14
//
// PROVENANCE. Every weight, divisor, multiplier and constant below was read from
// HAUSA's own formula images and page text (live page + Wayback captures; see
// `source` on each version). Nothing here is inferred from a secondary source
// unless it is explicitly marked `contested`.
//
// VALIDATION. This arithmetic reproduced HAUSA's published lists across four
// rounds: April 2026 Top 100 (99/99 within +/-3, mean error +0.02), April 2026
// Top 200 Genomic Young Bulls (193/193), April 2024 (69/69), April 2020 (98/98).
// Composites reproduce exactly: UDC exact for 98/98 at 2004, FLC 69/69 at 2404.
//
// ACCURACY IS +/-3 POINTS, NOT +/-2. Quote +/-3 and gate tests at +/-3; a tighter
// bound produces false alarms (190/193 within +/-2 but 193/193 within +/-3).
// ---------------------------------------------------------------------------

/** How much we trust a version's numbers. */
export type IndexConfidence = "verified" | "inferred" | "contested";

/** Whether CDCB public data even exists for the rounds a version governs. */
export type IndexAvailability = "data_available" | "no_cdcb_data";

/**
 * The earliest round CDCB publishes on the public FTP. The historical floor is
 * imposed by DATA availability, not by formula recovery — every version before
 * this is seeded for completeness and can never be computed.
 */
export const CDCB_DATA_FLOOR = 201904;

/** "2604" -> 202604, so versions can be ordered and compared. */
export function roundOrdinal(roundCode: string): number {
  const m = /^(\d{2})(\d{2})$/.exec(roundCode ?? "");
  if (!m) throw new Error(`bad round code "${roundCode}" — expected YYMM, e.g. "2604"`);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) throw new Error(`bad round code "${roundCode}" — month ${mm}`);
  return 2000_00 + Number(m[1]) * 100 + mm;
}

interface VersionBase {
  label: string;
  /** Inclusive first round ordinal this version governs. */
  from: number;
  /** Inclusive last round ordinal, or null for "current". */
  to: number | null;
  availability: IndexAvailability;
  /** Confidence in the NUMBERS. */
  confidence: IndexConfidence;
  /** Confidence in the effective DATES (which rounds it governs). */
  datesConfidence: IndexConfidence;
  source: string;
}

/** Pick the version in force for a round. Returns null rather than guessing. */
function resolve<T extends VersionBase>(versions: T[], ord: number): T | null {
  return versions.find((v) => ord >= v.from && (v.to === null || ord <= v.to)) ?? null;
}

// --- Layer 5: linear transforms + composites ---------------------------------
// Published on holsteinusa.com/genetic_evaluations/ss_linear.html. RP* is
// asymmetric and non-obvious: a bull at RTP 2.22 contributes 0.778, LESS than a
// bull at RTP 1.00. Do not "simplify" these.

const RPstar = (rtp: number) => (rtp <= 1 ? rtp : 1 - rtp * 0.1);
const TLstar = (tlg: number) => { const a = Math.abs(tlg); return -a - a * a * 0.1; };
const SVstar = (rls: number) => { const a = Math.abs(rls); return -0.27 * a - a * a * 0.22; };

export interface LinearTraits {
  FUA: number; RUH: number; RUW: number; UCL: number; UDP: number; FTP: number;
  RTP: number; TLG: number; STA: number; FTA: number; RLR: number; RLS: number;
  FLS: number; STR: number; BDE: number; TRW: number; DFM: number;
}

interface CompositeVersion extends VersionBase {
  fn: (t: LinearTraits) => number;
  /** CDCB trait codes this composite reads — versioned, because the published
   *  trait set changed over time (FLC v2017 has no side-view term at all). */
  requires: string[];
}

/** Udder Composite. The 2015-base form drops the -0.03 offset of the 2010 base. */
const UDC_VERSIONS: CompositeVersion[] = [
  {
    label: "UDC v2020 (2015 base)", from: 202004, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_linear.html (Wayback 20200703222130)",
    fn: (t) => (0.16 * t.FUA + 0.23 * t.RUH + 0.19 * t.RUW + 0.08 * t.UCL + 0.20 * t.UDP
      + 0.04 * t.FTP + 0.05 * RPstar(t.RTP) + 0.05 * TLstar(t.TLG) - 0.20 * t.STA) * 1.16,
    requires: ["FUA","RUH","RUW","UCL","UDP","FTP","RTP","TLG","STA"],
  },
  {
    label: "UDC v2017 (2010 base)", from: 201708, to: 201912,
    // Weights are verified but this arithmetic has never been tested against a
    // published list — no 2019 HAUSA list has been obtained.
    availability: "data_available", confidence: "inferred", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_linear.html (Wayback 20200117143955)",
    fn: (t) => -0.03 + (0.16 * t.FUA + 0.23 * t.RUH + 0.19 * t.RUW + 0.08 * t.UCL + 0.20 * t.UDP
      + 0.04 * t.FTP + 0.05 * RPstar(t.RTP) + 0.05 * TLstar(t.TLG) - 0.20 * t.STA) * 1.16,
    requires: ["FUA","RUH","RUW","UCL","UDP","FTP","RTP","TLG","STA"],
  },
];

/**
 * Feet & Legs Composite.
 *
 * NOTE the x1.14 side-view form IS current. An earlier research pass concluded
 * the August-2017 form (x1.09, no side-view term) was still in force and that
 * adding RLS "worsened the fit"; that was wrong. The x1.14 form reproduces
 * published FLC exactly at three separate rounds.
 */
const FLC_VERSIONS: CompositeVersion[] = [
  {
    label: "FLC v2020 (2015 base)", from: 202004, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_linear.html (Wayback 20200703222130)",
    fn: (t) => (0.05 * t.FTA + 0.20 * t.RLR + 0.05 * SVstar(t.RLS) + 0.70 * t.FLS - 0.20 * t.STA) * 1.14,
    requires: ["FTA","RLR","RLS","FLS","STA"],
  },
  {
    label: "FLC v2017 (2010 base)", from: 201708, to: 201912,
    availability: "data_available", confidence: "inferred", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_linear.html (Wayback 20200117143955)",
    fn: (t) => 0.02 + (0.09 * t.FTA + 0.21 * t.RLR + 0.70 * t.FLS - 0.20 * t.STA) * 1.09,
    requires: ["FTA","RLR","FLS","STA"],
  },
];

/** Body Weight Composite. TRW is Thurl Width = HAUSA's "Rump Width"; RPA is a
 *  different trait and is NOT used. */
const BWC_VERSIONS: CompositeVersion[] = [
  {
    label: "BWC v2017", from: 201704, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_linear.html",
    fn: (t) => 0.23 * t.STA + 0.72 * t.STR + 0.08 * t.BDE + 0.17 * t.TRW - 0.47 * t.DFM,
    requires: ["STA","STR","BDE","TRW","DFM"],
  },
];

// --- Layers 2-4: sub-indexes -------------------------------------------------

export interface SubIndexTraits {
  MILK: number; FAT: number; PRO: number; FS: number;
  DPR: number; CCR: number; HCR: number; EFC: number;
  MFV: number; DAB: number; KET: number; MAS: number; MET: number; RPL: number;
}

interface SubVersion extends VersionBase {
  fn: (t: SubIndexTraits, bwc: number) => number;
  /** CDCB trait codes this definition reads. Versioned like everything else,
   *  because CDCB's published trait set GREW over time — the April 2020 extract
   *  carries 46 traits and has no FS (Feed Saved) at all, so demanding today's
   *  37 inputs would refuse a round that is perfectly computable. */
  requires: string[];
  /** True when the definition consumes BWC (the pre-2021 Feed Efficiency forms). */
  needsBwc?: boolean;
}

/**
 * Feed Efficiency. The SHAPE changes at April 2021: pre-2021 it is a function of
 * BWC, from 2021 it is a dollar figure driven by Feed Saved.
 *
 * `FS` is CDCB's FEED SAVED trait — NOT Final Score. That identification was
 * proven, not assumed: using it reproduces HAUSA's published FE$ to 0.000 for
 * 99 of 99 bulls.
 *
 * Note the sign flip on Milk between v2021 (+0.0008) and v2025 (-0.0025).
 */
const FE_VERSIONS: SubVersion[] = [
  {
    label: "FE$ v2025", from: 202504, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20250422153102, 'TPI Formula – April 2025')",
    fn: (t) => -0.0025 * t.MILK + 1.86 * t.FAT + 1.75 * t.PRO + 0.13 * t.FS,
    requires: ["MILK","FAT","PRO","FS"],
  },
  {
    label: "FE$ v2021", from: 202104, to: 202412,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20210414041449)",
    fn: (t) => 0.0008 * t.MILK + 1.55 * t.FAT + 1.73 * t.PRO + 0.11 * t.FS,
    requires: ["MILK","FAT","PRO","FS"],
  },
  {
    label: "FE v2020", from: 202004, to: 202012,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20200628231022)",
    fn: (t, bwc) => -0.0188 * t.MILK + 1.45 * t.FAT + 1.85 * t.PRO - 12.4 * bwc,
    requires: ["MILK","FAT","PRO"], needsBwc: true,
  },
  {
    label: "FE v2017", from: 201708, to: 201912,
    // CONTESTED: one pass read 1.22/1.55, two passes citing Upcoming_Changes_aug17.pdf
    // p.7 give 1.28/1.95. Live for rounds 1904/1908/1912 only. Do NOT publish a
    // 2019 TPI until this is re-read and validated against a published 2019 list.
    availability: "data_available", confidence: "contested", datesConfidence: "verified",
    source: "holsteinusa.com/pdf/Upcoming_Changes_aug17.pdf p.7 (coefficients disputed)",
    fn: (t, bwc) => -0.0187 * t.MILK + 1.28 * t.FAT + 1.95 * t.PRO - 12.4 * bwc,
    requires: ["MILK","FAT","PRO"], needsBwc: true,
  },
];

/**
 * Fertility Index — THE LAYER THAT BREAKS A NAIVE REGISTRY.
 *
 * The 202408 boundary is pinned empirically from BOTH sides, because the Wayback
 * capture bracket (20240301 -> 20241006) contains round 2404 and cannot separate
 * 2404 from 2408 on its own:
 *   at round 2404, v2020 matches HAUSA's published FI column (RMSE 0.029) while
 *     v2024 gives RMSE 0.514  -> v2020 was still in force at 2404;
 *   at round 2408, using v2020 costs mean -15.5 (2/69 within +/-2)
 *     -> v2024 was in force at 2408.
 */
const FI_VERSIONS: SubVersion[] = [
  {
    label: "FI v2024", from: 202408, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20241006155752); boundary pinned empirically at 2404/2408",
    fn: (t) => 0.4 * t.DPR + 0.4 * t.CCR + 0.1 * t.HCR + 0.1 * t.EFC,
    requires: ["DPR","CCR","HCR","EFC"],
  },
  {
    label: "FI v2020", from: 202004, to: 202404,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20200628231022); boundary pinned empirically",
    fn: (t) => 0.7 * t.DPR + 0.1 * t.CCR + 0.1 * t.HCR + 0.1 * t.EFC,
    requires: ["DPR","CCR","HCR","EFC"],
  },
  {
    label: "FI v2017", from: 201708, to: 201912,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/pdf/Upcoming_Changes_aug17.pdf",
    fn: (t) => 0.64 * t.DPR + 0.18 * t.CCR + 0.18 * t.HCR,
    requires: ["DPR","CCR","HCR"],
  },
];

/** Health Trait Index. Byte-identical across the 2020/2021/2025/2026 captures and
 *  implicitly validated at four rounds. */
const HT_VERSIONS: SubVersion[] = [
  {
    label: "HT v2020", from: 202004, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_tpi_formula.html",
    fn: (t) => 0.34 * t.MFV + 1.97 * t.DAB + 0.28 * t.KET + 1.50 * t.MAS + 1.12 * t.MET + 0.68 * t.RPL,
    requires: ["MFV","DAB","KET","MAS","MET","RPL"],
  },
];

// --- Layer 1: the TPI formula itself -----------------------------------------

/** A term is `weight x (value / sd)`; the sign lives in the weight. */
export interface TpiTerm { key: TpiInputKey; w: number; sd: number }

export type TpiInputKey =
  | "PTAP" | "PTAF" | "FE" | "PTAT" | "UDC" | "FLC" | "PL" | "HT" | "LIV"
  | "SCS" | "FI" | "DCE" | "DSB" | "DF";

interface TpiVersion extends VersionBase { terms: TpiTerm[]; mult: number; constant: number }

/**
 * All revisions HAUSA has published, newest first. Versions before the CDCB data
 * floor are seeded for completeness and provenance; they can never be computed
 * and are marked `no_cdcb_data`.
 */
const TPI_VERSIONS: TpiVersion[] = [
  {
    label: "April 2026", from: 202604, to: null,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/genetic_evaluations/ss_tpi_formula.html",
    mult: 3.8, constant: 2845,
    terms: [
      { key: "PTAP", w: 24, sd: 17 }, { key: "PTAF", w: 14, sd: 22 },
      { key: "FE", w: 8, sd: 52 }, { key: "PTAT", w: 8, sd: 0.8 },
      { key: "UDC", w: 11, sd: 0.8 }, { key: "FLC", w: 6, sd: 0.8 },
      { key: "PL", w: 5, sd: 1.6 }, { key: "HT", w: 2, sd: 2.0 },
      { key: "LIV", w: 3, sd: 1.4 }, { key: "SCS", w: -4, sd: 0.13 },
      { key: "FI", w: 13, sd: 1.3 }, { key: "DCE", w: -0.5, sd: 0.5 },
      { key: "DSB", w: -1.5, sd: 0.8 },
    ],
  },
  {
    label: "April 2025", from: 202504, to: 202512,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20250422153102)",
    mult: 3.8, constant: 2845,
    terms: [
      { key: "PTAP", w: 19, sd: 17 }, { key: "PTAF", w: 19, sd: 22 },
      { key: "FE", w: 8, sd: 52 }, { key: "PTAT", w: 8, sd: 0.8 },
      { key: "UDC", w: 11, sd: 0.8 }, { key: "FLC", w: 6, sd: 0.8 },
      { key: "PL", w: 5, sd: 1.6 }, { key: "HT", w: 2, sd: 2.0 },
      { key: "LIV", w: 3, sd: 1.4 }, { key: "SCS", w: -4, sd: 0.13 },
      { key: "FI", w: 13, sd: 1.3 }, { key: "DCE", w: -0.5, sd: 0.5 },
      { key: "DSB", w: -1.5, sd: 0.8 },
    ],
  },
  {
    label: "April 2021", from: 202104, to: 202412,
    availability: "data_available", confidence: "verified", datesConfidence: "inferred",
    source: "holsteinusa.com ss_tpi_formula.html (Wayback 20210414041449)",
    mult: 3.8, constant: 2363,
    terms: [
      { key: "PTAP", w: 19, sd: 17 }, { key: "PTAF", w: 19, sd: 22 },
      { key: "FE", w: 8, sd: 52 }, { key: "PTAT", w: 8, sd: 0.8 },
      { key: "UDC", w: 11, sd: 0.8 }, { key: "FLC", w: 6, sd: 0.8 },
      { key: "PL", w: 5, sd: 1.6 }, { key: "HT", w: 2, sd: 2.0 },
      { key: "LIV", w: 3, sd: 1.4 }, { key: "SCS", w: -4, sd: 0.13 },
      { key: "FI", w: 13, sd: 1.3 }, { key: "DCE", w: -0.5, sd: 0.5 },
      { key: "DSB", w: -1.5, sd: 0.8 },
    ],
  },
  {
    label: "August 2020", from: 202008, to: 202012,
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/pdf/Adjusting_the_Calving_Trait_Component_of_the_TPI_Formula.pdf",
    mult: 3.8, constant: 2363,
    terms: [
      { key: "PTAP", w: 19, sd: 17 }, { key: "PTAF", w: 19, sd: 22 },
      { key: "FE", w: 8, sd: 45 }, { key: "PTAT", w: 8, sd: 0.8 },
      { key: "UDC", w: 11, sd: 0.8 }, { key: "FLC", w: 6, sd: 0.8 },
      { key: "PL", w: 5, sd: 1.6 }, { key: "HT", w: 2, sd: 2.0 },
      { key: "LIV", w: 3, sd: 1.4 }, { key: "SCS", w: -4, sd: 0.13 },
      { key: "FI", w: 13, sd: 1.3 }, { key: "DCE", w: -0.5, sd: 0.5 },
      { key: "DSB", w: -1.5, sd: 0.8 },
    ],
  },
  {
    label: "April 2020", from: 202004, to: 202004,
    availability: "data_available", confidence: "verified", datesConfidence: "inferred",
    source: "holsteinusa.com images/tpi_april2020_with_abbrev_key.jpg (Wayback 20201125185554)",
    mult: 3.8, constant: 2370,
    terms: [
      { key: "PTAP", w: 19, sd: 17 }, { key: "PTAF", w: 19, sd: 22 },
      { key: "FE", w: 8, sd: 45 }, { key: "PTAT", w: 8, sd: 0.8 },
      { key: "UDC", w: 11, sd: 0.8 }, { key: "FLC", w: 6, sd: 0.8 },
      { key: "PL", w: 5, sd: 1.6 }, { key: "HT", w: 2, sd: 2.0 },
      { key: "LIV", w: 3, sd: 1.4 }, { key: "SCS", w: -4, sd: 0.13 },
      { key: "FI", w: 13, sd: 1.3 }, { key: "DCE", w: -1, sd: 1.0 },
      { key: "DSB", w: -1, sd: 0.9 },
    ],
  },
  {
    label: "August 2017", from: 201708, to: 201912,
    // Governs the only pre-2020 rounds CDCB carries (1904/1908/1912). Depends on
    // FE v2017 (contested) and untested UDC/FLC v2017 arithmetic.
    availability: "data_available", confidence: "verified", datesConfidence: "verified",
    source: "holsteinusa.com/pdf/Upcoming_Changes_aug17.pdf p.4",
    mult: 3.9, constant: 2187,
    terms: [
      { key: "PTAP", w: 21, sd: 19 }, { key: "PTAF", w: 17, sd: 22.5 },
      { key: "FE", w: 8, sd: 44 }, { key: "PTAT", w: 8, sd: 0.73 },
      { key: "DF", w: -1, sd: 1.0 }, { key: "UDC", w: 11, sd: 0.8 },
      { key: "FLC", w: 6, sd: 0.85 }, { key: "PL", w: 4, sd: 1.51 },
      { key: "LIV", w: 3, sd: 1.27 }, { key: "SCS", w: -5, sd: 0.12 },
      { key: "FI", w: 13, sd: 1.25 }, { key: "DCE", w: -2, sd: 1.0 },
      { key: "DSB", w: -1, sd: 0.9 },
    ],
  },
];

// --- Resolution + computation ------------------------------------------------

export interface ResolvedTpiFormula {
  tpi: TpiVersion;
  /** Null when the resolved TPI version has no such term — the August-2017
   *  formula predates the Health Trait Index, for example. */
  fe: SubVersion | null;
  fi: SubVersion | null;
  ht: SubVersion | null;
  udc: CompositeVersion | null;
  flc: CompositeVersion | null;
  bwc: CompositeVersion;
}

export type TpiUnavailableReason =
  /** The round predates CDCB's public archive, or no formula covers it. */
  | "no_round_data"
  /** A round arrived that the registry does not cover — a loud, alertable failure. */
  | "formula_version_unknown";

export class TpiUnavailable extends Error {
  constructor(public reason: TpiUnavailableReason, public roundCode: string, message: string) {
    super(message);
  }
}

/**
 * Resolve every layer for a round.
 *
 * NEVER falls back to the current formula for an uncovered round — that is wrong
 * by hundreds of points and is the single most dangerous thing this module could
 * do. It throws instead, and the UI renders an explicit "not available" state.
 */
export function resolveTpiFormula(roundCode: string): ResolvedTpiFormula {
  const ord = roundOrdinal(roundCode);
  if (ord < CDCB_DATA_FLOOR) {
    throw new TpiUnavailable("no_round_data", roundCode, `No CDCB evaluation data is published for ${roundCode} (archive starts at April 2019).`);
  }
  const tpi = resolve(TPI_VERSIONS, ord);
  if (!tpi) {
    throw new TpiUnavailable(
      "formula_version_unknown", roundCode,
      `TPI is not available for the ${roundCode} evaluation — the Holstein Association USA formula in force for that round has not been verified.`,
    );
  }

  // Only demand the layers this version actually references. TPI has gained and
  // lost terms over the years (the August-2017 formula has no Health Trait Index
  // at all), so requiring a fixed set would refuse rounds we can compute.
  const used = new Set(tpi.terms.map((t) => t.key));
  const fe = used.has("FE") ? resolve(FE_VERSIONS, ord) : null;
  const fi = used.has("FI") ? resolve(FI_VERSIONS, ord) : null;
  const ht = used.has("HT") ? resolve(HT_VERSIONS, ord) : null;
  const udc = used.has("UDC") ? resolve(UDC_VERSIONS, ord) : null;
  const flc = used.has("FLC") ? resolve(FLC_VERSIONS, ord) : null;
  // BWC is not a TPI term itself, but the pre-2021 Feed Efficiency definitions
  // consume it, so it must resolve whenever FE does.
  const bwc = resolve(BWC_VERSIONS, ord);

  const missing = [
    used.has("FE") && !fe && "Feed Efficiency",
    used.has("FI") && !fi && "Fertility Index",
    used.has("HT") && !ht && "Health Trait Index",
    used.has("UDC") && !udc && "UDC",
    used.has("FLC") && !flc && "FLC",
    !bwc && "BWC",
  ].filter(Boolean);
  if (missing.length) {
    throw new TpiUnavailable(
      "formula_version_unknown", roundCode,
      `TPI is not available for the ${roundCode} evaluation — a component formula in force for that round has not been verified (missing: ${missing.join(", ")}).`,
    );
  }
  return { tpi, fe, fi, ht, udc, flc, bwc: bwc! };
}

/** The weakest confidence across the resolved layers — what the UI must surface. */
export function formulaConfidence(f: ResolvedTpiFormula): IndexConfidence {
  const all: VersionBase[] = [];
  for (const v of [f.tpi, f.fe, f.fi, f.ht, f.udc, f.flc, f.bwc]) if (v) all.push(v);
  if (all.some((v) => v.confidence === "contested")) return "contested";
  if (all.some((v) => v.confidence === "inferred" || v.datesConfidence === "inferred")) return "inferred";
  return "verified";
}

/** Trait codes a TPI term reads directly (as opposed to via a sub-index). */
const DIRECT_TERM_TRAITS: Partial<Record<TpiInputKey, string>> = {
  PTAP: "PRO", PTAF: "FAT", PTAT: "PTAT", PL: "PL", LIV: "LIV",
  SCS: "SCS", DCE: "DCE", DSB: "DSB",
};

/**
 * Every CDCB trait code a round's formula actually needs.
 *
 * MUST BE DERIVED PER ROUND, not fixed. CDCB's published trait set GREW over
 * time — the April 2020 extract declares FIELDS:46 and carries no FS (Feed
 * Saved) at all, while the April 2026 one carries 52 and does. The 2020 formula
 * does not want FS either (its Feed Efficiency definition consumes BWC instead),
 * so demanding today's 37 inputs would return null for every bull in a round we
 * can compute perfectly well.
 */
export function tpiRequiredTraits(formula: ResolvedTpiFormula): string[] {
  const need = new Set<string>();
  for (const term of formula.tpi.terms) {
    const direct = DIRECT_TERM_TRAITS[term.key];
    if (direct) need.add(direct);
  }
  for (const v of [formula.fe, formula.fi, formula.ht]) if (v) for (const c of v.requires) need.add(c);
  for (const v of [formula.udc, formula.flc]) if (v) for (const c of v.requires) need.add(c);
  // BWC is needed when a Feed Efficiency definition consumes it, and only then.
  if (formula.fe?.needsBwc) for (const c of formula.bwc.requires) need.add(c);
  return [...need];
}

/** The traits the CURRENT formula reads — 37 of them, present for 100% of
 *  Holstein animals in both the proven and genomic April-2026 files. */
export const TPI_REQUIRED_TRAITS = [
  "PRO", "FAT", "MILK", "PTAT", "PL", "LIV", "SCS", "DCE", "DSB", "FS",
  "DPR", "CCR", "HCR", "EFC", "MFV", "DAB", "KET", "MAS", "MET", "RPL",
  "FUA", "RUH", "RUW", "UCL", "UDP", "FTP", "RTP", "TLG", "STA",
  "FTA", "RLR", "RLS", "FLS", "STR", "BDE", "TRW", "DFM",
] as const;

export type TpiTraitInput = Record<string, number | null | undefined>;

export interface TpiResult {
  /** The index, rounded — display whole numbers only. Accuracy is +/-3, so a
   *  decimal would claim precision we do not have. */
  value: number;
  /** Unrounded, for regression tests and diagnostics. Never display. */
  raw: number;
  /** The bracket total before x multiplier + constant. */
  bracket: number;
  formula: ResolvedTpiFormula;
  confidence: IndexConfidence;
  /** Derived intermediates, useful on a detail page. */
  composites: { udc: number; flc: number; bwc: number; fe: number; fi: number; ht: number };
  /** Per-term breakdown, for "why is his TPI this?" */
  terms: { key: TpiInputKey; value: number; weight: number; sd: number; contribution: number }[];
}

/**
 * Compute TPI for one animal at one round.
 *
 * Returns null when any required trait is missing — a partial TPI is a wrong
 * TPI. (In practice CDCB publishes all 37 for every Holstein animal, so a null
 * here means a data problem worth surfacing, not a normal case.)
 */
export function computeTpi(traits: TpiTraitInput, roundCode: string): TpiResult | null {
  const formula = resolveTpiFormula(roundCode);

  // Derived from the RESOLVED formula, not a fixed list — see tpiRequiredTraits.
  const t: Record<string, number> = {};
  for (const code of tpiRequiredTraits(formula)) {
    const v = traits[code];
    if (v == null || !Number.isFinite(v)) return null;
    t[code] = v;
  }
  // Anything a composite reads but this round does not require reads as 0; the
  // required check above guarantees every code the formula actually uses is set.
  for (const code of TPI_REQUIRED_TRAITS) if (t[code] === undefined) t[code] = 0;
  const lin = t as unknown as LinearTraits;
  const sub = t as unknown as SubIndexTraits;

  const bwc = formula.bwc.fn(lin);
  const udc = formula.udc ? formula.udc.fn(lin) : 0;
  const flc = formula.flc ? formula.flc.fn(lin) : 0;
  const fe = formula.fe ? formula.fe.fn(sub, bwc) : 0;
  const fi = formula.fi ? formula.fi.fn(sub, bwc) : 0;
  const ht = formula.ht ? formula.ht.fn(sub, bwc) : 0;

  const values: Record<TpiInputKey, number> = {
    PTAP: t.PRO, PTAF: t.FAT, FE: fe, PTAT: t.PTAT, UDC: udc, FLC: flc,
    PL: t.PL, HT: ht, LIV: t.LIV, SCS: t.SCS, FI: fi, DCE: t.DCE, DSB: t.DSB,
    // Daughter Fertility, used only by the August-2017 formula. CDCB does not
    // publish a DF trait, so pre-2020 rounds cannot use it — see the guard below.
    DF: 0,
  };

  const terms = formula.tpi.terms.map((term) => ({
    key: term.key, value: values[term.key], weight: term.w, sd: term.sd,
    contribution: (term.w * values[term.key]) / term.sd,
  }));
  // The 2017 formula carries a DF term CDCB has no trait for. Rather than score
  // it as zero (which silently biases every 2019 bull), refuse the round.
  if (formula.tpi.terms.some((x) => x.key === "DF")) return null;

  const bracket = terms.reduce((s, x) => s + x.contribution, 0);
  const raw = bracket * formula.tpi.mult + formula.tpi.constant;

  return {
    value: Math.round(raw), raw, bracket, formula,
    confidence: formulaConfidence(formula),
    composites: { udc, flc, bwc, fe, fi, ht },
    terms,
  };
}

/** Registry contents, for an admin "which formula applies to which round" page. */
export const INDEX_REGISTRY = {
  tpi: TPI_VERSIONS, fe: FE_VERSIONS, fi: FI_VERSIONS, ht: HT_VERSIONS,
  udc: UDC_VERSIONS, flc: FLC_VERSIONS, bwc: BWC_VERSIONS,
};
