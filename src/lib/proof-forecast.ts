// ---------------------------------------------------------------------------
// Proof Projection — a modelled "next round" proof for every NAAB bull.
//
// This is the Proof Change Report run forwards: instead of latest vs previous,
// it is latest vs a PREDICTED next round, trait by trait, with an uncertainty
// band on every number.
//
// WHAT IT CAN AND CANNOT DO
// A new round exists precisely because it carries information nobody has yet
// (new daughters, new herds). So no model reproduces it exactly. What is
// forecastable is the part driven by things already on file:
//   - where the bull's numbers have been heading (trend),
//   - how much his proof is still expected to move at all (reliability), and
//   - what the whole population does on that kind of round (systematic shift,
//     above all the April base change).
// Everything else lands in the interval, which is why every projection is
// published as a range and the report prints its own backtested accuracy.
//
// THE MODEL (deterministic and explainable — no black box)
// For each bull × trait, with `last` = the newest value on file:
//
//   predicted = last
//             + systematic                      // what the cohort does on this
//                                               //   kind of round (April base
//                                               //   change vs ordinary drift)
//             + PHI × (bullTrend − systematic)  // the bull's OWN deviation from
//                                               //   that, damped — genetic
//                                               //   trends mean-revert, so an
//                                               //   undamped slope overshoots
//             + w × (cohortLevel − last)        // regression to the mean, scaled
//                                               //   by (1 − reliability): young
//                                               //   genomic bulls regress, proven
//                                               //   bulls barely move
//
// The interval is EMPIRICAL — the observed spread of real round-to-round changes
// for that trait, widened when reliability is low. Nothing is assumed normal.
//
// Splitting `systematic` from the bull's deviation is what stops the April base
// change (which moves everyone at once) being mistaken for a bull-specific slide.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import type { Prisma } from "@prisma/client";
// NOTE: the Blondin filter is defined HERE rather than imported from
// ./sire-class on purpose. An identical helper lives there, but it is part of
// work that has not been committed yet — importing it built fine locally and
// broke the Vercel build, which only ever sees committed code. Keeping this
// module self-contained means it cannot be broken by another branch's state.
const BLONDIN_ROLE = "blondin";

function blondinWhere(v: string | null | undefined): Prisma.AnimalWhereInput | null {
  switch (v) {
    case "1":
    case "only": return { roles: { some: { roleType: BLONDIN_ROLE, active: true } } };
    case "0":
    case "exclude": return { roles: { none: { roleType: BLONDIN_ROLE, active: true } } };
    default: return null;
  }
}
import { isRollbackRound, isOfficialProof } from "./rollback";
import { unpackTraits, traitDefMap } from "./eval-traits";
import { breedCodeOf, projectedShift, fallbackShift, hasPublished, LATEST_PUBLISHED_YEAR } from "./base-change";
import { KEY_TRAITS, KEY_TRAIT_CODES, periodKey, traitStdStats } from "./proof-change";
import {
  buildCorpus, forecastTrait, stepsFor, cohortFacts, quantileOf, QUANTILES,
  type AnalogueBull, type AnalogueTraitForecast, type Corpus,
} from "./proof-analogue";
import {
  buildResidualIndex, findSimilar, curveOf, parseMode,
  ALL_TRAITS, MIN_OVERLAP, DEFAULT_LIMIT as SIMILAR_LIMIT,
  type SimilarityMode, type SubjectStatus,
} from "./proof-similarity";

export { KEY_TRAITS } from "./proof-change";

/**
 * Tuning constants. These are not guesses: the backtest in this file is the
 * arbiter, and the defaults below are the combination that measurably beat
 * "assume no change" on the real imported rounds. See MODEL NOTES at the foot
 * of this file for what was tried and rejected.
 */
export interface ModelParams {
  /** Damping on the bull's own trend. Below 1 because genetic trends mean-revert. */
  phi: number;
  /** Damping when there is only ONE observed step — weak evidence. */
  phiThin: number;
  /** Max pull toward the cohort mean at reliability 0, as (1-rel) × this. */
  regression: number;
  /** Only learn the systematic shift from steps this recent (months). Null = all
   *  history, which badly overstates one round's drift for long-career bulls. */
  recentMonths: number | null;
  /** Shrinkage on the systematic term (1 = apply in full). */
  systematicWeight: number;
}

/**
 * MODEL NOTES — why the defaults are what they are.
 *
 * These were chosen by backtesting on the real imported rounds (see runBacktest),
 * not by taste. Measured over ~60k trait-rounds:
 *
 *   • APRIL (base-change) rounds — applying the systematic shift scored +23%
 *     better than assuming no change, and far more on the production traits:
 *     Milk +63%, Fat +66%, Protein +71%, Fat% +39%, Protein% +45%.
 *   • ORDINARY rounds — every correction tried made things WORSE (−5% to −10%).
 *     A published proof is already a best prediction of itself; between base
 *     changes the current value is genuinely the best estimate of the next one.
 *   • Extrapolating a bull's own trend (phi > 0) hurt EVERYWHERE. Tested one
 *     step ahead over 6,159 predictions and segmented by reliability band
 *     (<70 / 70-85 / 85+), by history depth (<=3 / 4-8 / 9+ rounds) and by
 *     whether the bull moved at all last round: every trait, every segment,
 *     every damping factor came out worse than leaving the value alone, and
 *     monotonically worse the harder the trend was applied. Interim movement
 *     does not carry into the next round — each round's change is new
 *     information, which is exactly what an unbiased evaluation implies.
 *   • Nor is the SIZE of the next move forecastable per bull: a bull's own
 *     past volatility correlates only ~0.08 with how far he moves next round,
 *     and predicted it WORSE than the cohort's typical movement. Hence the
 *     interval is cohort-derived.
 *   • Regressing bulls toward the lineup average was the single worst idea
 *     tried (−40%). Each bull is predicted from HIS OWN series; the cohort is
 *     used only for the round-level shift and the width of the interval.
 *   • LPI carries no April base change — Lactanet folds it into the LPI
 *     formula's constant — and the backtest independently found no April signal
 *     in LPI. The published table encodes that as 0.
 *
 * So: persistence by default, a real (published) base-change correction on
 * Aprils, and an empirical interval on everything.
 */
export const DEFAULT_PARAMS: ModelParams = {
  phi: 0,
  phiThin: 0,
  regression: 0,
  recentMonths: 24,
  systematicWeight: 1,
};
/** z for the published interval. 1.28 ≈ 80% under a normal; bands are empirical. */
const Z80 = 1.28;
/** A trait needs this many cohort observations before its stats are trusted. */
const MIN_COHORT_OBS = 5;
/** Assumed reliability when a round carries none (mid-range, so mild regression). */
const DEFAULT_RELIABILITY = 0.7;

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type Confidence = "high" | "medium" | "low";

export interface TraitForecast {
  code: string;
  name: string;
  category: string | null;
  key: boolean;
  current: number | null;
  predicted: number | null;
  delta: number | null;
  lo: number | null;
  hi: number | null;
  /** How the number was reached — shown so a user can audit any projection. */
  basis: "trend" | "hold" | "regression" | "base change" | "analogue" | "cohort";
  /** Observed steps behind the bull's trend term. */
  steps: number;

  // --- The predictive distribution ----------------------------------------
  // Direction is not forecastable; MOVEMENT is. These are what the report
  // actually leads with, and they come from the bulls who were at this bull's
  // career stage — see proof-analogue.ts.
  /**
   * CONFIDENCE IN THE PROJECTED VALUE, 0-1 — the headline number beside every
   * projection. See proof-analogue.ts for exactly what it measures.
   */
  confidence: number | null;
  /** Mean absolute move among his analogues: how far he is likely to move. */
  expectedMove: number | null;
  /** Share of his analogues whose value did not change at all. */
  zeroShare: number | null;
  /** Chance of coming in lower / higher, and the typical size of each. */
  pDrop: number | null;
  dropSize: number | null;
  pRise: number | null;
  riseSize: number | null;
  /** Full distribution at QUANTILE_LEVELS, for charting the fan. */
  quantiles: number[] | null;
  /** How many analogues stood behind it (K, or fewer near the fallback). */
  neighbours: number | null;
}

