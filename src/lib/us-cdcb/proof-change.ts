// ---------------------------------------------------------------------------
// US Proof Change Report — how each bull moved between two CDCB rounds.
//
// The American mirror of src/lib/proof-change.ts, and deliberately NOT a port of
// it. Three things differ at the root:
//
//   * ROUND SELECTION IS TRIVIAL HERE. CDCB ships one file per triannual round,
//     so every round is official — there is no official/interim pair to prefer
//     between, and none of Canada's canonicalByPeriod tie-breaking is needed.
//     Rows with runKind 'provisional' (monthly add) or 'unofficial' (weekly add)
//     are never a round and are excluded outright.
//   * THE TWO ROUNDS ARE PICKED ONCE FOR THE WHOLE REPORT, not per bull. Canada
//     diffs each bull against its own previous official proof, which is fine for
//     a lineup of a few hundred NAAB bulls. Here significance is cohort-relative
//     (a z-score against how the cohort moved), and a cohort mean is meaningless
//     if the bulls in it were measured over different round pairs. So every bull
//     in the report is compared over the same two rounds, and bulls missing
//     either round are reported as not comparable rather than quietly diffed
//     over some other interval.
//   * GRADUATIONS ARE HELD OUT OF THE STATISTICS. A bull moving from genomic to
//     daughter-proven moves roughly 6x a normal round. That is expected biology,
//     not an anomaly; leaving graduates in the cohort would inflate the SD and
//     bury the real movers. Their deltas are shown, and they are counted, but
//     they never contribute to a mean/SD and are never flagged as unusual.
//
// RUMP ANGLE IS NEVER JUDGED. It has an intermediate optimum, so "moved up" is
// not "moved better". Its delta is shown; `favourable` is null for it and it is
// excluded from every ranking, summary and sort option.
//
// GTPI IS CALCULATED, NOT PUBLISHED — see index-registry.ts. Its delta is a whole
// number because the calculation is only good to about ±3 points; a decimal would
// claim precision the figure does not have.
// ---------------------------------------------------------------------------

import { prisma } from "../db";
import { US_KEY_TRAIT_CODES, type TraitDirection } from "./key-traits";

/** The indexed UsEvaluation columns this report can diff. */
export type UsChangeColumn =
  | "tpi" | "nmDollar" | "cmDollar" | "fmDollar" | "gmDollar"
  | "milk" | "fat" | "pro" | "fatPct" | "proPct"
  | "pl" | "scs" | "dpr" | "ccr" | "liv"
  | "ptat" | "rpa" | "udc" | "flc";

export interface UsChangeTrait {
  code: string;
  label: string;
  /** Short label for dense table headers. */
  short: string;
  group: "index" | "production" | "health" | "type";
  direction: TraitDirection;
  decimals: number;
  /** One of the seven US key traits — only these decide "significant". */
  key: boolean;
  /** Computed by this app rather than published by CDCB. */
  computed: boolean;
  /** Where the value is read from on a UsEvaluation row. */
  column: UsChangeColumn;
}

/**
 * The traits diffed, in display order: the seven key traits first, then the
 * other main figures.
 *
 * Values come from the indexed columns rather than by re-parsing gptaJson for
 * every row. persist.ts writes those columns FROM gptaJson, so they are the same
 * numbers — but a report over two rounds touches tens of thousands of rows, and
 * pulling a JSON blob for each would move tens of megabytes to compute a handful
 * of deltas. `usTraitsFromGpta` is exported for callers that already hold the
 * JSON (a single-bull view), so the diff engine works either way.
 *
 * UDC and FLC are composites this app derives while computing TPI, so like GTPI
 * they live only on their columns — CDCB publishes the linear traits, not the
 * composite.
 */
