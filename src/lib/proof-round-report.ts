import "server-only";

// ---------------------------------------------------------------------------
// Proof Round Comparison — a breed-level "how the lineup changed between two
// rounds" report, emitted as a self-contained HTML file (see report-html-round).
//
// This is NOT the per-bull Proof Change Report (latest-vs-previous). It ranks the
// whole NAAB Holstein lineup, compares two named rounds a user chooses (e.g.
// December 2025 → April 2026), and produces the EBV (daughter-proven) or PA
// (genomic) variant. Customisable for ANY two rounds on file.
//
// WHAT THE DATA SUPPORTS (measured 2026-08):
// The database holds only the NAAB-coded bulls that were deliberately imported —
// ~135 Holsteins in Dec 2025, ~365 in Apr 2026 — NOT the full Canadian breed of
// thousands. So "Top 1,000" is the whole lineup and the report says so. The
// toggle tiers are ranked by the TO round's standings (the larger set) so that
// "Top 200" is a genuine subset rather than collapsing onto "All Breed"; the
// full Top-100 table is ranked by the FROM round's LPI, exactly as briefed.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import type { Prisma } from "@prisma/client";

/** The five traits this report compares, in display order. */
export const ROUND_TRAITS = [
  { code: "LPI", label: "LPI", col: "lpi" },
  { code: "MILK", label: "Milk", col: "milk" },
  { code: "FAT", label: "Fat", col: "fat" },
  { code: "PROT", label: "Protein", col: "prot" },
  { code: "CONF", label: "Conformation", col: "conf" },
] as const;
export type TraitCode = (typeof ROUND_TRAITS)[number]["code"];

/** One bull's five values in a single round, plus reliability. */
export interface RoundValues {
  lpi: number | null;
  milk: number | null;
  fat: number | null;
  prot: number | null;
  conf: number | null;
  rel: number | null;
  /** "proven" (EBV) or "genomic" (PA) in that round; null if unclassified. */
  sireType: string | null;
}

export interface RoundBull {
  id: string;
  name: string;
  naab: string | null;
  reg: string | null;
  /** Lactanet public profile URL, or null when we cannot build one. */
  profileUrl: string | null;
  from: RoundValues | null;
  to: RoundValues | null;
}

/** A gainer/loser row: one bull, one trait, both round values + the change. */
export interface MoveRow {
  id: string;
  name: string;
  naab: string | null;
  profileUrl: string | null;
  from: number | null;
  to: number | null;
  change: number;
}

/** Average change of the five traits over one tier, split by ranking axis. */
export interface TierAverages {
  /** How many bulls in the tier had BOTH rounds (so a change existed). */
  n: number;
  /** How many bulls were in the ranked tier at all (population). */
  population: number;
  lpi: number | null;
  milk: number | null;
  fat: number | null;
  prot: number | null;
  conf: number | null;
}

export interface TierBlock {
  key: "all" | "top1000" | "top200";
  label: string;
  /** Population ranked by LPI, and the average change over it. */
  byLpi: TierAverages;
  /** Population ranked by Conformation, and the average change over it. */
  byConf: TierAverages;
  lpiGainers: MoveRow[];
  lpiLosers: MoveRow[];
  confGainers: MoveRow[];
  confLosers: MoveRow[];
}

/** A row of the full Top-100 table. */
export interface FullRow {
  rank: number;
  id: string;
  name: string;
  naab: string | null;
  profileUrl: string | null;
  from: RoundValues; // always present (ranked among from-round bulls)
  to: RoundValues | null; // null ⇒ "not in <to> round"
}

/** A newcomer row (PA→EBV): only the values that section shows. */
export interface NewcomerRow {
  id: string;
  name: string;
  naab: string | null;
  profileUrl: string | null;
  lpi: number | null;
  milk: number | null;
  fat: number | null;
  prot: number | null;
  conf: number | null;
  rel: number | null;
}

export type RoundReportType = "ebv" | "pa";