/** The probability levels behind every `quantiles` array. */
export const QUANTILE_LEVELS = QUANTILES;

/** How exposed a bull is to movement, relative to the rest of the lineup. */
export type ExposureBand = "steady" | "typical" | "exposed";

export interface BullForecast {
  found: boolean;
  fromRun: string | null;
  roundsOnFile: number;
  reliability: number | null;
  confidence: Confidence;
  keyForecasts: TraitForecast[];
  /** Every trait — index AND linear/type — for the full projected profile. */
  allForecasts: TraitForecast[];
  lpiDelta: number | null;
  direction: "up" | "down" | "hold";
  summary: string;
  drivers: string[];

  // --- Movement exposure ---------------------------------------------------
  /** Mean absolute LPI move among his analogues — the headline "how far". */
  expectedLpiMove: number | null;
  /** Where that sits in the reported lineup, 0 (steadiest) to 100 (most exposed). */
  exposure: number | null;
  exposureBand: ExposureBand | null;
  /**
   * Mean confidence across the nine key traits, 0-1 — the bull's overall figure.
   * Distinct from `confidence` above, which is the high/medium/low grade for how
   * much history backs the forecast at all. This one is the percentage shown
   * beside each projected value; that one is displayed as "evidence".
   */
  confidencePct: number | null;
  /** Confidence in the projected LPI specifically. */
  lpiConfidence: number | null;
}

export interface ForecastRow {
  id: string;
  name: string;
  shortName: string | null;
  breed: string | null;
  naab: string | null;
  reg: string | null;
  forecast: BullForecast;
}

/** Accuracy measured by re-predicting the most recent round from history only. */
export interface BacktestTrait {
  code: string;
  label: string;
  n: number;
  mae: number;         // mean absolute error of the model
  naiveMae: number;    // mean absolute error of "assume no change"
  skill: number;       // % better than naive (negative = worse)
  coverage: number;    // % of actuals that fell inside the 80% band
  /**
   * The measure that matters. CRPS scores the whole predicted RANGE — it
   * penalises a band both for missing and for being needlessly wide, so nothing
   * can score well by hedging. `rangeSkill` is the % improvement over the
   * cohort-wide band this report used to publish.
   */
  crps: number;
  cohortCrps: number;
  rangeSkill: number;
  /** Predictions behind the range figures (more rounds than the point figures). */
  rangeN: number;
  /** Share of the tested rounds where the value did not change at all. */
  zeroShare: number;
}

export interface Backtest {
  ran: boolean;
  bulls: number;
  roundLabel: string | null;
  traits: BacktestTrait[];
  /** Weighted overall skill across the key traits. */
  overallSkill: number | null;
  overallCoverage: number | null;
  /** Weighted % improvement of the analogue range over the cohort-wide range. */
  overallRangeSkill: number | null;
  /** How many recent rounds per bull the range figures were measured over. */
  rangeRounds: number;
}

export interface ForecastReport {
  rows: ForecastRow[];
  compared: number;
  totalNaab: number;
  notComparable: number;
  breeds: string[];
  targetLabel: string;
  targetIsApril: boolean;
  targetIsOfficial: boolean;
  /** True when Lactanet's published base change for the target April is on file. */
  basePublished: boolean;
  latestLabel: string | null;
  backtest: Backtest;
  risers: number;
  fallers: number;
  avgLpiDelta: number | null;

  // --- What the report actually leads with ---------------------------------
  /**
   * How the lineup behaves on this kind of round, per key trait: how often a
   * bull moves at all, and by how much. This is the forecastable part, and it
   * is what replaces a column of zeroes.
   */
  movement: { code: string; label: string; movedShare: number; typicalMove: number; material: number; n: number }[];
  /** Bulls whose projected LPI carries under 50% confidence. */
  lowConfidence: number;
  /** Mean confidence in the projected LPI across the reported lineup. */
  avgLpiConfidence: number | null;
  // filters / state
  /** Retained for URL compatibility; this report always targets the next round. */
  target: string;
  /** interim | official | april — drives how wide the interval should be. */
  targetKind: RoundKind;
  q: string;
  breed: string;
  sort: string;
  dir: "asc" | "desc";
  blondin: string;
  cohortLabel: string;
  cohortN: number;
  minConfidence: string;

  // --- "Sires that move like him" -----------------------------------------
  /**
   * Built only for the one bull named in `?similar=`, from the rounds this
   * request has ALREADY loaded — see buildSimilarPanel. Null the rest of the
   * time, which is every request that has not asked for it.
   */
  similar: SimilarPanel | null;
  similarFor: string | null;
  similarTrait: string;
  similarMode: SimilarityMode;
}

// ---------------------------------------------------------------------------
// "SIRES THAT MOVE LIKE HIM"
//
// The maths lives in proof-similarity.ts, which is pure and unit-tested. What
// is here is the loader and the display shapes.
//
// EGRESS: this adds NO database work. The whole-history load is the expensive
// part of this report and it has already happened by the time this runs — every
// bull's rounds are decoded once, at the top of getProofForecastReport, and the
// panel is built from those same in-memory rounds. A second query "just for the
// similar bulls" would re-read the entire lineup's history to answer a question
// about one bull.
// ---------------------------------------------------------------------------

/** A curve in the shape TraitTrendChart consumes. */
export interface SimilarSeries {
  code: string;
  label: string;
  points: { date: string; label: string; value: number; hint?: string }[];
}

export interface SimilarMatchRow {
  id: string;
  name: string;
  naab: string | null;
  breed: string | null;
  /** RMS distance between the residual series. Lower is more alike. */
  distance: number;
  /** The same number as 0-1, for readers who want one. */
  similarity: number;
  /**
   * The ranking statistic — the agreement over its null standard deviation.
   * The list is ordered by THIS, not by distance: see evidenceScore.
   */
  score: number;
  /**
   * CAREER STEPS where both bulls had a comparable round. This is what "rounds
   * overlapped" means to a reader, and it is deliberately NOT `elements`: with
   * nine traits selected, four career rounds make thirty-six compared elements,
   * and showing that as a round count overstates the evidence ninefold.
   */
  rounds: number;
  /** …of which this many are steps where both bulls actually moved on their own. */
  informativeRounds: number;
  /** Compared elements pooled across traits — the RMS denominator, not a round count. */
  elements: number;
  /** How many of the selected traits actually had enough shared history. */
  traitsMatched: number;
  series: SimilarSeries[];
}

export interface SimilarPanel {
  bullId: string;
  bullName: string;
  bullNaab: string | null;
  mode: SimilarityMode;
  /** The trait selection as it appears in the URL (a code, or ALL9). */
  trait: string;
  traitLabel: string;
  codes: string[];
  status: SubjectStatus;
  subject: SimilarSeries[];
  matches: SimilarMatchRow[];
  /** Other bulls in the reported lineup. */
  cohort: number;
  /** …of whom this many had enough shared history to be scored. */
  compared: number;
  /** …and this many were left out rather than scored on too little. */
  skipped: number;
  minOverlap: number;
  /** Informative career steps a trait needs before it may be compared at all. */
  minInformative: number;
  /** Rounds whose cohort term was too thin to measure, so were not compared. */
  roundsWithoutCohortTerm: number;
  /** Steps that crossed a round the bull has no row for, corrected against all of them. */
  stepsAcrossMissedRounds: number;
  /** …and steps dropped because a round they crossed had no measurable cohort term. */
  stepsDropped: number;
}

