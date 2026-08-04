// ---------------------------------------------------------------------------
// ANALOGUE FORECASTING — "which bulls did this before, and what happened next?"
//
// For each bull and trait we find the bulls who were at the SAME POINT IN A
// CAREER — same age, same reliability, same daughter position, moving the same
// way — and read off what those bulls actually did on their next round. Their
// realised moves become the predictive distribution.
//
// WHAT THIS DOES AND DOES NOT PREDICT
//
// It does NOT predict direction. Whether a bull goes up or down is information
// Lactanet has not published yet, and eight independent methods failed to find
// it: trend extrapolation, mean reversion, cohort drift, seasonality, analogue
// matching, interim-to-official carryover, cross-trait structure, and the
// cohort average itself. The point forecast is therefore the CURRENT VALUE,
// unchanged. Using the analogues' median instead measured 0.10pp worse.
//
// It DOES predict how far a bull can move. That is a property of where he sits
// in his career — a bull taking on his first daughter crop is volatile, a
// settled proven sire is not — and career-stage matching captures it. Measured
// against the cohort-wide band this report used to publish, the analogue band
// is 2.8% better by CRPS, every trait improving, every confidence interval
// clear of zero, and it holds on official rounds specifically (which is what
// August is).
//
// ON COVERAGE — DO NOT "FIX" THIS
//
// Realised coverage runs 80-93% against a nominal 80%, and that is correct
// behaviour, not a defect. Proof moves are not spread smoothly: they pile up on
// exactly zero (Conformation does not move at all for 80% of bulls in a round,
// Daughter Fertility 75%, Milking Speed 73%). A 10th-to-90th-percentile band
// over a distribution with a point mass that large collapses onto "no change",
// so the actual value lands exactly ON the band edge rather than inside it —
// a third of all apparent coverage is ties sitting on the boundary.
//
// Six recalibration schemes were tested (split conformal per level, median
// re-centring, one width multiplier, separate tail multipliers, per-level
// multipliers, a trailing window). Every one made the forecast worse, in every
// one of 400 bootstrap resamples. An oracle allowed to pick the best width
// multiplier with hindsight chose exactly 1.00 on eight of nine traits. Forcing
// nominal coverage takes the model from +3.25% to +0.62%, and Conformation from
// +3.96% to -3.58%. There is no sharpening available. Publish the zero-move
// share instead — that is the number that honestly conveys the uncertainty.
// ---------------------------------------------------------------------------

import { isRollbackRound, isOfficialProof } from "./rollback";

export type RoundKind = "interim" | "official" | "april";

export function roundKindOf(d: Date): RoundKind {
  if (isRollbackRound(d)) return "april";
  return isOfficialProof(d) ? "official" : "interim";
}

/** One proof round, reduced to what the model reads. */
export interface AnalogueRound {
  time: number;
  kind: RoundKind;
  rel: number | null;
  daughters: number | null;
  sireType: string | null;
  traits: Map<string, number>;
}

export interface AnalogueBull {
  id: string;
  birthTime: number | null;
  rounds: AnalogueRound[]; // oldest first
}

/**
 * The feature set. Chosen by ablation over a 19-feature superset and verified
 * on a temporal holdout the search never saw; it carries 88% of the measured
 * improvement.
 *
 * Deliberately ABSENT, and not to be re-added without re-measuring:
 *   careerRound, relGrowth, daughterRate, d2, d3
 *     — measured dead weight, -0.73pp together.
 *   daughterGain (this round's daughters minus last round's)
 *     — LEAKAGE. It reads the round being predicted. It looked like the
 *       strongest feature in an early experiment for exactly that reason.
 *   activityCode / officialCode as ordered integers
 *     — worth ~0.12pp but they are categorical Lactanet status codes, and
 *       treating them as ordinal means an upstream recoding degrades the
 *       forecast silently rather than failing. Not worth 4% of the gain.
 */
