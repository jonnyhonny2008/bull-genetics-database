import "server-only";

// ---------------------------------------------------------------------------
// American specialists — bulls that are solidly positive for EVERY picked trait.
//
// Same idea as the Canadian finder (src/lib/specialists.ts): tick a few traits
// and get back the sires that are clearly good at all of them at once, with the
// bar set against the pool's own spread so traits on wildly different scales
// (Milk in hundreds of pounds, Foot Angle in tenths of a point) can share one
// definition of "solid".
//
// THREE THINGS ARE DIFFERENT HERE, and each one is a correctness matter:
//
//   1. THE BASELINE IS ZERO, ALWAYS. CDCB publishes PTAs as deviations from a
//      genetic base, so zero is a real neutral point. Canada's 100-scale
//      RATING_CODES logic has no counterpart on this side and importing it would
//      put the bar 100 units too high on every trait.
//   2. A TRAIT IS ONLY OFFERED IF "MORE IS BETTER" IS TRUE OF IT. Rump Angle has
//      an intermediate optimum, so a "solidly positive rump angle" specialist is
//      not a better bull — just a higher-pinned one. Traits whose favourable
//      direction is DOWN (SCS, calving ease, stillbirths) are excluded too rather
//      than silently sign-flipped, because CDCB does not publish them centred on
//      zero either: a "positive" SCS is the WORSE bull, and no wording on a page
//      can rescue a filter that ranks the wrong end.
//   3. ONLY OFFICIAL ROUNDS ARE SCORED. Monthly provisional and weekly unofficial
//      rows exist in UsEvaluation; ranking a bull against them would compare him
//      to a different population than the one he is being sold into.
//
// Reads UsEvaluation only. A Canadian EBV in kilograms must never reach this file.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

/** Which way is better for a CDCB trait. Mirrors TraitDirection in key-traits.ts. */
export type UsSpecialistDirection = "higher" | "lower" | "intermediate" | "unknown";

export interface UsSpecialistTrait {
  code: string;
  name: string;
  /** Section label in the picker. */
  group: string;
  direction: UsSpecialistDirection;
  /** Unit, for the picker's tooltip. */
  unit: string | null;
  /** Set when the trait cannot be a specialty. Shown to the user verbatim, so a
   *  trait that is absent from the picker is absent for a stated reason. */
  excluded?: string;
}

// The four reasons a CDCB trait is not offered as a specialty. Kept as constants
// so the page can group the excluded traits by reason instead of repeating prose.
export const WHY_INTERMEDIATE =
  "Intermediate optimum — neither the highest nor the lowest value is best, so there is no bull to find at the top of the list.";
export const WHY_DOWN =
  "Favourable direction is down, and CDCB does not publish it as a deviation from zero. \"Solidly positive\" would name the worse bull, so it is not offered rather than quietly inverted.";
export const WHY_INDEX =
  "An aggregate index. A specialist is defined by the individual traits he excels at, not by an overall ranking.";
export const WHY_UNCONFIRMED =
  "CDCB publishes this code, but we have not confirmed what it measures or which way is better. Not offered rather than guessed at.";

/**
 * Every CDCB trait this app has seen in an evaluation extract, with the
 * direction that makes it a specialty or disqualifies it.
 *
 * INTERMEDIATE-OPTIMUM CALLS. Rump Angle is the one the product rules name, but
 * it is not alone, and the evidence is in this codebase's own index formulas:
 * index-registry.ts transforms RTP, TLG and RLS through RPstar/TLstar/SVstar —
 * curves that PEAK and then fall away — precisely because credit stops at an
 * optimum, and jpi.ts scores UDP as distance from an optimum outright. Stature
 * and Dairy Form are marked the same way on weaker but real evidence: both carry
 * a negative weight in the udder / feet-and-leg composites and a positive one in
 * body weight, so the published formulas themselves disagree about which end is
 * better. "The tallest bull" is not a selling point.
 */