/** Resolve the trait parameter to the codes and the label to print. */
export function similarTraitCodes(trait: string | undefined): { key: string; codes: string[]; label: string } {
  if (trait === ALL_TRAITS) {
    return { key: ALL_TRAITS, codes: KEY_TRAIT_CODES, label: "all nine key traits" };
  }
  const kt = KEY_TRAITS.find((k) => k.code === trait);
  if (kt) return { key: kt.code, codes: [kt.code], label: kt.label };
  return { key: "LPI", codes: ["LPI"], label: "LPI" };
}

interface SimilarMeta { name: string; naab: string | null; breed: string | null }

/**
 * Build the panel for ONE bull from rounds already in memory.
 *
 * Exported so it can be driven from a future standalone picker without going
 * back to the database.
 */
export function buildSimilarPanel(
  bulls: AnalogueBull[],
  meta: Map<string, SimilarMeta>,
  bullId: string,
  trait: string | undefined,
  mode: string | undefined,
): SimilarPanel | null {
  const subjectMeta = meta.get(bullId);
  if (!subjectMeta) return null;

  const { key, codes, label } = similarTraitCodes(trait);
  const m = parseMode(mode);
  const index = buildResidualIndex(bulls, codes);
  const result = findSimilar(index, bullId, { mode: m, codes, limit: SIMILAR_LIMIT });

  const seriesFor = (id: string): SimilarSeries[] => {
    const out: SimilarSeries[] = [];
    for (const code of codes) {
      const curve = curveOf(index, id, code);
      if (curve.length < 2) continue;
      out.push({
        code,
        label: KEY_TRAITS.find((k) => k.code === code)?.label ?? code,
        points: curve.map((p) => ({
          date: String(p.position),
          label: `Round ${p.position + 2}`,
          value: round2(p.cumulative),
          hint: p.residual == null
            ? `${periodLabelOf(new Date(p.time))} — no comparable round`
            : `${periodLabelOf(new Date(p.time))} · own move ${p.residual > 0 ? "+" : ""}${round2(p.residual)}`,
        })),
      });
    }
    return out;
  };

  return {
    bullId,
    bullName: subjectMeta.name,
    bullNaab: subjectMeta.naab,
    mode: m,
    trait: key,
    traitLabel: label,
    codes,
    status: result.status,
    subject: seriesFor(bullId),
    matches: result.matches.map((mm) => {
      const md = meta.get(mm.id);
      return {
        id: mm.id,
        name: md?.name ?? mm.id,
        naab: md?.naab ?? null,
        breed: md?.breed ?? null,
        distance: Math.round(mm.distance * 1000) / 1000,
        similarity: Math.round(mm.similarity * 1000) / 1000,
        score: Math.round(mm.score * 100) / 100,
        rounds: mm.rounds,
        informativeRounds: mm.informativeRounds,
        elements: mm.elements,
        traitsMatched: mm.traits.length,
        series: seriesFor(mm.id),
      };
    }),
    cohort: result.cohort,
    compared: result.compared,
    skipped: result.skipped,
    minOverlap: MIN_OVERLAP,
    minInformative: result.minInformative,
    roundsWithoutCohortTerm: index.unmeasuredRounds,
    stepsAcrossMissedRounds: index.spanningSteps,
    stepsDropped: index.droppedSteps,
  };
}

interface EvalLite {
  proofRun: string | null;
  evaluationDate: Date;
  traitsJson: string | null;
  reliabilityOverall: number | null;
  daughters: number | null;
  sireType: string | null;
  runKind: string | null;
}

/**
 * One row per round, oldest→newest, preferring the official file over the
 * interim one for the same month. The two share a proofRun and evaluationDate,
 * so without this the forecast would see two rows for the month and treat the
 * gap between them as a real step. Values from the official file win where it
 * exists; months that only ever had an interim file are unchanged.
 */
function canonicalForecastRounds(evals: EvalLite[]): EvalLite[] {
  const rank = (k: string | null) => (k === "official" ? 0 : k === "interim" ? 1 : 2);
  const best = new Map<string, EvalLite>();
  for (const e of evals) {
    const key = e.proofRun ?? periodKey(e.evaluationDate);
    const cur = best.get(key);
    if (!cur || rank(e.runKind) < rank(cur.runKind)) best.set(key, e);
  }
  return [...best.values()].sort((a, b) => a.evaluationDate.getTime() - b.evaluationDate.getTime());
}

/** A decoded bull, as the report works with it internally. */
interface DecodedBull {
  b: { id: string; primaryName: string; shortName: string | null; birthDate: Date | null };
  rounds: {
    date: Date; run: string | null; reliability: number | null;
    daughters: number | null; sireType: string | null; runKind: string | null; traits: Map<string, number>;
  }[];
}

/** Reshape the report's decoded bulls into what the analogue model consumes. */
function toAnalogueBulls(decoded: DecodedBull[]): AnalogueBull[] {
  return decoded.map((x) => ({
    id: x.b.id,
    birthTime: x.b.birthDate ? x.b.birthDate.getTime() : null,
    rounds: x.rounds.map((r) => ({
      time: r.date.getTime(),
      kind: roundKind(r.date, r.runKind),
      rel: r.reliability,
      daughters: r.daughters,
      sireType: r.sireType,
      traits: r.traits,
    })),
  }));
}

/** One trait's observed history for a bull: value per round, oldest first. */
interface Obs { date: Date; value: number; runKind?: string | null }

/** Cohort-level statistics per trait, learned from the whole reported lineup. */
export interface TraitStats {
  /** Mean of the most recent value across bulls — the regression target. */
  level: number;
  /** Mean/SD of every consecutive round-to-round change. */
  drift: { mean: number; sd: number; n: number };
  /**
   * Behaviour split by KIND of round, because they are not alike. Measured over
   * ~33k real trait-rounds:
   *   interim  — the noisiest (LPI ±31, Milk ±60)
   *   official — Aug/Dec, about 40% CALMER than an interim (LPI ±20, Milk ±42)
   *   april    — the base change; by far the widest (Milk |Δ| ≈ 101)
   * Pooling them produced an August interval half again too wide.
   *
   * `q` is the empirical 10th/90th percentile as an offset from that kind's
   * mean. Real proof changes have fatter tails than a normal, so `1.28 × SD`
   * leaves the quieter traits over-confident; quantiles make no such assumption.
   */
  byKind: Record<RoundKind, { mean: number; sd: number; n: number; q: { lo: number; hi: number } | null }>;
  /** Mean change on steps that LAND on an April round (the base change). */
  aprilMean: number;
  aprilN: number;
  /** Mean change on steps that do not land on April. */
  ordinaryMean: number;
  ordinaryN: number;
}

/**
 * 10th/90th percentile of a set of changes, expressed relative to their mean so
 * the band can be re-centred on whatever we predict. Needs a decent sample —
 * below that, quantiles are just the extremes of a handful of points.
 */
function centredQuantiles(deltas: number[]): { lo: number; hi: number } | null {
  if (deltas.length < 20) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { lo: at(0.1) - mean, hi: at(0.9) - mean };
}

/** Summarise one kind of round, falling back to the pooled spread when thin. */
function kindStats(xs: number[], drift: { mean: number; sd: number; n: number }) {
  const s = xs.length >= MIN_COHORT_OBS ? traitStdStats(xs) : { mean: drift.mean, sd: drift.sd, n: xs.length };
  return { mean: s.mean, sd: s.sd, n: xs.length, q: centredQuantiles(xs) };
}

/** Extract one trait's ordered observations from a bull's rounds. */
function seriesOf(rounds: { date: Date; traits: Map<string, number>; runKind?: string | null }[], code: string): Obs[] {
  const out: Obs[] = [];
  for (const r of rounds) {
    const v = r.traits.get(code);
    if (v != null && Number.isFinite(v)) out.push({ date: r.date, value: v, runKind: r.runKind });
  }
  return out;
}

/** The three kinds of round, which behave very differently. */
export type RoundKind = "interim" | "official" | "april";

