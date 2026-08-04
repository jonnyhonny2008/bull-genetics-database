// ---------------------------------------------------------------------------
// Proof Change Report — how each NAAB bull moved between its latest proof and
// the immediately previous OFFICIAL (April / August / December) proof.
//
// Only bulls with a current NAAB code are included. The comparison is:
//   latest  = the newest proof on file (interim or official)
//   previous = the most recent official (Apr/Aug/Dec) proof strictly before it
//
// SIGNIFICANCE is standard-deviation based, not a raw percentage: a trait is
// flagged when its change is unusual versus how the REPORTED COHORT moved on
// that trait — |Δ − meanΔ| ≥ N·SD (z-score). The cohort is whatever the filters
// selected, so the Blondin toggle re-bases the mean and SD, not just the row
// set; `cohortLabel` carries that fact to the page. This is scale-free (works for LPI,
// kg, deviation %, and type RBVs alike), handles negatives/near-zero cleanly,
// and — because the herd-wide shift sits in the mean — flags the bulls that
// moved notably rather than everyone. N is the sensitivity (0.5 / 1 / 1.5).
//
// A bull counts as "significant" only when one of the NINE KEY traits clears
// the bar; the other ~40 traits are still flagged and shown, but don't drive
// the significant filter. A plain % column is kept for reference.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import type { Prisma } from "@prisma/client";
import { blondinWhere } from "./sire-class";
import { isOfficialProof } from "./rollback";
import { unpackTraits, traitDefMap, type TraitDefLite } from "./eval-traits";

// How the "previous" side is auto-selected when neither round is pinned:
//   "official"    — latest proof vs the previous OFFICIAL (Apr/Aug/Dec) round.
//   "consecutive" — latest proof vs the immediately previous run of ANY kind
//                   (interim or official). This is the interim-to-interim view.
export type ChangeMode = "official" | "consecutive";

// The nine traits now live in ./key-traits, which carries no prisma import, so
// the Mating Program's pure scoring module can show the same set. Imported for
// use below AND re-exported, so every existing `from "./proof-change"` import
// keeps working unchanged.
import { KEY_TRAITS, KEY_TRAIT_CODES } from "./key-traits";
export { KEY_TRAITS, KEY_TRAIT_CODES };
const KEY_LABEL = new Map(KEY_TRAITS.map((t) => [t.code, t.label]));

export const SD_LEVELS = [0.5, 1, 1.5] as const;
export const SD_DEFAULT = 1;
const EPS = 0.01;                 // near-zero guard for the reference % column
const round2 = (n: number) => Math.round(n * 100) / 100;
export function sdFromParam(v: string | undefined): number {
  return v === "0.5" ? 0.5 : v === "1.5" ? 1.5 : SD_DEFAULT;
}

// --- Proof round selection -------------------------------------------------
// A round is identified by its YYYY-MM period (evaluationDate is the 1st of the
// run's month in UTC), which is stable regardless of how proofRun is labelled.