export const US_CHANGE_TRAITS: UsChangeTrait[] = [
  { code: "GTPI",   label: "GTPI (calculated)",        short: "GTPI",  group: "index",      direction: "higher",       decimals: 0, key: true,  computed: true,  column: "tpi" },
  { code: "NM",     label: "Net Merit",                short: "NM$",   group: "index",      direction: "higher",       decimals: 0, key: true,  computed: false, column: "nmDollar" },
  { code: "PTAT",   label: "Type (PTAT)",              short: "PTAT",  group: "type",       direction: "higher",       decimals: 2, key: true,  computed: false, column: "ptat" },
  { code: "MILK",   label: "Milk (lb)",                short: "Milk",  group: "production", direction: "higher",       decimals: 0, key: true,  computed: false, column: "milk" },
  { code: "RPA",    label: "Rump Angle",               short: "Rump",  group: "type",       direction: "intermediate", decimals: 2, key: true,  computed: false, column: "rpa" },
  { code: "DPR",    label: "Daughter Pregnancy Rate",  short: "DPR",   group: "health",     direction: "higher",       decimals: 1, key: true,  computed: false, column: "dpr" },
  { code: "CCR",    label: "Cow Conception Rate",      short: "CCR",   group: "health",     direction: "higher",       decimals: 1, key: true,  computed: false, column: "ccr" },

  { code: "CM",     label: "Cheese Merit",             short: "CM$",   group: "index",      direction: "higher",       decimals: 0, key: false, computed: false, column: "cmDollar" },
  { code: "FM",     label: "Fluid Merit",              short: "FM$",   group: "index",      direction: "higher",       decimals: 0, key: false, computed: false, column: "fmDollar" },
  { code: "GM",     label: "Grazing Merit",            short: "GM$",   group: "index",      direction: "higher",       decimals: 0, key: false, computed: false, column: "gmDollar" },
  { code: "FAT",    label: "Fat (lb)",                 short: "Fat",   group: "production", direction: "higher",       decimals: 0, key: false, computed: false, column: "fat" },
  { code: "PRO",    label: "Protein (lb)",             short: "Prot",  group: "production", direction: "higher",       decimals: 0, key: false, computed: false, column: "pro" },
  { code: "FATPCT", label: "Fat %",                    short: "Fat%",  group: "production", direction: "higher",       decimals: 2, key: false, computed: false, column: "fatPct" },
  { code: "PROPCT", label: "Protein %",                short: "Prot%", group: "production", direction: "higher",       decimals: 2, key: false, computed: false, column: "proPct" },
  { code: "PL",     label: "Productive Life",          short: "PL",    group: "health",     direction: "higher",       decimals: 1, key: false, computed: false, column: "pl" },
  // The one lower-is-better trait in the set: a falling somatic cell score is an
  // improvement, so its favourable direction is inverted, not its delta.
  { code: "SCS",    label: "Somatic Cell Score",       short: "SCS",   group: "health",     direction: "lower",        decimals: 2, key: false, computed: false, column: "scs" },
  { code: "LIV",    label: "Livability",               short: "LIV",   group: "health",     direction: "higher",       decimals: 1, key: false, computed: false, column: "liv" },
  { code: "UDC",    label: "Udder Composite",          short: "UDC",   group: "type",       direction: "higher",       decimals: 2, key: false, computed: true,  column: "udc" },
  { code: "FLC",    label: "Feet & Legs Composite",    short: "FLC",   group: "type",       direction: "higher",       decimals: 2, key: false, computed: true,  column: "flc" },
];

export const US_CHANGE_KEY_TRAITS = US_CHANGE_TRAITS.filter((t) => t.key);
/** Traits that may be ranked or sorted on. Excludes intermediate optima. */
export const US_RANKABLE_CHANGE_TRAITS = US_CHANGE_TRAITS.filter((t) => t.direction !== "intermediate");