/**
 * Which of the three round kinds this is. April (the base change) is a calendar
 * fact and stays month-based. Official vs interim comes from the proof's recorded
 * runKind — NOT the month — because Lactanet publishes interim proofs in April /
 * August / December too, and official ones in other months. `runKind` is omitted
 * only for a future target round (no file yet), where the month is the best guess.
 */
export function roundKind(d: Date, runKind?: string | null): RoundKind {
  if (isRollbackRound(d)) return "april";
  if (runKind === "official") return "official";
  if (runKind === "interim") return "interim";
  return isOfficialProof(d) ? "official" : "interim";
}

/** Consecutive changes, tagged with the kind of the LATER round. */
function deltasOf(obs: Obs[]): { d: number; april: boolean; kind: RoundKind; at: Date }[] {
  const out: { d: number; april: boolean; kind: RoundKind; at: Date }[] = [];
  for (let i = 1; i < obs.length; i++) {
    out.push({ d: obs[i].value - obs[i - 1].value, april: isRollbackRound(obs[i].date), kind: roundKind(obs[i].date, obs[i].runKind), at: obs[i].date });
  }
  return out;
}

/**
 * Recency-weighted trend from the last few changes. The most recent step says
 * the most about where a bull is heading, but one step alone is noise, so up to
 * three are blended.
 */
function recentWeights(n: number): number[] {
  return n === 1 ? [1] : n === 2 ? [0.35, 0.65] : [0.2, 0.3, 0.5];
}

export function weightedTrend(deltas: number[]): number {
  if (deltas.length === 0) return 0;
  const recent = deltas.slice(-3);
  const weights = recentWeights(recent.length);
  let s = 0, w = 0;
  recent.forEach((d, i) => { s += d * weights[i]; w += weights[i]; });
  return w ? s / w : 0;
}

/**
 * Build per-trait cohort statistics from every bull's rounds.
 *
 * `since` restricts which STEPS teach the systematic shift. Pooling a bull's
 * whole career conflates decades of genetic gain into "what one round does",
 * which inflates every projection; the recent window keeps the estimate in the
 * current era. Levels and the interval still use everything available.
 */
export function buildTraitStats(
  bulls: { rounds: { date: Date; traits: Map<string, number>; runKind?: string | null }[] }[],
  codes: Set<string>,
  since?: Date,
): Map<string, TraitStats> {
  const out = new Map<string, TraitStats>();
  const cutoff = since ? since.getTime() : null;
  for (const code of codes) {
    const levels: number[] = [];
    const all: number[] = [];
    const april: number[] = [];
    const ordinary: number[] = [];
    const kinds: Record<RoundKind, number[]> = { interim: [], official: [], april: [] };
    for (const b of bulls) {
      const obs = seriesOf(b.rounds, code);
      if (obs.length) levels.push(obs[obs.length - 1].value);
      for (const { d, april: isApr, kind, at } of deltasOf(obs)) {
        if (cutoff != null && at.getTime() < cutoff) continue;
        all.push(d);
        (isApr ? april : ordinary).push(d);
        kinds[kind].push(d);
      }
    }
    if (!levels.length) continue;
    const drift = traitStdStats(all);
    out.set(code, {
      level: levels.reduce((s, v) => s + v, 0) / levels.length,
      drift,
      // Split, because pooling them widens ordinary-round intervals with the
      // spread of base changes that only ever happen in April.
      byKind: {
        interim: kindStats(kinds.interim, drift),
        official: kindStats(kinds.official, drift),
        april: kindStats(kinds.april, drift),
      },
      aprilMean: april.length ? april.reduce((s, v) => s + v, 0) / april.length : 0,
      aprilN: april.length,
      ordinaryMean: ordinary.length ? ordinary.reduce((s, v) => s + v, 0) / ordinary.length : 0,
      ordinaryN: ordinary.length,
    });
  }
  return out;
}

/**
 * Project ONE trait for ONE bull. Exported so the backtest and the unit tests
 * exercise exactly the code the report runs.
 */
export function projectTrait(
  obs: Obs[],
  stats: TraitStats | undefined,
  opts: { targetIsApril: boolean; targetKind?: RoundKind; reliability: number | null; relGrowth?: number | null; params?: ModelParams; publishedShift?: number | null },
): { predicted: number; lo: number; hi: number; basis: TraitForecast["basis"]; steps: number } | null {
  if (obs.length === 0) return null;
  const P = opts.params ?? DEFAULT_PARAMS;
  const last = obs[obs.length - 1].value;
  const deltas = deltasOf(obs);
  const rel = opts.reliability ?? DEFAULT_RELIABILITY;

  const kind: RoundKind = opts.targetKind ?? (opts.targetIsApril ? "april" : "official");
  // Cohort expectation for each kind of step. Only trusted with enough
  // observations, otherwise it is noise dressed as signal.
  const fallback = stats && stats.drift.n >= MIN_COHORT_OBS ? stats.drift.mean : 0;
  const aprilMean = stats && stats.aprilN >= MIN_COHORT_OBS ? stats.aprilMean : fallback;
  const ordinaryMean = stats && stats.ordinaryN >= MIN_COHORT_OBS ? stats.ordinaryMean : fallback;

  // Systematic component: what the round being predicted does to everyone.
  //
  // Only April carries one. On ordinary rounds every correction measured WORSE
  // than leaving the value alone, so nothing is applied (see MODEL NOTES).
  // When Lactanet has published the base change for that April we use it — it is
  // fact, not an estimate; otherwise we fall back to what past Aprils did.
  let systematic = 0;
  let usedPublished = false;
  if (opts.targetIsApril) {
    if (opts.publishedShift != null) { systematic = opts.publishedShift; usedPublished = true; }
    else systematic = aprilMean * P.systematicWeight;
  }
  void ordinaryMean;

  // The bull's own deviation from the cohort — measured against what the cohort
  // did on THE SAME KINDS OF STEPS his history is made of. Comparing an ordinary
  // step against the April mean would hand every bull a spurious correction of
  // ±phi × (base change) whenever an April is being predicted, quietly undoing
  // the very base change we just applied.
  const recent = deltas.slice(-3);
  const rw = recentWeights(recent.length);
  let es = 0, ew = 0;
  recent.forEach((x, i) => { es += (x.april ? aprilMean : ordinaryMean) * rw[i]; ew += rw[i]; });
  const expectedTrend = ew ? es / ew : 0;

  const bullTrend = weightedTrend(deltas.map((x) => x.d));
  const phi = deltas.length >= 2 ? P.phi : P.phiThin;
  const deviation = deltas.length ? phi * (bullTrend - expectedTrend) : 0;

  // Regression to the mean, scaled by how much proof is still unproven.
  const w = clamp((1 - rel) * P.regression, 0, Math.max(0, P.regression));
  const pull = stats && P.regression > 0 ? w * (stats.level - last) : 0;

  const predicted = last + systematic + deviation + pull;

  // Empirical interval: the observed spread of real round-to-round changes.
  //
  // Cohort-derived, NOT per-bull. A bull's own past volatility correlates only
  // ~0.08 with how far he actually moves next round, and using it measured
  // WORSE than the cohort's typical movement — so how much a given bull will
  // move is, like the direction, essentially unforecastable. What IS stable is
  // how much bulls move on that trait in general, and that is what the range
  // reports. The bull's own spread is used only as a fallback.
  // Match the spread to the KIND of round being predicted — an official round
  // is ~40% calmer than an interim, so pooling them overstates August badly.
  const ks = stats?.byKind[kind];
  const cohortSd = ks && ks.n >= MIN_COHORT_OBS ? ks.sd : (stats && stats.drift.n >= MIN_COHORT_OBS ? stats.drift.sd : 0);
  const bullSd = deltas.length >= 3 ? traitStdStats(deltas.map((x) => x.d)).sd : 0;
  const sigma = cohortSd > 0 ? cohortSd : bullSd;
  // Prefer the real quantiles; fall back to the normal approximation only when
  // there aren't enough observations for quantiles to mean anything.
  // Per-bull width: a bull whose reliability is climbing is taking on daughters
  // and moves harder than a settled one.
  const wm = widthMultiplier(opts.relGrowth);
  const q = ks?.q ?? null;
  const loOff = (q ? q.lo : -Z80 * sigma) * wm;
  const hiOff = (q ? q.hi : Z80 * sigma) * wm;
  void rel;

  const basis: TraitForecast["basis"] =
    usedPublished ? "base change"
    : deltas.length === 0 ? "hold"
    : Math.abs(pull) > Math.abs(deviation) ? "regression"
    : Math.abs(deviation) > 0 ? "trend"
    : systematic !== 0 ? "base change" : "hold";

  return { predicted: round2(predicted), lo: round2(predicted + loOff), hi: round2(predicted + hiOff), basis, steps: deltas.length };
}