export interface RoundReport {
  type: RoundReportType;
  fromRun: string;
  toRun: string;
  /** Titles exactly as briefed. */
  title: string;
  subtitle: string;
  /** NAAB Holstein bulls present in each round (for the population note). */
  fromCount: number;
  toCount: number;
  /** The comparison universe — NAAB HO bulls in either round. */
  universe: number;
  /** Tier of the toggle, always three, ranked by the TO round's standings. */
  tiers: TierBlock[];
  /** The full type-scoped table, ranked by the FROM round's LPI. */
  full: FullRow[];
  /** How many bulls the full table would ideally hold (100) vs how many exist. */
  fullCap: number;
  fullAvailable: number;
  // --- EBV report only ------------------------------------------------------
  /** PA-in-from → EBV-in-to, ranked by TO LPI / TO Conf (top 10 each). */
  newcomersByLpi: NewcomerRow[];
  newcomersByConf: NewcomerRow[];
  /** Same set, their PA→EBV move on LPI and Conformation (gains & drops). */
  newProvenLpiGains: MoveRow[];
  newProvenLpiDrops: MoveRow[];
  newProvenConfGains: MoveRow[];
  newProvenConfDrops: MoveRow[];
  generatedAt: string;
}

// --- helpers ----------------------------------------------------------------