export const US_SPECIALIST_CATALOG: UsSpecialistTrait[] = [
  // --- Production -----------------------------------------------------------
  { code: "MILK", name: "Milk", group: "Production", direction: "higher", unit: "lb" },
  { code: "FAT", name: "Fat", group: "Production", direction: "higher", unit: "lb" },
  { code: "PRO", name: "Protein", group: "Production", direction: "higher", unit: "lb" },
  { code: "FATPCT", name: "Fat %", group: "Production", direction: "higher", unit: "%" },
  { code: "PROPCT", name: "Protein %", group: "Production", direction: "higher", unit: "%" },

  // --- Merit indexes (never a specialty) ------------------------------------
  { code: "NM", name: "Net Merit", group: "Merit indexes", direction: "higher", unit: "$", excluded: WHY_INDEX },
  { code: "CM", name: "Cheese Merit", group: "Merit indexes", direction: "higher", unit: "$", excluded: WHY_INDEX },
  { code: "FM", name: "Fluid Merit", group: "Merit indexes", direction: "higher", unit: "$", excluded: WHY_INDEX },
  { code: "GM", name: "Grazing Merit", group: "Merit indexes", direction: "higher", unit: "$", excluded: WHY_INDEX },

  // --- Fitness & efficiency -------------------------------------------------
  { code: "PL", name: "Productive Life", group: "Fitness & efficiency", direction: "higher", unit: "mo" },
  { code: "LIV", name: "Cow Livability", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "HLV", name: "Heifer Livability", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "DPR", name: "Daughter Pregnancy Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "CCR", name: "Cow Conception Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "HCR", name: "Heifer Conception Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "EFC", name: "Early First Calving", group: "Fitness & efficiency", direction: "higher", unit: "d" },
  { code: "FS", name: "Feed Saved", group: "Fitness & efficiency", direction: "higher", unit: "lb" },
  { code: "MSPD", name: "Milking Speed", group: "Fitness & efficiency", direction: "higher", unit: "lb/min" },
  { code: "SCS", name: "Somatic Cell Score", group: "Fitness & efficiency", direction: "lower", unit: null, excluded: WHY_DOWN },
  { code: "RFI", name: "Residual Feed Intake", group: "Fitness & efficiency", direction: "lower", unit: "lb", excluded: WHY_DOWN },
  {
    code: "GL", name: "Gestation Length", group: "Fitness & efficiency", direction: "intermediate", unit: "d",
    excluded: "Neither direction is uniformly favourable — a shorter gestation frees days but a very short one costs calf vigour — so there is no end of the list to rank.",
  },

  // --- Calving ability (published as % of hard births / stillbirths) ---------
  { code: "SCE", name: "Service Sire Calving Ease", group: "Calving", direction: "lower", unit: "%", excluded: WHY_DOWN },
  { code: "DCE", name: "Daughter Calving Ease", group: "Calving", direction: "lower", unit: "%", excluded: WHY_DOWN },
  { code: "SSB", name: "Service Sire Stillbirth", group: "Calving", direction: "lower", unit: "%", excluded: WHY_DOWN },
  { code: "DSB", name: "Daughter Stillbirth", group: "Calving", direction: "lower", unit: "%", excluded: WHY_DOWN },

  // --- Disease resistance (deviations in % resistant — more is better) -------
  { code: "MAS", name: "Mastitis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "MET", name: "Metritis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "RPL", name: "Retained Placenta resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "KET", name: "Ketosis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "DAB", name: "Displaced Abomasum resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "MFV", name: "Milk Fever resistance", group: "Disease resistance", direction: "higher", unit: "%" },

  // --- Type: overall & udder ------------------------------------------------
  { code: "PTAT", name: "Type (PTAT)", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "FUA", name: "Fore Udder Attachment", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "RUH", name: "Rear Udder Height", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "RUW", name: "Rear Udder Width", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "UCL", name: "Udder Cleft", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "FTP", name: "Front Teat Placement", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "UDP", name: "Udder Depth", group: "Type — overall & udder", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },
  { code: "RTP", name: "Rear Teat Placement", group: "Type — overall & udder", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },
  { code: "TLG", name: "Teat Length", group: "Type — overall & udder", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },

  // --- Type: feet & legs ----------------------------------------------------
  { code: "FLS", name: "Feet & Legs Score", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "FTA", name: "Foot Angle", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "RLR", name: "Rear Legs, Rear View", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "RLS", name: "Rear Legs, Side View", group: "Type — feet & legs", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },

  // --- Type: body -----------------------------------------------------------
  { code: "STR", name: "Strength", group: "Type — body", direction: "higher", unit: null },
  { code: "BDE", name: "Body Depth", group: "Type — body", direction: "higher", unit: null },
  { code: "TRW", name: "Thurl Width", group: "Type — body", direction: "higher", unit: null },
  { code: "RPA", name: "Rump Angle", group: "Type — body", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },
  { code: "STA", name: "Stature", group: "Type — body", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },
  { code: "DFM", name: "Dairy Form", group: "Type — body", direction: "intermediate", unit: null, excluded: WHY_INTERMEDIATE },

  // --- Published, but not identified ---------------------------------------
  { code: "MSP", name: "MSP", group: "Unidentified", direction: "unknown", unit: null, excluded: WHY_UNCONFIRMED },
  { code: "RTS", name: "RTS", group: "Unidentified", direction: "unknown", unit: null, excluded: WHY_UNCONFIRMED },
];

/** The traits a bull can specialise in — every one zero-based and higher-is-better. */
export const US_SPECIALIST_TRAITS = US_SPECIALIST_CATALOG.filter((t) => !t.excluded);

/** The rest, grouped by the reason they are not offered, for the page to explain. */
export function usSpecialistExclusions(): { why: string; traits: UsSpecialistTrait[] }[] {
  const m = new Map<string, UsSpecialistTrait[]>();
  for (const t of US_SPECIALIST_CATALOG) {
    if (!t.excluded) continue;
    const a = m.get(t.excluded) ?? [];
    a.push(t);
    m.set(t.excluded, a);
  }
  return [...m.entries()].map(([why, traits]) => ({ why, traits }));
}

export function usSpecialistTrait(code: string): UsSpecialistTrait | undefined {
  return US_SPECIALIST_CATALOG.find((t) => t.code === code.toUpperCase());
}

/** Keep only codes that are genuinely selectable — a URL can carry anything. */
export function parseUsSpecialistCodes(raw: string | string[] | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : (raw ?? "").split(",")).map((s) => s.trim().toUpperCase());
  return [...new Set(parts)].filter((c) => US_SPECIALIST_TRAITS.some((t) => t.code === c));
}

export type UsSpecialistLevel = "positive" | "solid" | "strong";

/**
 * How high the bar sits, in standard deviations ABOVE ZERO — not above the pool
 * mean. Zero is the CDCB base, a fixed and meaningful point; the pool only
 * supplies the scale, which is what makes one setting comparable across traits
 * measured in pounds, months and score points.
 */
export const US_SPECIALIST_LEVELS: { code: UsSpecialistLevel; label: string; sd: number; hint: string }[] = [
  { code: "positive", label: "Positive", sd: 0, hint: "above the CDCB base — any positive PTA" },
  { code: "solid", label: "Solidly positive", sd: 0.5, hint: "at least half the pool's own spread above the base" },
  { code: "strong", label: "Strong", sd: 1, hint: "a full standard deviation above the base" },
];

export function parseUsSpecialistLevel(v: string | undefined): UsSpecialistLevel {
  return v === "positive" || v === "strong" ? v : "solid";
}

export interface UsSpecialistBar {
  code: string;
  name: string;
  /** The value a bull must reach. Null when nothing in the pool carries the trait. */
  threshold: number | null;
  /** Pool spread for the trait — the unit the bar is expressed in. */
  sd: number | null;
  /** How many bulls in the pool were scored for it. */
  n: number;
}

export interface UsSpecialistRow {
  animalId: string;
  name: string;
  naabCode: string | null;
  evalBreed: string | null;
  roundCode: string | null;
  tpi: number | null;
  tpiFormulaVersion: string | null;
  nmDollar: number | null;
  ptat: number | null;
  milk: number | null;
  rpa: number | null;
  dpr: number | null;
  ccr: number | null;
  /** The picked traits' PTAs. */
  values: Record<string, number>;
  /** Sum of each picked trait's PTA divided by its pool SD — how far clear of the
   *  base he is across the whole set, in a unit every trait shares. */
  zSum: number;
}

export interface UsSpecialistResult {
  rows: UsSpecialistRow[];
  /** Bulls in the pool (official, preferred, approved, breed-filtered). */
  poolN: number;
  /** Of those, how many carried every picked trait and could be judged at all. */
  scoredN: number;
  bars: UsSpecialistBar[];
  /** True when the result list was cut short by `limit`. */
  truncated: boolean;
}

/**
 * Find the bulls that clear the bar on EVERY picked trait.
 *
 * The pool is one official, preferred, approved UsEvaluation per bull. Values come
 * off gptaJson rather than the indexed columns so any published trait works, not
 * just the seven with a column of their own.
 *
 * A bull missing one of the picked traits cannot qualify: CDCB's layout is dense,
 * so an absent value means "not evaluated for it", which is not the same claim as
 * zero and must not be scored as one.
 */
export async function usSpecialists(opts: {
  codes: string[];
  level: UsSpecialistLevel;
  /** CDCB breed code. Each breed sits on its own base, so a mixed pool sets one
   *  bar across several of them — the page says so where the user picks. */
  breed?: string;
  limit?: number;
}): Promise<UsSpecialistResult> {
  const codes = parseUsSpecialistCodes(opts.codes);
  const limit = opts.limit ?? 200;
  const empty: UsSpecialistResult = { rows: [], poolN: 0, scoredN: 0, bars: [], truncated: false };
  if (!codes.length) return empty;

  const where: Prisma.UsEvaluationWhereInput = {
    isPreferred: true,
    approvalStatus: "approved",
    // Only a real CDCB round is authoritative; provisional and unofficial rows
    // are never ranked alongside it.
    runKind: "official",
    ...(opts.breed ? { evalBreed: opts.breed } : {}),
  };

  const evals = await prisma.usEvaluation.findMany({
    where,
    select: {
      animalId: true, evalBreed: true, naabCode: true, roundCode: true,
      tpi: true, tpiFormulaVersion: true, nmDollar: true, ptat: true,
      milk: true, rpa: true, dpr: true, ccr: true, gptaJson: true,
      animal: { select: { primaryName: true } },
    },
  });

  const sdMult = US_SPECIALIST_LEVELS.find((l) => l.code === opts.level)?.sd ?? 0.5;

  // Pass one: pull the picked traits off each bull and collect the pool series.
  const series = new Map<string, number[]>(codes.map((c) => [c, []]));
  const picked: { ev: (typeof evals)[number]; values: Record<string, number> }[] = [];
  for (const ev of evals) {
    const gpta = parseGpta(ev.gptaJson);
    if (!gpta) continue;
    const values: Record<string, number> = {};
    let complete = true;
    for (const code of codes) {
      const v = gpta[code];
      if (typeof v !== "number" || !Number.isFinite(v)) { complete = false; break; }
      values[code] = v;
    }
    if (!complete) continue;
    for (const code of codes) series.get(code)!.push(values[code]);
    picked.push({ ev, values });
  }

  // Pass two: the bar per trait. Population SD of the pool being filtered, so
  // "solid" always means solid relative to the bulls actually in view.
  const bars: UsSpecialistBar[] = codes.map((code) => {
    const xs = series.get(code) ?? [];
    const name = usSpecialistTrait(code)?.name ?? code;
    if (!xs.length) return { code, name, threshold: null, sd: null, n: 0 };
    const mean = xs.reduce((a, v) => a + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length);
    return { code, name, threshold: sdMult * sd, sd, n: xs.length };
  });
  const barOf = new Map(bars.map((b) => [b.code, b]));

  const rows: UsSpecialistRow[] = [];
  for (const { ev, values } of picked) {
    let ok = true;
    let zSum = 0;
    for (const code of codes) {
      const bar = barOf.get(code)!;
      const v = values[code];
      // "Positive" is strictly above the base; the graded levels use the SD bar,
      // which already sits above it. A trait with no spread in the pool (sd 0)
      // falls back to the same strictly-positive test rather than passing everyone.
      const passes = sdMult === 0 || !bar.sd ? v > 0 : bar.threshold != null && v >= bar.threshold;
      if (!passes) { ok = false; break; }
      if (bar.sd) zSum += v / bar.sd;
    }
    if (!ok) continue;
    rows.push({
      animalId: ev.animalId,
      name: ev.animal?.primaryName ?? ev.animalId,
      naabCode: ev.naabCode,
      evalBreed: ev.evalBreed,
      roundCode: ev.roundCode,
      tpi: ev.tpi,
      tpiFormulaVersion: ev.tpiFormulaVersion,
      nmDollar: ev.nmDollar,
      ptat: ev.ptat,
      milk: ev.milk,
      rpa: ev.rpa,
      dpr: ev.dpr,
      ccr: ev.ccr,
      values,
      zSum,
    });
  }

  // Best all-rounder across the picked set first. Ranking on the z-sum rather than
  // on any one trait keeps a bull with a huge Milk figure from out-ranking a bull
  // who is genuinely strong on all of them.
  rows.sort((a, b) => b.zSum - a.zSum);
  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit), poolN: evals.length, scoredN: picked.length, bars, truncated };
}

/** gptaJson is written by persist.ts as a code -> number map. Bad JSON on a single
 *  row must not take the page down, so it is skipped rather than thrown on. */
function parseGpta(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as Record<string, number>) : null;
  } catch {
    return null;
  }
}