function confidenceOf(rounds: number, reliability: number | null, aprilTarget: boolean): Confidence {
  const rel = reliability ?? DEFAULT_RELIABILITY;
  // An April target is inherently less certain: the base change is re-derived
  // each year and its size is only estimated from past Aprils.
  if (rounds >= 4 && rel >= 0.85 && !aprilTarget) return "high";
  if (rounds >= 4 && rel >= 0.9) return "high";
  if (rounds >= 3 && rel >= 0.75) return "medium";
  if (rounds >= 2 && rel >= 0.6) return "medium";
  return "low";
}

/** The next round after `latest`, using the cadence actually seen in the data. */
export function nextPeriod(periods: Date[]): Date {
  const sorted = [...periods].sort((a, b) => a.getTime() - b.getTime());
  const latest = sorted[sorted.length - 1];
  // Median month-gap between consecutive rounds — robust to an odd long gap.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    gaps.push((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()));
  }
  const positive = gaps.filter((g) => g > 0).sort((a, b) => a - b);
  const gap = positive.length ? positive[Math.floor(positive.length / 2)] : 1;
  return new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + Math.max(1, gap), 1));
}

export function periodLabelOf(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * How much wider (or tighter) this bull's interval should be, from how fast his
 * reliability is currently climbing — a value known BEFORE the round we predict.
 *
 * Measured over 6,159 one-step cases. Mean |LPI change| next round by the
 * reliability growth seen in the PREVIOUS step:
 *   flat        19.5   (n=5025)
 *   0-1 point   20.0   (n=98)
 *   1-3 points  23.7   (n=913)
 *   >3 points   32.8   (n=64)
 * A bull taking on daughters moves substantially harder.
 *
 * This WIDENS but never tightens. The ratios above were measured on LPI, and
 * applying a matching squeeze to the settled majority pushed the quieter traits
 * into over-confidence (Milking Speed covered 70% against an 80% target). Being
 * too wide costs a little sharpness; being too narrow tells someone a move was
 * unlikely when it was not. Only the widening is applied.
 *
 * Note the jump itself is not forecastable (prior growth predicts next growth
 * at corr -0.01); what it predicts is how far the bull moves, which is exactly
 * what the interval is for.
 */
export function widthMultiplier(relGrowth: number | null | undefined): number {
  if (relGrowth == null || relGrowth <= 0.01) return 1;
  if (relGrowth <= 0.03) return 1.2;
  return 1.65;
}

/** Cutoff date for "recent" steps, or undefined to use all history. */
function sinceWindow(latest: Date, months: number | null): Date | undefined {
  if (months == null) return undefined;
  return new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() - months, 1));
}

// "certainty" sorts by the confidence percentage; "confidence" sorts by the
// high/medium/low evidence grade. They are different questions and the report
// labels them differently — see BullForecast.
const SORTABLE = new Set(["certainty", "lpi", "conf", "name", "confidence", ...KEY_TRAIT_CODES.map((c) => c.toLowerCase())]);