export const ANALOGUE_FEATURES = [
  "ageYears",
  "rel",
  "logDaughters",
  "d1",
  "levelZ",
  "genomic",
  "absD1",
  "crossAbsD1",
  "hasDaughters",
  "roundsSinceOfficial",
] as const;
export type AnalogueFeature = (typeof ANALOGUE_FEATURES)[number];

/** Career position carries double weight; everything else is even. */
export const ANALOGUE_WEIGHTS: Record<AnalogueFeature, number> = {
  ageYears: 2, rel: 2, logDaughters: 2,
  d1: 1, levelZ: 1, genomic: 1, absD1: 1, crossAbsD1: 1, hasDaughters: 1, roundsSinceOfficial: 1,
};

/** Quantile levels published for every trait. */
export const QUANTILES = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];
export const Q_LO = 1;   // 10th
export const Q_HI = 7;   // 90th

/** Neighbours per forecast. Swept 25-400; 100 was flat-optimal and stable. */
export const K = 100;
/** Below this many eligible neighbours, fall back to the cohort-wide band. */
export const MIN_NEIGHBOURS = 100;
/** Below this many cohort moves there is no honest band at all. */
export const MIN_COHORT_MOVES = 30;

interface Case {
  bull: string;
  time: number;
  kind: RoundKind;
  last: number;
  move: number;
}

interface TraitCorpus {
  cases: Case[];          // time-ascending
  X: Float64Array;        // standardised features, row-major
  dim: number;
  colMean: number[];
  colSd: number[];
  /** SD of every non-April move. A unit conversion, not a fitted parameter. */
  scale: number;
  levelMean: number;
  levelSd: number;
  /** Sorted cohort moves per round kind — the fallback band and the threshold. */
  movesByKind: Map<RoundKind, number[]>;
  /** Median |move| per kind: what "a typical move" means for this trait. */
  materialByKind: Map<RoundKind, number>;
  /** Share of cohort moves that were exactly zero, per kind. */
  zeroShareByKind: Map<RoundKind, number>;
}

export interface Corpus {
  byTrait: Map<string, TraitCorpus>;
  codes: string[];
}

export interface AnalogueTraitForecast {
  /** Absolute values at each level of QUANTILES. */
  quantiles: number[];
  lo: number;
  hi: number;
  /** Mean absolute move among the analogues — "how far he is likely to move". */
  expectedMove: number;
  /** Share of analogues that did not move at all. */
  zeroShare: number;
  /** A move larger than this counts as material for this trait and round kind. */
  material: number;
  pUp: number;
  pDown: number;
  pSteady: number;
  neighbours: number;
  basis: "analogue" | "cohort";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const sdOf = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
};

/** Linear-interpolated quantile of an already-sorted array. */
export function quantileOf(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Per bull, per trait: the signed move (in trait-SD units) ENDING at each round.
 * A step that lands on an April is a base change — the whole lineup moving at
 * once — not the bull moving, so it is not a shape and is left null.
 */
function stepSeries(bull: AnalogueBull, code: string, scale: number): (number | null)[] {
  const out: (number | null)[] = new Array(bull.rounds.length).fill(null);
  for (let j = 1; j < bull.rounds.length; j++) {
    if (bull.rounds[j].kind === "april") continue;
    const p = bull.rounds[j - 1].traits.get(code);
    const q = bull.rounds[j].traits.get(code);
    if (p != null && q != null) out[j] = (q - p) / scale;
  }
  return out;
}

/**
 * Raw (unstandardised) features for "predict round `i` of this bull", reading
 * ONLY rounds strictly before `i`. `i === rounds.length` builds the live query
 * for the round that has not happened yet.
 */
function rawFeatures(
  bull: AnalogueBull,
  code: string,
  i: number,
  steps: Map<string, (number | null)[]>,
  levelMean: number,
  levelSd: number,
): { f: (number | null)[]; last: number } | null {
  const prev = bull.rounds[i - 1];
  if (!prev) return null;
  const last = prev.traits.get(code);
  if (last == null) return null;

  const d1 = steps.get(code)?.[i - 1] ?? null;

  // How unsettled the bull's WHOLE profile is: the mean absolute move of his
  // other traits into the previous round. A bull whose entire profile is
  // shifting is in a different situation from one where a single trait twitched.
  let sum = 0, n = 0;
  for (const [other, arr] of steps) {
    if (other === code) continue;
    const d = arr[i - 1];
    if (d != null) { sum += Math.abs(d); n++; }
  }
  const crossAbsD1 = n ? sum / n : null;

  // Interims since the last official round — where in the publication cycle he is.
  let rso = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (bull.rounds[j].kind !== "interim") break;
    rso++;
  }

  const f: (number | null)[] = [
    bull.birthTime != null ? (prev.time - bull.birthTime) / (365.25 * 864e5) : null, // ageYears
    prev.rel,                                                                        // rel
    prev.daughters == null ? null : Math.log1p(prev.daughters),                       // logDaughters
    d1,                                                                              // d1
    (last - levelMean) / (levelSd || 1),                                             // levelZ
    prev.sireType === "genomic" ? 1 : 0,                                             // genomic
    d1 == null ? null : Math.abs(d1),                                                // absD1
    crossAbsD1,                                                                      // crossAbsD1
    prev.daughters != null && prev.daughters > 0 ? 1 : 0,                            // hasDaughters
    rso,                                                                             // roundsSinceOfficial
  ];
  return { f, last };
}