export const SD_LEVELS = [0.5, 1, 1.5] as const;
export const SD_DEFAULT = 1;
export function sdFromParam(v: string | undefined): number {
  return v === "0.5" ? 0.5 : v === "1.5" ? 1.5 : SD_DEFAULT;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2604" -> "April 2026". Triannual round codes are YYMM. */
export function usRoundLabel(roundCode: string | null | undefined): string {
  const c = (roundCode ?? "").trim();
  if (!/^\d{4}$/.test(c)) return c || "—";
  const month = Number(c.slice(2, 4));
  const name = MONTHS[month - 1] ?? c.slice(2, 4);
  return `${name} 20${c.slice(0, 2)}`;
}

/** A trait code -> value map, the unit the diff engine works in. */
export type UsTraitMap = Record<string, number | null>;

/** Shape of the columns the report reads. Kept structural so tests can pass literals. */
export type UsColumnRow = { [K in UsChangeColumn]?: number | null };

/** Build a trait map from a UsEvaluation row's indexed columns. */
export function usTraitsFromColumns(row: UsColumnRow): UsTraitMap {
  const out: UsTraitMap = {};
  for (const t of US_CHANGE_TRAITS) out[t.code] = row[t.column] ?? null;
  return out;
}

/**
 * Build the same map from a stored gptaJson blob, for callers that already have
 * it. `computed` carries the values CDCB does not publish (GTPI, UDC, FLC) —
 * without them those traits are simply absent rather than silently zero.
 */
export function usTraitsFromGpta(
  gptaJson: string | null | undefined,
  computed: { GTPI?: number | null; UDC?: number | null; FLC?: number | null } = {},
): UsTraitMap {
  let gpta: Record<string, unknown> = {};
  try {
    if (gptaJson) gpta = JSON.parse(gptaJson) as Record<string, unknown>;
  } catch {
    gpta = {};
  }
  const out: UsTraitMap = {};
  for (const t of US_CHANGE_TRAITS) {
    if (t.computed) {
      out[t.code] = computed[t.code as "GTPI" | "UDC" | "FLC"] ?? null;
      continue;
    }
    const v = gpta[t.code];
    out[t.code] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

export interface UsTraitChange {
  code: string;
  label: string;
  short: string;
  key: boolean;
  computed: boolean;
  direction: TraitDirection;
  decimals: number;
  previous: number | null;
  latest: number | null;
  /** latest − previous. Whole numbers for GTPI; the calc is only ±3 points good. */
  delta: number | null;
  /**
   * Did the bull move the RIGHT way? null for intermediate-optimum traits, where
   * the question has no answer from the delta alone — rump angle moving up is not
   * rump angle improving.
   */
  favourable: boolean | null;
  /** (delta − cohort mean) / cohort SD. null when the cohort cannot support one. */
  z: number | null;
  /**
   * |z| >= sensitivity. Never set on a graduating bull.
   *
   * An intermediate-optimum trait CAN be flagged, and that is intentional: "this
   * bull's rump angle moved much further than the cohort's did" is a statement
   * about size, not direction, and is worth surfacing. What must never happen is
   * calling that move good or bad, or ordering bulls by it — hence `favourable`
   * stays null and the trait is absent from every sort option.
   */
  flagged: boolean;
}

export interface UsBullChange {
  changes: UsTraitChange[];
  keyChanges: UsTraitChange[];
  otherFlagged: UsTraitChange[];
  flaggedCount: number;
  /** Flagged among the key traits — this is what "significant" means. */
  keyFlaggedCount: number;
  tpiDelta: number | null;
  summary: string;
}

/** One bull's diff before the cohort's spread is known. */
export interface UsRawChange {
  changes: UsTraitChange[];
  /** True when the later round is this bull's first daughter-proven one. */
  graduated: boolean;
}

/**
 * Diff one bull across two trait maps. Pure — no database, no cohort.
 *
 * `graduated` only travels through so the cohort step can hold the row out of the
 * statistics; it does not change any delta.
 */
export function computeUsRawChange(previous: UsTraitMap, latest: UsTraitMap, graduated = false): UsRawChange {
  const changes: UsTraitChange[] = US_CHANGE_TRAITS.map((t) => {
    const prev = previous[t.code] ?? null;
    const lat = latest[t.code] ?? null;
    const raw = prev != null && lat != null ? lat - prev : null;
    // GTPI is reported whole: the formula reproduces the published figure to
    // about ±3 points, so "+7.42" would dress up an approximation as precision.
    const delta = raw == null ? null : t.code === "GTPI" ? Math.round(raw) : round2(raw);
    const favourable =
      delta == null || delta === 0 || t.direction === "intermediate"
        ? null
        : t.direction === "lower" ? delta < 0 : delta > 0;
    return {
      code: t.code, label: t.label, short: t.short, key: t.key, computed: t.computed,
      direction: t.direction, decimals: t.decimals,
      previous: prev, latest: lat, delta, favourable, z: null, flagged: false,
    };
  });
  return { changes, graduated };
}

/** Population mean and SD of one trait's deltas across the cohort. */
export function usDeltaStats(deltas: number[]): { mean: number; sd: number; n: number } {
  const n = deltas.length;
  if (n < 2) return { mean: deltas[0] ?? 0, sd: 0, n };
  const mean = deltas.reduce((s, d) => s + d, 0) / n;
  const variance = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

/** At least this many comparable bulls per trait before a spread means anything. */
export const MIN_COHORT = 3;

/**
 * Score every bull against the cohort's own movement.
 *
 * The cohort is the NON-GRADUATING bulls only. Graduates keep their deltas but
 * contribute nothing to the mean or SD and are never flagged — a bull moving from
 * a parent average to a daughter proof moves about six times a normal round, so
 * including him would raise the bar for everyone else and hide the real movers.
 */
export function finalizeUsCohort(raws: UsRawChange[], sdMult: number): UsBullChange[] {
  const byTrait = new Map<string, number[]>();
  for (const r of raws) {
    if (r.graduated) continue;
    for (const c of r.changes) {
      if (c.delta == null) continue;
      const arr = byTrait.get(c.code);
      if (arr) arr.push(c.delta); else byTrait.set(c.code, [c.delta]);
    }
  }
  const stats = new Map<string, { mean: number; sd: number; n: number }>();
  for (const [code, ds] of byTrait) stats.set(code, usDeltaStats(ds));
  return raws.map((r) => finalizeUsBull(r, stats, sdMult));
}

function finalizeUsBull(raw: UsRawChange, stats: Map<string, { mean: number; sd: number; n: number }>, sdMult: number): UsBullChange {
  const changes = raw.changes.map((c) => {
    const s = stats.get(c.code);
    let z: number | null = null;
    let flagged = false;
    if (c.delta != null && s && s.n >= MIN_COHORT && s.sd > 0) {
      z = Math.round(((c.delta - s.mean) / s.sd) * 100) / 100;
      // A graduate is measured against the cohort for context, but never called
      // unusual — his movement is expected, and saying otherwise would be wrong.
      flagged = !raw.graduated && Math.abs(z) >= sdMult - 1e-9;
    }
    return { ...c, z, flagged };
  });
  const keyChanges = changes.filter((c) => c.key);
  return {
    changes,
    keyChanges,
    otherFlagged: changes.filter((c) => !c.key && c.flagged).sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0)),
    flaggedCount: changes.filter((c) => c.flagged).length,
    keyFlaggedCount: keyChanges.filter((c) => c.flagged).length,
    tpiDelta: changes.find((c) => c.code === "GTPI")?.delta ?? null,
    summary: buildSummary(changes, raw.graduated, sdMult),
  };
}

/** A short "what moved" line. Rump angle is left out — it cannot be ranked. */
function buildSummary(changes: UsTraitChange[], graduated: boolean, sdMult: number): string {
  const moved = changes
    .filter((c) => c.key && c.direction !== "intermediate" && c.delta != null && c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 3)
    .map((c) => `${c.short} ${c.delta! > 0 ? "+" : ""}${c.delta!.toFixed(c.decimals)}`);
  const parts: string[] = [];
  if (moved.length) parts.push(moved.join(", "));
  const keyFlags = changes.filter((c) => c.key && c.flagged).length;
  if (keyFlags) parts.push(`${keyFlags} key trait${keyFlags === 1 ? "" : "s"} moved ≥${sdMult} SD`);
  if (graduated) parts.push("first daughter proof");
  return parts.join(" · ") || "No change";
}

// --- The report ------------------------------------------------------------

export interface UsRoundOption {
  roundCode: string;
  label: string;
  /** Evaluations in this round — how much of the population it covers. */
  rows: number;
}

export interface UsProofChangeRow {
  animalId: string;
  name: string;
  shortName: string | null;
  id17: string;
  naab: string | null;
  breed: string | null;
  graduated: boolean;
  /** Which TPI formula version produced the later round's GTPI. */
  tpiFormulaVersion: string | null;
  change: UsBullChange;
}

/** How graduating bulls are treated in the row list. They are never in the stats. */
export type GradMode = "show" | "only" | "hide";

export interface UsProofChangeReport {
  /** True when the US tables have not been created yet (importer not run). */
  missingTables: boolean;
  /** True when fewer than two official rounds exist — nothing to compare. */
  notEnoughRounds: boolean;

  rounds: UsRoundOption[];
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;

  rows: UsProofChangeRow[];
  /** Rows shown after the display cap; `compared` is the full comparable set. */
  shown: number;
  compared: number;
  /** In the later round but missing the earlier one — nothing to diff against. */
  notComparable: number;
  significantCount: number;
  graduationCount: number;

  breeds: string[];
  q: string;
  breed: string;
  sort: string;
  dir: "asc" | "desc";
  sdMult: number;
  significantOnly: boolean;
  grads: GradMode;

  /**
   * WHICH COHORT DEFINES SIGNIFICANCE. The flag is a z-score against how the
   * cohort itself moved, so it is only meaningful next to a stated peer group —
   * and the breed filter re-bases that group rather than merely hiding rows. The
   * page must print this, not imply it.
   */
  cohortLabel: string;
  cohortN: number;
  cohortTooSmall: boolean;
}

/** Rows rendered. Statistics always run over the whole cohort, cap or no cap. */
export const MAX_ROWS = 200;

const SORTABLE = new Set<string>([
  "flags", "name",
  ...US_RANKABLE_CHANGE_TRAITS.filter((t) => t.key).map((t) => t.code.toLowerCase()),
]);

/** True when a Prisma error means the US tables have not been created yet. */
export function isMissingUsTables(e: unknown): boolean {
  return /does not exist|relation .* does not exist|P2021/i.test(String((e as Error)?.message));
}

/**
 * Build the report from URL params.
 *
 * Only runKind 'official' rows take part. Provisional monthly and unofficial
 * weekly adds exist in the same table but are not rounds, and ranking a weekly
 * add alongside a published round would compare a draft with a publication.
 */
export async function getUsProofChangeReport(sp: Record<string, string | undefined>): Promise<UsProofChangeReport> {
  const sdMult = sdFromParam(sp.sd);
  const q = (sp.q ?? "").trim();
  const breed = (sp.breed ?? "").trim().toUpperCase();
  const significantOnly = sp.significant === "1";
  const grads: GradMode = sp.grads === "only" ? "only" : sp.grads === "hide" ? "hide" : "show";
  const sort = SORTABLE.has((sp.sort ?? "").toLowerCase()) ? (sp.sort as string).toLowerCase() : "gtpi";
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";

  const base: UsProofChangeReport = {
    missingTables: false, notEnoughRounds: false,
    rounds: [], from: "", to: "", fromLabel: "—", toLabel: "—",
    rows: [], shown: 0, compared: 0, notComparable: 0, significantCount: 0, graduationCount: 0,
    breeds: [], q, breed, sort, dir, sdMult, significantOnly, grads,
    cohortLabel: "the compared bulls", cohortN: 0, cohortTooSmall: false,
  };

  let rounds: UsRoundOption[];
  try {
    const agg = await prisma.usEvaluation.groupBy({
      by: ["roundCode"],
      where: { runKind: "official", approvalStatus: "approved", NOT: { roundCode: null } },
      _count: { _all: true },
    });
    rounds = agg
      .filter((r): r is typeof r & { roundCode: string } => !!r.roundCode)
      .map((r) => ({ roundCode: r.roundCode, label: usRoundLabel(r.roundCode), rows: r._count._all }))
      // YYMM sorts lexicographically in chronological order, newest first.
      .sort((a, b) => b.roundCode.localeCompare(a.roundCode));
  } catch (e) {
    if (isMissingUsTables(e)) return { ...base, missingTables: true };
    throw e;
  }

  if (rounds.length < 2) return { ...base, rounds, notEnoughRounds: true };

  const valid = new Set(rounds.map((r) => r.roundCode));
  const to = valid.has(sp.to ?? "") ? (sp.to as string) : rounds[0].roundCode;
  // The round immediately before the later one, so "auto" always means
  // consecutive rounds rather than whatever happens to be newest.
  const fallbackFrom = rounds.find((r) => r.roundCode < to)?.roundCode ?? rounds[1].roundCode;
  const pinnedFrom = valid.has(sp.from ?? "") ? (sp.from as string) : "";
  const from = pinnedFrom && pinnedFrom < to ? pinnedFrom : fallbackFrom;

  const evals = await prisma.usEvaluation.findMany({
    where: {
      runKind: "official",
      approvalStatus: "approved",
      roundCode: { in: [from, to] },
      // The breed filter is applied in SQL because it re-bases the cohort, not
      // just the row list: "unusual for a Holstein" is a different question from
      // "unusual for the whole book". The text search is applied afterwards, as
      // searching for a bull must not move the bar he is measured against.
      ...(breed ? { evalBreed: breed } : {}),
    },
    select: {
      usAnimalId: true, id17: true, roundCode: true, evalBreed: true, naabCode: true,
      isGraduation: true, tpiFormulaVersion: true,
      tpi: true, nmDollar: true, cmDollar: true, fmDollar: true, gmDollar: true,
      milk: true, fat: true, pro: true, fatPct: true, proPct: true,
      pl: true, scs: true, dpr: true, ccr: true, liv: true,
      ptat: true, rpa: true, udc: true, flc: true,
      usAnimal: { select: { name: true } },
    },
  });

  type EvalRow = (typeof evals)[number];
  const paired = new Map<string, { prev?: EvalRow; latest?: EvalRow }>();
  for (const e of evals) {
    const slot = paired.get(e.usAnimalId) ?? {};
    if (e.roundCode === to) slot.latest = e; else slot.prev = e;
    paired.set(e.usAnimalId, slot);
  }

  // Identity is collected in lock-step with the raw diffs: the cohort scoring runs
  // over the diffs alone, and the two are zipped back together after.
  const identities: Omit<UsProofChangeRow, "change">[] = [];
  const raws: UsRawChange[] = [];
  let notComparable = 0;
  for (const [usAnimalId, { prev, latest }] of paired) {
    if (!latest) continue;              // not in the later round at all
    if (!prev) { notComparable++; continue; }
    const raw = computeUsRawChange(usTraitsFromColumns(prev), usTraitsFromColumns(latest), latest.isGraduation);
    raws.push(raw);
    identities.push({
      animalId: usAnimalId,
      name: latest.usAnimal?.name ?? latest.id17,
      shortName: null,
      id17: latest.id17,
      naab: latest.naabCode,
      breed: latest.evalBreed,
      graduated: latest.isGraduation,
      tpiFormulaVersion: latest.tpiFormulaVersion,
    });
  }

  const finalized = finalizeUsCohort(raws, sdMult);
  const compared = identities.map((r, i) => ({ ...r, change: finalized[i] }));

  const breeds = [...new Set(compared.map((r) => r.breed).filter((b): b is string => !!b))].sort();
  const graduationCount = compared.filter((r) => r.graduated).length;
  const significantCount = compared.filter((r) => r.change.keyFlaggedCount > 0).length;
  // Only the non-graduates carry the statistics, so that is the number to report
  // when warning that the cohort is too thin to flag anything.
  const cohortN = compared.length - graduationCount;

  let rows = compared;
  if (grads === "only") rows = rows.filter((r) => r.graduated);
  else if (grads === "hide") rows = rows.filter((r) => !r.graduated);
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter((r) =>
      r.name.toLowerCase().includes(ql) ||
      (r.shortName ?? "").toLowerCase().includes(ql) ||
      (r.naab ?? "").toLowerCase().includes(ql) ||
      r.id17.toLowerCase().includes(ql));
  }
  if (significantOnly) rows = rows.filter((r) => r.change.keyFlaggedCount > 0);

  if (sort === "name") {
    rows = [...rows].sort((a, b) => a.name.localeCompare(b.name) * (dir === "asc" ? 1 : -1));
  } else {
    // Movement is ranked on magnitude — the question is "who moved most", and a
    // bull who dropped 60 GTPI moved as much as one who gained 60.
    const val = (r: UsProofChangeRow): number | null => {
      if (sort === "flags") return r.change.keyFlaggedCount;
      const d = r.change.changes.find((c) => c.code === sort.toUpperCase())?.delta ?? null;
      return d == null ? null : Math.abs(d);
    };
    rows = [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "asc" ? av - bv : bv - av;
    });
  }

  const shownRows = rows.slice(0, MAX_ROWS);
  const cohortLabel = breed
    ? `the ${breed} bulls in both rounds`
    : "all bulls evaluated in both rounds";

  return {
    ...base,
    rounds, from, to, fromLabel: usRoundLabel(from), toLabel: usRoundLabel(to),
    rows: shownRows, shown: rows.length, compared: compared.length, notComparable,
    significantCount, graduationCount, breeds,
    cohortLabel, cohortN, cohortTooSmall: cohortN > 0 && cohortN < MIN_COHORT,
  };
}

/** Format one delta for display, with a sign. GTPI stays a whole number. */
export function formatUsDelta(c: UsTraitChange): string {
  if (c.delta == null) return "—";
  const s = c.delta.toFixed(c.decimals);
  return c.delta > 0 ? `+${s}` : s;
}