export async function getProofForecastReport(sp: Record<string, string | undefined>): Promise<ForecastReport> {
  const defMap = await traitDefMap();
  const blondin = (sp.blondin ?? "").trim();
  const blondinFilter = blondinWhere(blondin);

  const bulls = await prisma.animal.findMany({
    where: {
      archived: false, proofRoundCount: { gte: 2 },
      identifiers: { some: { active: true, idType: "naab" } },
      ...(blondinFilter ?? {}),
    },
    select: {
      id: true, primaryName: true, shortName: true, birthDate: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
      evaluations: {
        orderBy: { evaluationDate: "asc" },
        // daughters / sireType feed the analogue model's career-stage matching.
        select: {
          proofRun: true, evaluationDate: true, traitsJson: true, reliabilityOverall: true,
          daughters: true, sireType: true, runKind: true,
        },
      },
    },
  } satisfies Prisma.AnimalFindManyArgs);

  // Decode every round once: date + a code→value map, oldest first. Collapse the
  // official and interim file for a month to a single round, keeping the official
  // one: leaving both in would feed the analogue walk a zero-elapsed-time "step"
  // between two versions of the same month and forecast from file-versus-file
  // noise rather than round-to-round movement.
  const decoded = bulls.map((b) => ({
    b,
    rounds: canonicalForecastRounds(b.evaluations as EvalLite[]).map((e) => ({
      date: e.evaluationDate,
      run: e.proofRun,
      reliability: e.reliabilityOverall,
      daughters: e.daughters,
      sireType: e.sireType,
      runKind: e.runKind,
      traits: new Map(unpackTraits(e.traitsJson, defMap).filter((t) => t.numericValue != null).map((t) => [t.traitCode, t.numericValue as number])),
    })),
  })).filter((x) => x.rounds.length >= 2);

  // Rounds available across the lineup (for the selector + the target).
  const periodMap = new Map<string, { date: Date; bulls: number }>();
  for (const x of decoded) {
    const seen = new Set<string>();
    for (const r of x.rounds) {
      const k = periodKey(r.date);
      if (seen.has(k)) continue;
      seen.add(k);
      const p = periodMap.get(k);
      if (p) p.bulls++; else periodMap.set(k, { date: r.date, bulls: 1 });
    }
  }
  // Newest round first, so `periods[0]` names the round being forecast from.
  const periods = [...periodMap.entries()]
    .map(([key, v]) => ({ key, label: periodLabelOf(v.date) }))
    .sort((a, b) => b.key.localeCompare(a.key));

  const allDates = [...periodMap.values()].map((v) => v.date);
  // This report covers the NEXT round on the observed cadence — the monthly /
  // official proof. April is deliberately not offered here: a base change is a
  // different animal (it moves every bull at once for reasons that have nothing
  // to do with the bull) and gets its own report.
  const target = allDates.length ? nextPeriod(allDates) : new Date();
  const targetKind = roundKind(target);
  const targetIsApril = isRollbackRound(target);
  const targetLabel = periodLabelOf(target);
  const latestLabel = periods[0]?.label ?? null;

  // Every trait code present anywhere — index traits AND linear/type traits, so
  // the per-bull view can project a complete profile.
  const codes = new Set<string>();
  for (const x of decoded) for (const r of x.rounds) for (const c of r.traits.keys()) codes.add(c);

  const latestDate = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : new Date();
  const stats = buildTraitStats(decoded, codes, sinceWindow(latestDate, DEFAULT_PARAMS.recentMonths));

  // The analogue corpus: every (bull, trait, round) on file, so each bull can be
  // matched against the bulls who were where he is now. Built once per report.
  const analogueBulls = toAnalogueBulls(decoded as DecodedBull[]);
  const corpus = buildCorpus(analogueBulls, KEY_TRAIT_CODES);
  const analogueById = new Map(analogueBulls.map((b) => [b.id, b]));
  const targetTime = target.getTime();

  // --- Project every bull ---
  const targetYear = target.getUTCFullYear();
  const rows: ForecastRow[] = decoded.map((x) => {
    const last = x.rounds[x.rounds.length - 1];
    const prev = x.rounds[x.rounds.length - 2];
    const rel = last.reliability;
    // How fast his reliability is climbing right now — widens or tightens the band.
    const relGrowth = last.reliability != null && prev?.reliability != null ? last.reliability - prev.reliability : null;
    // Published base changes are per breed, so resolve the bull's breed once.
    const breedCode = breedCodeOf(x.b.breed?.breedName ?? null);
    const forecasts: TraitForecast[] = [];

    // The analogue model covers the nine key traits (it needs a trait's own
    // history across the whole lineup to find analogues at all). Everything
    // else — the linear/type profile — keeps the cohort band.
    const ab = analogueById.get(x.b.id);
    const steps = ab ? stepsFor(corpus, ab) : null;

    for (const code of codes) {
      const obs = seriesOf(x.rounds, code);
      if (obs.length === 0) continue;
      // The target April's own published table if we have it; otherwise the most
      // recent published one, which still carries the structural facts (LPI = 0).
      const publishedShift = targetIsApril
        ? projectedShift(targetYear, code, breedCode) ?? fallbackShift(code, breedCode)
        : null;
      const p = projectTrait(obs, stats.get(code), { targetIsApril, targetKind, reliability: rel, relGrowth, publishedShift });
      if (!p) continue;
      const def = defMap.get(code);
      const current = obs[obs.length - 1].value;

      // On a non-April round the band comes from this bull's analogues, which
      // measured 2.5% sharper than the cohort band it replaces. An April is a
      // published base change and keeps its own path.
      const an: AnalogueTraitForecast | null =
        !targetIsApril && ab && steps && KEY_TRAIT_CODES.includes(code)
          ? forecastTrait(corpus, code, ab, targetKind, targetTime, { stepsCache: steps })
          : null;

      forecasts.push({
        code,
        name: KEY_TRAITS.find((k) => k.code === code)?.label ?? def?.name ?? code,
        category: def?.category ?? null,
        key: KEY_TRAIT_CODES.includes(code),
        current,
        predicted: p.predicted,
        delta: round2(p.predicted - current),
        lo: an ? round2(an.lo) : p.lo,
        hi: an ? round2(an.hi) : p.hi,
        basis: an ? an.basis : p.basis,
        steps: p.steps,
        confidence: an ? an.confidence : null,
        expectedMove: an ? round2(an.expectedMove) : null,
        zeroShare: an ? an.zeroShare : null,
        pDrop: an ? an.pDrop : null,
        dropSize: an ? round2(an.dropSize) : null,
        pRise: an ? an.pRise : null,
        riseSize: an ? round2(an.riseSize) : null,
        quantiles: an ? an.quantiles.map(round2) : null,
        neighbours: an ? an.neighbours : null,
      });
    }
    const byCode = new Map(forecasts.map((f) => [f.code, f]));
    const keyForecasts = KEY_TRAITS.map((k) => byCode.get(k.code)).filter((f): f is TraitForecast => !!f);
    const allForecasts = [...forecasts].sort((a, b) => {
      if (a.key !== b.key) return a.key ? -1 : 1;
      if (a.key && b.key) return KEY_TRAIT_CODES.indexOf(a.code) - KEY_TRAIT_CODES.indexOf(b.code);
      return (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name);
    });
    const lpiKey = byCode.get("LPI");
    const lpiDelta = lpiKey?.delta ?? null;
    const confidence = confidenceOf(x.rounds.length, rel, targetIsApril);

    const drivers: string[] = [];
    if (targetIsApril) {
      drivers.push(
        !breedCode ? "April base change ahead — breed not in the published table, estimated from past Aprils"
        : hasPublished(targetYear) ? `April base change applied (Lactanet published ${targetYear}, ${breedCode})`
        : `April base change ahead — ${targetYear} not published yet, using the ${LATEST_PUBLISHED_YEAR} table (${breedCode})`,
      );
    } else {
      const lpiAn = byCode.get("LPI");
      drivers.push(
        lpiAn?.neighbours
          ? `confidence from ${lpiAn.neighbours} bulls at the same career stage`
          : "ordinary round — no base change; best estimate is the current proof",
      );
      drivers.push("projection carried forward — direction is not forecastable");
    }
    // Reliability GROWTH is what predicts movement — the level barely does.
    if (relGrowth != null && relGrowth > 0.03) drivers.push("reliability climbing fast — expect a bigger move");
    else if (relGrowth != null && relGrowth > 0.01) drivers.push("reliability rising — wider range");
    else if (relGrowth != null && relGrowth <= 0.001) drivers.push("reliability settled — tighter range");
    if (rel != null && rel >= 0.9) drivers.push("high reliability proof");
    if (x.rounds.length <= 2) drivers.push("only two rounds on file — thin history");

    return {
      id: x.b.id, name: x.b.primaryName, shortName: x.b.shortName, breed: x.b.breed?.breedName ?? null,
      naab: x.b.identifiers.find((i) => i.idType === "naab")?.idValue ?? null,
      reg: x.b.identifiers.find((i) => i.isPrimary)?.idValue ?? null,
      forecast: {
        found: true, fromRun: last.run, roundsOnFile: x.rounds.length, reliability: rel, confidence,
        keyForecasts, allForecasts, lpiDelta,
        direction: lpiDelta == null || Math.abs(lpiDelta) < 1 ? "hold" : lpiDelta > 0 ? "up" : "down",
        summary: buildSummary(keyForecasts), drivers,
        expectedLpiMove: lpiKey?.expectedMove ?? null,
        lpiConfidence: lpiKey?.confidence ?? null,
        confidencePct: (() => {
          const cs = keyForecasts.map((k) => k.confidence).filter((v): v is number => v != null);
          return cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : null;
        })(),
        // Filled in below, once the whole lineup is known.
        exposure: null,
        exposureBand: null,
      },
    };
  });

  // Exposure is relative: "likely to move more than the rest of this lineup".
  // It can only be worked out once every bull has been projected, so it is a
  // second pass rather than part of the map above.
  const exposures = rows
    .map((r) => r.forecast.expectedLpiMove)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  for (const r of rows) {
    const e = r.forecast.expectedLpiMove;
    if (e == null || exposures.length < 4) continue;
    const below = exposures.filter((v) => v < e).length;
    const pct = Math.round((below / (exposures.length - 1)) * 100);
    r.forecast.exposure = Math.max(0, Math.min(100, pct));
    r.forecast.exposureBand = pct >= 75 ? "exposed" : pct <= 25 ? "steady" : "typical";
  }

  // --- "Sires that move like him" (only when a bull has been asked about) ---
  // Built from `analogueBulls`, which is the same decoded history the forecast
  // already ran on — no extra query, and the cohort it residualises against is
  // exactly the lineup named by `cohortLabel`.
  const similarFor = (sp.similar ?? "").trim() || null;
  const similarTrait = similarTraitCodes(sp.simTrait).key;
  const similarMode = parseMode(sp.simMode);
  const similar = similarFor
    ? buildSimilarPanel(
        analogueBulls,
        new Map(rows.map((r) => [r.id, { name: r.name, naab: r.naab, breed: r.breed }])),
        similarFor,
        sp.simTrait,
        sp.simMode,
      )
    : null;

  // --- Backtest: re-predict the most recent round from history only ---
  const backtest = runBacktest(decoded, codes);
  // …and score the RANGE, which is the part the model genuinely forecasts.
  if (!targetIsApril) {
    // Key on everything that could change the answer: which bulls, how many
    // rounds, and the newest round on file. An import moves at least one.
    const cacheKey = [
      blondin,
      analogueBulls.length,
      analogueBulls.reduce((s, b) => s + b.rounds.length, 0),
      latestDate.getTime(),
    ].join("|");
    const range = cachedRangeBacktest(analogueBulls, corpus, cacheKey);
    let wSkill = 0, wN = 0;
    for (const t of backtest.traits) {
      const r = range.get(t.code);
      if (!r) continue;
      t.crps = Math.round(r.crps * 10000) / 10000;
      t.cohortCrps = Math.round(r.cohortCrps * 10000) / 10000;
      t.rangeSkill = Math.round(r.rangeSkill * 10) / 10;
      t.coverage = Math.round(r.coverage * 10) / 10;
      t.zeroShare = Math.round(r.zeroShare * 10) / 10;
      t.rangeN = r.n;
      wSkill += r.rangeSkill * r.n; wN += r.n;
    }
    backtest.overallRangeSkill = wN ? Math.round((wSkill / wN) * 10) / 10 : null;
    const covN = backtest.traits.filter((t) => t.rangeN > 0);
    if (covN.length) {
      backtest.overallCoverage = Math.round(
        (covN.reduce((s, t) => s + t.coverage * t.rangeN, 0) / covN.reduce((s, t) => s + t.rangeN, 0)) * 10,
      ) / 10;
    }
  }

  // --- How the lineup behaves on this kind of round ---
  // The forecastable part, and what the report leads with instead of a column
  // of zeroes: how often a bull moves at all, and by how much.
  const movement = KEY_TRAITS.map((t) => {
    const f = cohortFacts(corpus, t.code, targetKind);
    if (!f) return null;
    return {
      code: t.code, label: t.label,
      movedShare: Math.round((1 - f.zeroShare) * 1000) / 10,
      typicalMove: Math.round(f.typicalMove * 100) / 100,
      material: Math.round(f.material * 100) / 100,
      n: f.n,
    };
  }).filter((m): m is NonNullable<typeof m> => m != null);

  // --- Filters / sort ---
  const breeds = [...new Set(rows.map((r) => r.breed).filter((b): b is string => !!b))].sort();
  const q = (sp.q ?? "").trim();
  const breed = (sp.breed ?? "").trim();
  const minConfidence = ["high", "medium"].includes(sp.conf ?? "") ? (sp.conf as string) : "";
  let filtered = rows;
  if (q) {
    const ql = q.toLowerCase();
    filtered = filtered.filter((r) => r.name.toLowerCase().includes(ql) || (r.naab ?? "").toLowerCase().includes(ql) || (r.reg ?? "").toLowerCase().includes(ql) || (r.shortName ?? "").toLowerCase().includes(ql));
  }
  if (breed) filtered = filtered.filter((r) => r.breed === breed);
  if (minConfidence === "high") filtered = filtered.filter((r) => r.forecast.confidence === "high");
  else if (minConfidence === "medium") filtered = filtered.filter((r) => r.forecast.confidence !== "low");

  // Default to confidence. Sorting by projected change was the old default and
  // is meaningless outside an April, where every projected change is zero
  // because direction is not forecastable.
  const sort = SORTABLE.has((sp.sort ?? "").toLowerCase())
    ? (sp.sort as string).toLowerCase()
    : (targetIsApril ? "lpi" : "certainty");
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const rank = { high: 3, medium: 2, low: 1 } as const;
  if (sort === "name") {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name) * (dir === "asc" ? 1 : -1));
  } else {
    // A trait column sorts by the figure it actually displays — the projected
    // value — exactly as the change reports sort by the change they display.
    const val = (r: ForecastRow): number | null =>
      sort === "certainty" ? r.forecast.confidencePct
      : sort === "confidence" ? rank[r.forecast.confidence]
      : r.forecast.allForecasts.find((t) => t.code === sort.toUpperCase())?.predicted ?? null;
    filtered = [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "asc" ? av - bv : bv - av;
    });
  }

  const lpiDeltas = rows.map((r) => r.forecast.lpiDelta).filter((v): v is number => v != null);
  const cohortLabel = blondinFilter && (blondin === "1" || blondin === "only") ? "the Blondin lineup" : blondinFilter ? "the non-Blondin lineup" : "the whole lineup";

  return {
    rows: filtered,
    compared: rows.length,
    totalNaab: bulls.length,
    notComparable: bulls.length - rows.length,
    breeds, targetLabel, targetIsApril, targetIsOfficial: isOfficialProof(target),
    basePublished: targetIsApril && hasPublished(targetYear),
    latestLabel,
    backtest,
    risers: rows.filter((r) => r.forecast.direction === "up").length,
    fallers: rows.filter((r) => r.forecast.direction === "down").length,
    avgLpiDelta: lpiDeltas.length ? Math.round((lpiDeltas.reduce((s, v) => s + v, 0) / lpiDeltas.length) * 10) / 10 : null,
    movement,
    lowConfidence: rows.filter((r) => r.forecast.lpiConfidence != null && r.forecast.lpiConfidence < 0.5).length,
    avgLpiConfidence: (() => {
      const cs = rows.map((r) => r.forecast.lpiConfidence).filter((v): v is number => v != null);
      return cs.length ? Math.round((cs.reduce((s, v) => s + v, 0) / cs.length) * 100) : null;
    })(),
    target: "",
    targetKind,
    q, breed, sort, dir, blondin, cohortLabel, cohortN: rows.length, minConfidence,
    similar, similarFor, similarTrait, similarMode,
  };
}