/**
 * Build the historical corpus every forecast is matched against.
 *
 * April rounds are excluded throughout: a base change is published by Lactanet
 * and modelled separately, and letting it in would flatter the model with a
 * signal that is already known exactly.
 */
export function buildCorpus(bulls: AnalogueBull[], codes: string[]): Corpus {
  const byTrait = new Map<string, TraitCorpus>();
  const dim = ANALOGUE_FEATURES.length;

  // Trait units first — needed before any feature can be built.
  const scales = new Map<string, number>();
  const levels = new Map<string, { m: number; s: number }>();
  for (const code of codes) {
    const moves: number[] = [], vals: number[] = [];
    for (const b of bulls) {
      for (let i = 0; i < b.rounds.length; i++) {
        const v = b.rounds[i].traits.get(code);
        if (v != null) vals.push(v);
        if (i === 0 || b.rounds[i].kind === "april") continue;
        const p = b.rounds[i - 1].traits.get(code);
        if (p != null && v != null) moves.push(v - p);
      }
    }
    scales.set(code, sdOf(moves) || 1);
    levels.set(code, { m: mean(vals), s: sdOf(vals) || 1 });
  }

  // Step series per bull, for every trait at once (crossAbsD1 needs them all).
  const stepsByBull = new Map<string, Map<string, (number | null)[]>>();
  for (const b of bulls) {
    const m = new Map<string, (number | null)[]>();
    for (const code of codes) m.set(code, stepSeries(b, code, scales.get(code)!));
    stepsByBull.set(b.id, m);
  }

  for (const code of codes) {
    byTrait.set(code, buildTraitCorpus(bulls, code, stepsByBull, levels.get(code)!, scales.get(code)!, dim));
  }
  return { byTrait, codes };
}