/** Stable key for a proof round, e.g. "2026-04". */
export function periodKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface ProofPeriod {
  key: string;      // "2026-04"
  label: string;    // "April 2026"
  official: boolean;
  bulls: number;    // how many NAAB bulls have a proof in this round
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function periodLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface TraitChange {
  code: string;
  name: string;
  category: string | null;
  key: boolean;
  previous: number | null;
  latest: number | null;
  delta: number | null; // latest - previous
  pct: number | null;   // reference only; null when near-zero prev
  z: number | null;     // (delta - lineup mean) / lineup SD for this trait
  flagged: boolean;     // |z| >= N
}

export interface BullProofChange {
  found: boolean;
  latestRun: string | null;
  previousRun: string | null;
  keyChanges: TraitChange[];   // the 9 key traits, in order (missing ones omitted)
  otherFlagged: TraitChange[]; // non-key traits that cleared the bar
  allChanges: TraitChange[];   // every trait, key first then by category/name
  flaggedCount: number;        // all flagged traits (key + other)
  keyFlaggedCount: number;     // flagged among the 9 key traits — drives "significant"
  lpiDelta: number | null;
  summary: string;
}

/** Internal: a bull's raw diff before cohort SDs are known. */
interface RawBull {
  found: boolean;
  latestRun: string | null;
  previousRun: string | null;
  lpiDelta: number | null;
  changes: TraitChange[]; // z/flagged not yet set
}

type EvalLite = { proofRun: string | null; evaluationDate: Date; traitsJson: string | null };

/**
 * Diff one bull's proofs (no flags yet).
 *
 * With no options this is "latest proof vs the previous official round". Pass
 * `to` / `from` (YYYY-MM period keys) to pin either side to a specific round —
 * a bull missing a pinned round simply isn't comparable and is left out.
 */
export function computeRawChange(
  evals: EvalLite[],
  defMap: Map<string, TraitDefLite>,
  opts: { from?: string; to?: string; mode?: ChangeMode } = {},
): RawBull {
  const empty: RawBull = { found: false, latestRun: null, previousRun: null, lpiDelta: null, changes: [] };
  const sorted = [...evals].sort((a, b) => b.evaluationDate.getTime() - a.evaluationDate.getTime());

  const latest = opts.to
    ? sorted.find((e) => periodKey(e.evaluationDate) === opts.to)
    : sorted[0];
  if (!latest) return empty;

  const previous = opts.from
    ? sorted.find((e) => periodKey(e.evaluationDate) === opts.from)
    : (opts.mode ?? "official") === "consecutive"
      // Interim-to-interim: the immediately previous run, whatever kind it is.
      ? sorted.find((e) => e.evaluationDate.getTime() < latest.evaluationDate.getTime())
      // Default: the most recent OFFICIAL round strictly before the latest.
      : sorted.find((e) => e.evaluationDate.getTime() < latest.evaluationDate.getTime() && isOfficialProof(e.evaluationDate));
  // The earlier side must actually be earlier, or there is nothing to compare.
  if (!previous || previous.evaluationDate.getTime() >= latest.evaluationDate.getTime()) return empty;

  const prevMap = new Map(unpackTraits(previous.traitsJson, defMap).map((t) => [t.traitCode, t]));
  const latMap = new Map(unpackTraits(latest.traitsJson, defMap).map((t) => [t.traitCode, t]));
  const codes = new Set<string>([...prevMap.keys(), ...latMap.keys()]);

  const changes: TraitChange[] = [];
  for (const code of codes) {
    const prev = prevMap.get(code)?.numericValue ?? null;
    const lat = latMap.get(code)?.numericValue ?? null;
    const delta = prev != null && lat != null ? round2(lat - prev) : null;
    const pct = prev != null && lat != null && Math.abs(prev) >= EPS ? (lat - prev) / Math.abs(prev) : null;
    const def = defMap.get(code);
    changes.push({
      code, name: KEY_LABEL.get(code) ?? def?.name ?? code, category: def?.category ?? null,
      key: KEY_TRAIT_CODES.includes(code), previous: prev, latest: lat, delta, pct, z: null, flagged: false,
    });
  }
  return { found: true, latestRun: latest.proofRun, previousRun: previous.proofRun, lpiDelta: changes.find((c) => c.code === "LPI")?.delta ?? null, changes };
}

/** Population mean + SD of a trait's changes across the lineup. */
export function traitStdStats(deltas: number[]): { mean: number; sd: number; n: number } {
  const n = deltas.length;
  if (n < 2) return { mean: deltas[0] ?? 0, sd: 0, n };
  const mean = deltas.reduce((s, d) => s + d, 0) / n;
  const variance = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / n;
  return { mean, sd: Math.sqrt(variance), n };
}

/** Apply the SD flag across the cohort and finalize each bull's derived fields. */
export function finalizeCohort(raws: RawBull[], sdMult: number): BullProofChange[] {
  const byTrait = new Map<string, number[]>();
  for (const r of raws) for (const t of r.changes) if (t.delta != null) {
    const arr = byTrait.get(t.code);
    if (arr) arr.push(t.delta); else byTrait.set(t.code, [t.delta]);
  }
  const stats = new Map<string, { mean: number; sd: number; n: number }>();
  for (const [code, ds] of byTrait) stats.set(code, traitStdStats(ds));
  return raws.map((r) => finalizeBull(r, stats, sdMult));
}

function finalizeBull(raw: RawBull, stats: Map<string, { mean: number; sd: number; n: number }>, N: number): BullProofChange {
  const changes: TraitChange[] = raw.changes.map((t) => {
    const s = stats.get(t.code);
    let z: number | null = null, flagged = false;
    if (t.delta != null && s && s.n >= 3 && s.sd > 0) {
      z = Math.round(((t.delta - s.mean) / s.sd) * 100) / 100;
      flagged = Math.abs(z) >= N - 1e-9;
    }
    return { ...t, z, flagged };
  });
  const byCode = new Map(changes.map((c) => [c.code, c]));
  const keyChanges = KEY_TRAITS.map((kt) => byCode.get(kt.code)).filter((c): c is TraitChange => !!c);
  const otherFlagged = changes.filter((c) => !c.key && c.flagged).sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
  const allChanges = [...changes].sort((a, b) => {
    if (a.key !== b.key) return a.key ? -1 : 1;
    if (a.key && b.key) return KEY_TRAIT_CODES.indexOf(a.code) - KEY_TRAIT_CODES.indexOf(b.code);
    return (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name);
  });
  const flaggedCount = changes.filter((c) => c.flagged).length;
  const keyFlaggedCount = keyChanges.filter((c) => c.flagged).length;
  return {
    found: raw.found, latestRun: raw.latestRun, previousRun: raw.previousRun,
    keyChanges, otherFlagged, allChanges, flaggedCount, keyFlaggedCount,
    lpiDelta: byCode.get("LPI")?.delta ?? null, summary: buildSummary(keyChanges, N),
  };
}

/** A short "what changed most" line: the biggest key moves + key flag count. */
function buildSummary(keyChanges: TraitChange[], N: number): string {
  const moved = keyChanges.filter((c) => c.delta != null && c.delta !== 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 3)
    .map((c) => `${c.name} ${c.delta! > 0 ? "+" : ""}${c.delta}`);
  const keyFlags = keyChanges.filter((c) => c.flagged).length;
  const parts: string[] = [];
  if (moved.length) parts.push(moved.join(", "));
  if (keyFlags) parts.push(`${keyFlags} key trait${keyFlags === 1 ? "" : "s"} moved ≥${N} SD`);
  return parts.join(" · ") || "No change";
}

export interface ReportRow {
  id: string;
  name: string;
  shortName: string | null;
  breed: string | null;
  naab: string | null;
  reg: string | null;
  change: BullProofChange;
}

export interface ProofChangeReport {
  rows: ReportRow[];
  totalNaab: number;
  compared: number;
  significantCount: number; // bulls with >=1 KEY trait flagged
  breeds: string[];
  sort: string;
  dir: "asc" | "desc";
  q: string;
  breed: string;
  significantOnly: boolean;
  sdMult: number;
  /** Raw `blondin` toggle: "1" = Blondin house bulls only, "" = the whole lineup. */
  blondin: string;
  /**
   * WHICH COHORT DEFINES SIGNIFICANCE — the flag is cohort-relative by design.
   *
   * The z-score is (Δ − meanΔ) / SD over the bulls in the report, so the Blondin
   * toggle does not merely hide rows: it re-bases the mean and SD the flag is
   * measured against. The same bull, over the same two rounds, can be flagged in
   * one view and not the other — that is intended (the question "did he move
   * unusually?" only means something relative to a stated peer group), but it
   * MUST be stated on the page rather than left implicit.
   */
  cohortLabel: string;
  /** Bulls in that cohort. finalizeBull needs n >= 3 per trait to score at all. */
  cohortN: number;
  /** True when the cohort is too small for ANY trait to be flagged (n < 3). */
  cohortTooSmall: boolean;
  /** Auto "previous" selection: previous-official vs immediately-previous-run. */
  mode: ChangeMode;
  /** Every proof round available across the NAAB bulls, newest first. */
  periods: ProofPeriod[];
  from: string;          // "" = auto (previous official)
  to: string;            // "" = auto (each bull's latest)
  /** Bulls skipped because they lack one of the selected rounds. */
  notComparable: number;
}

const SORTABLE = new Set(["lpi", "flags", "name", ...KEY_TRAIT_CODES.map((c) => c.toLowerCase())]);

/** Build the whole report from URL params — shared by the page and the export.
 *  `opts.mode` picks the auto "previous" side (default "official"). */
export async function getProofChangeReport(
  sp: Record<string, string | undefined>,
  opts: { mode?: ChangeMode } = {},
): Promise<ProofChangeReport> {
  const mode: ChangeMode = opts.mode ?? "official";
  const sdMult = sdFromParam(sp.sd);
  const defMap = await traitDefMap();
  // Blondin house bulls only, when the toggle is on. Both report pages and both
  // Excel exports run through here, so this is the only place it is applied.
  const blondin = (sp.blondin ?? "").trim();
  const blondinFilter = blondinWhere(blondin);
  const bulls = await prisma.animal.findMany({
    where: {
      archived: false, proofRoundCount: { gte: 2 },
      identifiers: { some: { active: true, idType: "naab" } },
      ...(blondinFilter ?? {}),
    },
    select: {
      id: true, primaryName: true, shortName: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
      evaluations: { orderBy: { evaluationDate: "desc" }, select: { proofRun: true, evaluationDate: true, traitsJson: true } },
    },
  } satisfies Prisma.AnimalFindManyArgs);

  // Available rounds across the NAAB lineup (newest first) for the selectors.
  const periodMap = new Map<string, { date: Date; bulls: number }>();
  for (const b of bulls) {
    const seen = new Set<string>();
    for (const e of b.evaluations) {
      const k = periodKey(e.evaluationDate);
      if (seen.has(k)) continue;
      seen.add(k);
      const p = periodMap.get(k);
      if (p) p.bulls++; else periodMap.set(k, { date: e.evaluationDate, bulls: 1 });
    }
  }
  const periods: ProofPeriod[] = [...periodMap.entries()]
    .map(([key, v]) => ({ key, label: periodLabel(v.date), official: isOfficialProof(v.date), bulls: v.bulls }))
    .sort((a, b) => b.key.localeCompare(a.key));

  // Only honour a selection that actually exists in the data.
  const valid = new Set(periods.map((p) => p.key));
  const to = valid.has(sp.to ?? "") ? (sp.to as string) : "";
  const from = valid.has(sp.from ?? "") ? (sp.from as string) : "";

  const withRaw = bulls.map((b) => ({ b, raw: computeRawChange(b.evaluations, defMap, { from, to, mode }) }));
  const comparedRaw = withRaw.filter((x) => x.raw.found);
  const finalized = finalizeCohort(comparedRaw.map((x) => x.raw), sdMult);

  const compared: ReportRow[] = comparedRaw.map((x, i) => ({
    id: x.b.id, name: x.b.primaryName, shortName: x.b.shortName, breed: x.b.breed?.breedName ?? null,
    naab: x.b.identifiers.find((i) => i.idType === "naab")?.idValue ?? null,
    reg: x.b.identifiers.find((i) => i.isPrimary)?.idValue ?? null,
    change: finalized[i],
  }));

  const breeds = [...new Set(compared.map((r) => r.breed).filter((b): b is string => !!b))].sort();
  const significantCount = compared.filter((r) => r.change.keyFlaggedCount > 0).length;

  // Filters.
  const q = (sp.q ?? "").trim();
  const breed = (sp.breed ?? "").trim();
  const significantOnly = sp.significant === "1";
  let rows = compared;
  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(ql) || (r.naab ?? "").toLowerCase().includes(ql) || (r.reg ?? "").toLowerCase().includes(ql) || (r.shortName ?? "").toLowerCase().includes(ql));
  }
  if (breed) rows = rows.filter((r) => r.breed === breed);
  if (significantOnly) rows = rows.filter((r) => r.change.keyFlaggedCount > 0);

  // Sort.
  const sort = SORTABLE.has((sp.sort ?? "").toLowerCase()) ? (sp.sort as string).toLowerCase() : "lpi";
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const keyDelta = (r: ReportRow, code: string) => r.change.keyChanges.find((c) => c.code === code)?.delta ?? null;
  if (sort === "name") {
    rows = [...rows].sort((a, b) => a.name.localeCompare(b.name) * (dir === "asc" ? 1 : -1));
  } else {
    const val = (r: ReportRow): number | null =>
      sort === "flags" ? r.change.keyFlaggedCount
      : sort === "lpi" ? (r.change.lpiDelta == null ? null : Math.abs(r.change.lpiDelta))
      : (() => { const d = keyDelta(r, sort.toUpperCase()); return d == null ? null : Math.abs(d); })();
    rows = [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "asc" ? av - bv : bv - av;
    });
  }

  // The cohort the z-scores were derived from is exactly `comparedRaw` — the same
  // set the query-level Blondin filter produced. Surface it so the page can say
  // so, and so it can warn when the cohort is too thin to flag anything at all
  // (finalizeBull needs n >= 3 comparable bulls per trait, otherwise z stays null
  // and every Flags cell silently reads 0 even though bulls did move).
  const cohortLabel = blondinFilter && (blondin === "1" || blondin === "only")
    ? "the Blondin lineup"
    : blondinFilter
      ? "the non-Blondin lineup"
      : "the whole lineup";

  return {
    rows, totalNaab: withRaw.length, compared: compared.length, significantCount, breeds,
    sort, dir, q, breed, significantOnly, sdMult, blondin, mode,
    cohortLabel, cohortN: comparedRaw.length, cohortTooSmall: comparedRaw.length > 0 && comparedRaw.length < 3,
    periods, from, to, notComparable: withRaw.length - compared.length,
  };
}