/**
 * What to say about a bull when the direction of his next round is unknowable.
 *
 * The old wording here was "No material change projected", which was true of the
 * point estimate and badly misleading: on an official round 84% of bulls move on
 * LPI, by 14 points on average. The honest summary is how far he is likely to
 * move and how the odds sit, which is the part that IS forecastable.
 */
function buildSummary(keys: TraitForecast[]): string {
  // Where an April base change is being applied there IS a directional number.
  const shifted = keys.filter((c) => c.delta != null && Math.abs(c.delta) > 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 3)
    .map((c) => `${c.name} ${c.delta! > 0 ? "+" : ""}${c.delta}`);
  if (shifted.length) return shifted.join(", ");

  const lpi = keys.find((c) => c.code === "LPI");
  if (lpi?.predicted != null && lpi.confidence != null) {
    return `LPI projected ${lpi.predicted} · ${Math.round(lpi.confidence * 100)}% confidence`;
  }
  return "Projection carried forward — direction not forecastable";
}

/**
 * Hold out each bull's most recent round, predict it from everything before,
 * and score the result against both the truth and a naive "no change" rule.
 *
 * This is the honesty check: it is measured on real rounds, and the numbers it
 * produces are printed on the report so a projection is never read as fact.
 */
export function runBacktest(
  decoded: { rounds: { date: Date; reliability: number | null; traits: Map<string, number>; runKind?: string | null }[] }[],
  codes: Set<string>,
  params: ModelParams = DEFAULT_PARAMS,
): Backtest {
  // Need 3 rounds: at least 2 to learn from, 1 to predict.
  const usable = decoded.filter((x) => x.rounds.length >= 3);
  if (usable.length < MIN_COHORT_OBS) {
    return { ran: false, bulls: usable.length, roundLabel: null, traits: [], overallSkill: null, overallCoverage: null, overallRangeSkill: null, rangeRounds: BACKTEST_ROUNDS };
  }

  // Train on history only — the held-out round must not inform the stats.
  const trainingSet = usable.map((x) => ({ rounds: x.rounds.slice(0, -1) }));
  const trainLatest = trainingSet.flatMap((x) => x.rounds.map((r) => r.date)).reduce((a, b) => (a > b ? a : b), new Date(0));
  const stats = buildTraitStats(trainingSet, codes, sinceWindow(trainLatest, params.recentMonths));

  const acc = new Map<string, { err: number[]; naive: number[]; hit: number }>();
  let latestHeld: Date | null = null;

  for (const x of usable) {
    const history = x.rounds.slice(0, -1);
    const actualRound = x.rounds[x.rounds.length - 1];
    if (!latestHeld || actualRound.date > latestHeld) latestHeld = actualRound.date;
    const rel = history[history.length - 1].reliability;
    const relPrev = history[history.length - 2]?.reliability;
    const relGrowth = rel != null && relPrev != null ? rel - relPrev : null;
    const isApril = isRollbackRound(actualRound.date);

    for (const kt of KEY_TRAITS) {
      const actual = actualRound.traits.get(kt.code);
      if (actual == null) continue;
      const obs = seriesOf(history, kt.code);
      if (obs.length === 0) continue;
      const p = projectTrait(obs, stats.get(kt.code), { targetIsApril: isApril, targetKind: roundKind(actualRound.date, actualRound.runKind), reliability: rel, relGrowth, params });
      if (!p) continue;
      const a = acc.get(kt.code) ?? { err: [], naive: [], hit: 0 };
      a.err.push(Math.abs(p.predicted - actual));
      a.naive.push(Math.abs(obs[obs.length - 1].value - actual));
      if (actual >= p.lo && actual <= p.hi) a.hit++;
      acc.set(kt.code, a);
    }
  }

  const traits: BacktestTrait[] = [];
  for (const kt of KEY_TRAITS) {
    const a = acc.get(kt.code);
    if (!a || a.err.length === 0) continue;
    const mae = a.err.reduce((s, v) => s + v, 0) / a.err.length;
    const naiveMae = a.naive.reduce((s, v) => s + v, 0) / a.naive.length;
    traits.push({
      code: kt.code, label: kt.label, n: a.err.length,
      mae: Math.round(mae * 100) / 100,
      naiveMae: Math.round(naiveMae * 100) / 100,
      skill: naiveMae > 0 ? Math.round(((naiveMae - mae) / naiveMae) * 1000) / 10 : 0,
      coverage: Math.round((a.hit / a.err.length) * 1000) / 10,
      // Filled in by the range backtest, which scores what the model really
      // predicts. Left at zero when it cannot run.
      crps: 0, cohortCrps: 0, rangeSkill: 0, rangeN: 0, zeroShare: 0,
    });
  }

  const totalN = traits.reduce((s, t) => s + t.n, 0);
  return {
    ran: traits.length > 0,
    bulls: usable.length,
    roundLabel: latestHeld ? periodLabelOf(latestHeld) : null,
    traits,
    overallSkill: totalN ? Math.round((traits.reduce((s, t) => s + t.skill * t.n, 0) / totalN) * 10) / 10 : null,
    overallCoverage: totalN ? Math.round((traits.reduce((s, t) => s + t.coverage * t.n, 0) / totalN) * 10) / 10 : null,
    overallRangeSkill: null,
    rangeRounds: BACKTEST_ROUNDS,
  };
}