/** Build one trait's corpus, keeping cases and their feature rows paired. */
function buildTraitCorpus(
  bulls: AnalogueBull[],
  code: string,
  stepsByBull: Map<string, Map<string, (number | null)[]>>,
  lv: { m: number; s: number },
  scale: number,
  dim: number,
): TraitCorpus {
  const rows: { c: Case; f: (number | null)[] }[] = [];
  for (const b of bulls) {
    const steps = stepsByBull.get(b.id)!;
    for (let i = 1; i < b.rounds.length; i++) {
      const cur = b.rounds[i];
      if (cur.kind === "april") continue;
      const target = cur.traits.get(code);
      if (target == null) continue;
      const r = rawFeatures(b, code, i, steps, lv.m, lv.s);
      if (!r) continue;
      rows.push({
        c: { bull: b.id, time: cur.time, kind: cur.kind, last: r.last, move: target - r.last },
        f: r.f,
      });
    }
  }
  rows.sort((a, b) => a.c.time - b.c.time || (a.c.bull < b.c.bull ? -1 : 1));

  // Standardise each column over the corpus. This is a unit conversion, so it
  // uses the whole corpus; nulls become 0, which is the standardised mean.
  const colMean: number[] = [], colSd: number[] = [];
  for (let j = 0; j < dim; j++) {
    const present = rows.map((r) => r.f[j]).filter((v): v is number => v != null && Number.isFinite(v));
    colMean.push(mean(present));
    colSd.push(sdOf(present) || 1);
  }
  const X = new Float64Array(rows.length * dim);
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < dim; j++) {
      const v = rows[i].f[j];
      X[i * dim + j] = v == null || !Number.isFinite(v) ? 0 : (v - colMean[j]) / colSd[j];
    }
  }

  const movesByKind = new Map<RoundKind, number[]>();
  const materialByKind = new Map<RoundKind, number>();
  const zeroShareByKind = new Map<RoundKind, number>();
  for (const kind of ["interim", "official"] as const) {
    const ms = rows.filter((r) => r.c.kind === kind).map((r) => r.c.move).sort((a, b) => a - b);
    movesByKind.set(kind, ms);
    const abs = ms.map(Math.abs).sort((a, b) => a - b);
    materialByKind.set(kind, quantileOf(abs, 0.5));
    zeroShareByKind.set(kind, ms.length ? ms.filter((m) => m === 0).length / ms.length : 0);
  }

  return {
    cases: rows.map((r) => r.c), X, dim, colMean, colSd,
    scale, levelMean: lv.m, levelSd: lv.s,
    movesByKind, materialByKind, zeroShareByKind,
  };
}

/** Bounded max-heap: the k smallest distances in O(n log k) rather than a sort. */
class MaxHeap {
  private d: Float64Array;
  private i: Int32Array;
  private n = 0;
  constructor(private k: number) { this.d = new Float64Array(k); this.i = new Int32Array(k); }
  get worst(): number { return this.n < this.k ? Infinity : this.d[0]; }
  get size(): number { return this.n; }
  push(dist: number, idx: number): void {
    if (this.n < this.k) {
      let c = this.n++;
      this.d[c] = dist; this.i[c] = idx;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (this.d[p] >= this.d[c]) break;
        [this.d[p], this.d[c]] = [this.d[c], this.d[p]];
        [this.i[p], this.i[c]] = [this.i[c], this.i[p]];
        c = p;
      }
    } else if (dist < this.d[0]) {
      this.d[0] = dist; this.i[0] = idx;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let big = p;
        if (l < this.n && this.d[l] > this.d[big]) big = l;
        if (r < this.n && this.d[r] > this.d[big]) big = r;
        if (big === p) break;
        [this.d[p], this.d[big]] = [this.d[big], this.d[p]];
        [this.i[p], this.i[big]] = [this.i[big], this.i[p]];
        p = big;
      }
    }
  }
  indices(): number[] { return Array.from(this.i.subarray(0, this.n)); }
}

/** The cohort-wide band — the fallback, and what this report used to publish. */
function cohortForecast(tc: TraitCorpus, last: number, kind: RoundKind): AnalogueTraitForecast | null {
  const moves = tc.movesByKind.get(kind) ?? [];
  if (moves.length < MIN_COHORT_MOVES) return null;
  const material = tc.materialByKind.get(kind) ?? 0;
  return summarise(moves, last, material, "cohort");
}

/** Turn a set of realised moves into the published distribution. */
function summarise(
  sortedMoves: number[],
  last: number,
  material: number,
  basis: "analogue" | "cohort",
): AnalogueTraitForecast {
  const n = sortedMoves.length;
  const quantiles = QUANTILES.map((q) => last + quantileOf(sortedMoves, q));
  let up = 0, down = 0, zero = 0, absSum = 0;
  for (const m of sortedMoves) {
    if (m > material) up++;
    else if (m < -material) down++;
    if (m === 0) zero++;
    absSum += Math.abs(m);
  }
  return {
    quantiles,
    lo: quantiles[Q_LO],
    hi: quantiles[Q_HI],
    expectedMove: n ? absSum / n : 0,
    zeroShare: n ? zero / n : 0,
    material,
    pUp: n ? up / n : 0,
    pDown: n ? down / n : 0,
    pSteady: n ? (n - up - down) / n : 0,
    neighbours: n,
    basis,
  };
}