const TOP_N_TIERS: { key: "all" | "top1000" | "top200"; label: string; n: number }[] = [
  { key: "all", label: "All Breed", n: Infinity },
  { key: "top1000", label: "Top 1,000", n: 1000 },
  { key: "top200", label: "Top 200", n: 200 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** Rank a bull by the axis, preferring his TO value (current standing), else FROM. */
function rankValue(b: RoundBull, axis: "lpi" | "conf"): number | null {
  return b.to?.[axis] ?? b.from?.[axis] ?? null;
}

/** The five-trait average change over a set of bulls that have BOTH rounds. */
function averagesOver(bulls: RoundBull[]): TierAverages {
  const both = bulls.filter((b) => b.from && b.to);
  const avg = (k: "lpi" | "milk" | "fat" | "prot" | "conf") => {
    const ds: number[] = [];
    for (const b of both) {
      const f = b.from![k], t = b.to![k];
      if (f != null && t != null) ds.push(t - f);
    }
    const m = mean(ds);
    return m == null ? null : round2(m);
  };
  return { n: both.length, population: bulls.length, lpi: avg("lpi"), milk: avg("milk"), fat: avg("fat"), prot: avg("prot"), conf: avg("conf") };
}

/** Top/bottom movers within a set, on one trait. */
function movers(bulls: RoundBull[], key: "lpi" | "conf", limit = 10): { gainers: MoveRow[]; losers: MoveRow[] } {
  const rows: MoveRow[] = [];
  for (const b of bulls) {
    const f = b.from?.[key], t = b.to?.[key];
    if (f == null || t == null) continue;
    rows.push({ id: b.id, name: b.name, naab: b.naab, profileUrl: b.profileUrl, from: f, to: t, change: round2(t - f) });
  }
  const byChange = [...rows].sort((a, b) => b.change - a.change);
  const gainers = byChange.filter((r) => r.change > 0).slice(0, limit);
  const losers = [...byChange].reverse().filter((r) => r.change < 0).slice(0, limit);
  return { gainers, losers };
}

/** A Lactanet public profile URL from a Canadian-style registration. */
function profileUrlOf(reg: string | null): string | null {
  if (!reg) return null;
  const m = /^([A-Z]{2})([A-Z0-9]{3})([MF])(\d+)$/.exec(reg.toUpperCase());
  if (!m) return null;
  const q = new URLSearchParams({ breed: m[1], country: m[2], sex: m[3], regnum: m[4] });
  return `https://www.lactanetgen.ca/query/summary.php?${q}`;
}

// --- the report -------------------------------------------------------------

interface EvalRow {
  animalId: string;
  proofRun: string | null;
  runKind: string | null;
  lpi: number | null; milk: number | null; fat: number | null; prot: number | null; conf: number | null;
  reliabilityOverall: number | null;
  sireType: string | null;
  animal: {
    primaryName: string;
    identifiers: { idType: string; idValue: string; isPrimary: boolean }[];
  };
}

/** Prefer the official file over the interim one for the same bull in a round. */
function pickCanonical(rows: EvalRow[]): EvalRow {
  return rows.reduce((best, r) => {
    const rank = (k: string | null) => (k === "official" ? 0 : k === "interim" ? 1 : 2);
    return rank(r.runKind) < rank(best.runKind) ? r : best;
  });
}

const valuesOf = (r: EvalRow): RoundValues => ({
  lpi: r.lpi, milk: r.milk, fat: r.fat, prot: r.prot, conf: r.conf,
  rel: r.reliabilityOverall, sireType: r.sireType,
});

export async function getRoundReport(opts: {
  fromRun: string;
  toRun: string;
  type: RoundReportType;
}): Promise<RoundReport> {
  const { fromRun, toRun, type } = opts;
  const generatedAt = new Date().toISOString();

  const rows = (await prisma.geneticEvaluation.findMany({
    where: {
      proofRun: { in: [fromRun, toRun] },
      animal: { archived: false, breed: { breedCode: "HO" }, identifiers: { some: { active: true, idType: "naab" } } },
    },
    select: {
      animalId: true, proofRun: true, runKind: true,
      lpi: true, milk: true, fat: true, prot: true, conf: true,
      reliabilityOverall: true, sireType: true,
      animal: { select: { primaryName: true, identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } } } },
    },
  })) as EvalRow[];

  // Group per bull, then per round (dedup official/interim within a round).
  const byBull = new Map<string, { from?: EvalRow[]; to?: EvalRow[]; animal: EvalRow["animal"] }>();
  for (const r of rows) {
    let e = byBull.get(r.animalId);
    if (!e) { e = { animal: r.animal }; byBull.set(r.animalId, e); }
    if (r.proofRun === fromRun) (e.from ??= []).push(r);
    if (r.proofRun === toRun) (e.to ??= []).push(r);
  }

  const bulls: RoundBull[] = [];
  for (const [id, e] of byBull) {
    const naab = e.animal.identifiers.find((i) => i.idType === "naab")?.idValue ?? null;
    const reg =
      e.animal.identifiers.find((i) => i.isPrimary && i.idType !== "naab")?.idValue ??
      e.animal.identifiers.find((i) => i.idType !== "naab")?.idValue ?? null;
    bulls.push({
      id, name: e.animal.primaryName, naab, reg, profileUrl: profileUrlOf(reg),
      from: e.from?.length ? valuesOf(pickCanonical(e.from)) : null,
      to: e.to?.length ? valuesOf(pickCanonical(e.to)) : null,
    });
  }

  const fromCount = bulls.filter((b) => b.from).length;
  const toCount = bulls.filter((b) => b.to).length;

  // --- toggle tiers, ranked by TO-round standings (the larger set) ----------
  const rankedByLpi = [...bulls].filter((b) => rankValue(b, "lpi") != null).sort((a, b) => rankValue(b, "lpi")! - rankValue(a, "lpi")!);
  const rankedByConf = [...bulls].filter((b) => rankValue(b, "conf") != null).sort((a, b) => rankValue(b, "conf")! - rankValue(a, "conf")!);

  const tiers: TierBlock[] = TOP_N_TIERS.map((t) => {
    const lpiPop = rankedByLpi.slice(0, t.n === Infinity ? rankedByLpi.length : t.n);
    const confPop = rankedByConf.slice(0, t.n === Infinity ? rankedByConf.length : t.n);
    const lpiMoves = movers(lpiPop, "lpi");
    const confMoves = movers(confPop, "conf");
    return {
      key: t.key, label: t.label,
      byLpi: averagesOver(lpiPop),
      byConf: averagesOver(confPop),
      lpiGainers: lpiMoves.gainers, lpiLosers: lpiMoves.losers,
      confGainers: confMoves.gainers, confLosers: confMoves.losers,
    };
  });

  // --- full Top-100 table, type-scoped, ranked by FROM-round LPI ------------
  const isType = (v: RoundValues | null): boolean =>
    !!v && (type === "ebv" ? v.sireType === "proven" : v.sireType === "genomic");
  const fullPool = bulls
    .filter((b) => b.from && isType(b.from) && b.from.lpi != null)
    .sort((a, b) => b.from!.lpi! - a.from!.lpi!);
  const fullAvailable = fullPool.length;
  const full: FullRow[] = fullPool.slice(0, 100).map((b, i) => ({
    rank: i + 1, id: b.id, name: b.name, naab: b.naab, profileUrl: b.profileUrl,
    from: b.from!, to: b.to,
  }));

  // --- EBV-only: newly proven (PA in from → EBV in to) ----------------------
  let newcomersByLpi: NewcomerRow[] = [], newcomersByConf: NewcomerRow[] = [];
  let newProvenLpiGains: MoveRow[] = [], newProvenLpiDrops: MoveRow[] = [];
  let newProvenConfGains: MoveRow[] = [], newProvenConfDrops: MoveRow[] = [];
  if (type === "ebv") {
    const newcomers = bulls.filter((b) => b.from?.sireType === "genomic" && b.to?.sireType === "proven");
    const toNewcomer = (b: RoundBull): NewcomerRow => ({
      id: b.id, name: b.name, naab: b.naab, profileUrl: b.profileUrl,
      lpi: b.to!.lpi, milk: b.to!.milk, fat: b.to!.fat, prot: b.to!.prot, conf: b.to!.conf, rel: b.to!.rel,
    });
    newcomersByLpi = [...newcomers].filter((b) => b.to!.lpi != null).sort((a, b) => b.to!.lpi! - a.to!.lpi!).slice(0, 10).map(toNewcomer);
    newcomersByConf = [...newcomers].filter((b) => b.to!.conf != null).sort((a, b) => b.to!.conf! - a.to!.conf!).slice(0, 10).map(toNewcomer);
    const lm = movers(newcomers, "lpi");
    const cm = movers(newcomers, "conf");
    newProvenLpiGains = lm.gainers; newProvenLpiDrops = lm.losers;
    newProvenConfGains = cm.gainers; newProvenConfDrops = cm.losers;
  }

  const title = type === "ebv"
    ? `Top ${Math.min(100, fullAvailable)} Canadian Daughter-Proven (EBV) Bulls — ${fromRun} vs ${toRun}`
    : `Top ${Math.min(100, fullAvailable)} PA Bulls (Genomic) — ${fromRun} vs ${toRun}`;
  const subtitle = `How the Holstein lineup moved between ${fromRun} and ${toRun}. ${
    type === "ebv" ? "Daughter-proven (EBV)" : "Genomic (PA)"
  } bulls with a NAAB stud code.`;

  return {
    type, fromRun, toRun, title, subtitle,
    fromCount, toCount, universe: bulls.length,
    tiers, full, fullCap: 100, fullAvailable,
    newcomersByLpi, newcomersByConf,
    newProvenLpiGains, newProvenLpiDrops, newProvenConfGains, newProvenConfDrops,
    generatedAt,
  };
}

/** The rounds available to compare, newest first — for the picker form. */
export async function listProofRuns(): Promise<string[]> {
  const rows = await prisma.geneticEvaluation.findMany({
    where: { proofRun: { not: null }, animal: { archived: false, breed: { breedCode: "HO" }, identifiers: { some: { active: true, idType: "naab" } } } },
    select: { proofRun: true, evaluationDate: true },
    distinct: ["proofRun"],
    orderBy: { evaluationDate: "desc" },
  } satisfies Prisma.GeneticEvaluationFindManyArgs);
  return rows.map((r) => r.proofRun!).filter(Boolean);
}