/**
 * Rounds held out per bull when measuring the range. One round across 138 bulls
 * gives a per-trait sample too small to read — traits that barely move swing
 * several percent on noise alone. Six rounds is enough to be stable without
 * making the page wait.
 */
const BACKTEST_ROUNDS = 6;

/** Mean quantile (pinball) loss — CRPS, approximated on the published levels. */
function crpsOf(actual: number, quantiles: number[]): number {
  let s = 0;
  for (let i = 0; i < QUANTILES.length; i++) {
    const q = QUANTILES[i], pred = quantiles[i];
    s += actual >= pred ? q * (actual - pred) : (1 - q) * (pred - actual);
  }
  return s / QUANTILES.length;
}

/**
 * Score the RANGE, which is what this model actually forecasts.
 *
 * Every bull's most recent round is held out and predicted from the rounds
 * before it, through the same code path the live report uses. The comparator is
 * the cohort-wide band this report used to publish, built from the same earlier
 * rounds — so the number answers "is the analogue band better than what we had".
 *
 * CRPS is used rather than coverage because coverage alone rewards a band for
 * being wide. CRPS penalises both missing and hedging.
 */
function runRangeBacktest(
  bulls: AnalogueBull[],
  corpus: Corpus,
): Map<string, { crps: number; cohortCrps: number; rangeSkill: number; coverage: number; zeroShare: number; n: number }> {
  const out = new Map<string, { crps: number; cohortCrps: number; rangeSkill: number; coverage: number; zeroShare: number; n: number }>();

  // Every observed move, with its time and kind, so the comparator can be built
  // from strictly earlier rounds only.
  const movesByTrait = new Map<string, { time: number; kind: RoundKind; move: number }[]>();
  for (const code of KEY_TRAIT_CODES) {
    const arr: { time: number; kind: RoundKind; move: number }[] = [];
    for (const b of bulls) {
      for (let i = 1; i < b.rounds.length; i++) {
        if (b.rounds[i].kind === "april") continue;
        const p = b.rounds[i - 1].traits.get(code), q = b.rounds[i].traits.get(code);
        if (p != null && q != null) arr.push({ time: b.rounds[i].time, kind: b.rounds[i].kind, move: q - p });
      }
    }
    movesByTrait.set(code, arr);
  }

  // The comparator depends only on (trait, round, kind) — never on the bull —
  // and every bull's held-out rounds land on the same handful of dates, so each
  // one is built once instead of once per bull.
  const cohortQs = new Map<string, number[] | null>();
  const cohortAt = (code: string, time: number, kind: RoundKind): number[] | null => {
    const key = `${code}|${time}|${kind}`;
    const cached = cohortQs.get(key);
    if (cached !== undefined) return cached;
    const all = movesByTrait.get(code) ?? [];
    const earlier = all.filter((m) => m.time < time && m.kind === kind).map((m) => m.move).sort((x, y) => x - y);
    const v = earlier.length < MIN_COHORT_OBS ? null : QUANTILES.map((q) => quantileOf(earlier, q));
    cohortQs.set(key, v);
    return v;
  };

  const acc = new Map<string, { a: number; c: number; hit: number; zero: number; n: number }>();
  for (const code of KEY_TRAIT_CODES) acc.set(code, { a: 0, c: 0, hit: 0, zero: 0, n: 0 });

  // Bulls outer, traits inner: a bull's step series is shared by all nine traits,
  // so it is built once per bull rather than once per (bull, round, trait).
  for (const b of bulls) {
    // Hold out the last few rounds rather than only the newest: one round across
    // 138 bulls is too small a sample for a per-trait figure to be stable.
    if (b.rounds.length < 3) continue;
    const steps = stepsFor(corpus, b);
    const from = Math.max(1, b.rounds.length - BACKTEST_ROUNDS);
    for (let i = from; i < b.rounds.length; i++) {
      const cur = b.rounds[i];
      if (cur.kind === "april") continue;
      for (const code of KEY_TRAIT_CODES) {
        const last = b.rounds[i - 1].traits.get(code);
        const actual = cur.traits.get(code);
        if (last == null || actual == null) continue;

        const f = forecastTrait(corpus, code, b, cur.kind, cur.time, { stepsCache: steps, historyLength: i });
        if (!f) continue;
        const cq = cohortAt(code, cur.time, cur.kind);
        if (!cq) continue;

        const s = acc.get(code)!;
        s.a += crpsOf(actual, f.quantiles);
        s.c += crpsOf(actual, cq.map((v) => last + v));
        if (actual >= f.lo && actual <= f.hi) s.hit++;
        if (actual === last) s.zero++;
        s.n++;
      }
    }
  }

  for (const [code, s] of acc) {
    if (!s.n) continue;
    const a = s.a / s.n, c = s.c / s.n;
    out.set(code, {
      crps: a, cohortCrps: c,
      rangeSkill: c > 0 ? ((c - a) / c) * 100 : 0,
      coverage: (s.hit / s.n) * 100,
      zeroShare: (s.zero / s.n) * 100,
      n: s.n,
    });
  }
  return out;
}

/**
 * The range backtest depends only on which bulls and rounds are on file, never
 * on the report's filters or sort — and it is by far the most expensive part of
 * the page. Memoise it so that sorting, filtering and paging are instant, and
 * invalidate whenever the underlying data changes.
 */
let rangeCache: { key: string; value: ReturnType<typeof runRangeBacktest> } | null = null;

function cachedRangeBacktest(bulls: AnalogueBull[], corpus: Corpus, key: string) {
  if (rangeCache && rangeCache.key === key) return rangeCache.value;
  const value = runRangeBacktest(bulls, corpus);
  rangeCache = { key, value };
  return value;
}