/**
 * Forecast one trait for one bull.
 *
 * Neighbours are restricted to rounds that had already concluded before
 * `targetTime`, and the bull is never his own analogue. For a live forecast
 * `targetTime` is in the future, so the whole corpus is eligible.
 *
 * `historyLength` exists so the same code path can be backtested: set it to the
 * index of a past round and the model sees only what was on file at the time.
 * The report's accuracy panel relies on this — a backtest that ran through
 * different code would not be measuring what ships.
 */
export function forecastTrait(
  corpus: Corpus,
  code: string,
  bull: AnalogueBull,
  targetKind: RoundKind,
  targetTime: number,
  opts: { stepsCache?: Map<string, (number | null)[]>; historyLength?: number } = {},
): AnalogueTraitForecast | null {
  const tc = corpus.byTrait.get(code);
  if (!tc || targetKind === "april") return null;

  const steps = opts.stepsCache ?? stepsFor(corpus, bull);
  const historyLength = opts.historyLength ?? bull.rounds.length;

  const q = rawFeatures(bull, code, historyLength, steps, tc.levelMean, tc.levelSd);
  if (!q) return null;
  const { last } = q;

  // Standardise the query with the corpus's own column statistics.
  const qz = new Float64Array(tc.dim);
  for (let j = 0; j < tc.dim; j++) {
    const v = q.f[j];
    qz[j] = v == null || !Number.isFinite(v) ? 0 : (v - tc.colMean[j]) / tc.colSd[j];
  }

  const weights = ANALOGUE_FEATURES.map((f) => ANALOGUE_WEIGHTS[f]);
  const heap = new MaxHeap(K);
  for (let i = 0; i < tc.cases.length; i++) {
    const o = tc.cases[i];
    if (o.time >= targetTime) break;          // cases are time-ascending
    if (o.kind !== targetKind) continue;      // an interim is not an official round
    if (o.bull === bull.id) continue;         // never borrow from his own history
    let d = 0;
    const base = i * tc.dim;
    for (let j = 0; j < tc.dim; j++) {
      const x = (tc.X[base + j] - qz[j]) * weights[j];
      d += x * x;
    }
    if (d < heap.worst) heap.push(d, i);
  }

  if (heap.size < MIN_NEIGHBOURS) return cohortForecast(tc, last, targetKind);

  const moves = heap.indices().map((i) => tc.cases[i].move).sort((a, b) => a - b);
  const material = tc.materialByKind.get(targetKind) ?? 0;
  return summarise(moves, last, material, "analogue");
}

/** Step series for one bull across every trait — hoisted so a caller can reuse it. */
export function stepsFor(corpus: Corpus, bull: AnalogueBull): Map<string, (number | null)[]> {
  const m = new Map<string, (number | null)[]>();
  for (const c of corpus.codes) {
    const t = corpus.byTrait.get(c);
    if (t) m.set(c, stepSeries(bull, c, t.scale));
  }
  return m;
}

/** Cohort-level facts a report needs to describe a round honestly. */
export function cohortFacts(corpus: Corpus, code: string, kind: RoundKind): {
  zeroShare: number; material: number; typicalMove: number; n: number;
} | null {
  const tc = corpus.byTrait.get(code);
  if (!tc) return null;
  const moves = tc.movesByKind.get(kind) ?? [];
  if (!moves.length) return null;
  return {
    zeroShare: tc.zeroShareByKind.get(kind) ?? 0,
    material: tc.materialByKind.get(kind) ?? 0,
    typicalMove: mean(moves.map(Math.abs)),
    n: moves.length,
  };
}
