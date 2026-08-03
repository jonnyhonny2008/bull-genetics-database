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
import { blondinWhere } from "./sire-class";
import { isRollbackRound, isOfficialProof } from "./rollback";
import { unpackTraits, traitDefMap } from "./eval-traits";
import { breedCodeOf, projectedShift, fallbackShift, hasPublished, LATEST_PUBLISHED_YEAR } from "./base-change";
import { KEY_TRAITS, KEY_TRAIT_CODES, periodKey, traitStdStats, type ProofPeriod } from "./proof-change";

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
  basis: "trend" | "hold" | "regression" | "base change";
  /** Observed steps behind the bull's trend term. */
  steps: number;
}

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
}

export interface Backtest {
  ran: boolean;
  bulls: number;
  roundLabel: string | null;
  traits: BacktestTrait[];
  /** Weighted overall skill across the key traits. */
  overallSkill: number | null;
  overallCoverage: number | null;
}

export interface TrendPoint {
  label: string;
  value: number | null;
  projected: boolean;
  bulls: number;
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
  periods: ProofPeriod[];
  /** Lineup-average history of the charted trait, plus the projected point. */
  trend: TrendPoint[];
  chartTrait: { code: string; label: string };
  backtest: Backtest;
  risers: number;
  fallers: number;
  avgLpiDelta: number | null;
  // filters / state
  /** "" = next round on cadence, "april" = the next base change. */
  target: string;
  q: string;
  breed: string;
  sort: string;
  dir: "asc" | "desc";
  blondin: string;
  cohortLabel: string;
  cohortN: number;
  minConfidence: string;
  /** Single-bull focus (set when ?bull=<id> resolves), for the full profile view. */
  focus: ForecastRow | null;
  focusSeries: { code: string; label: string; points: { label: string; value: number | null }[]; predicted: number | null; lo: number | null; hi: number | null }[];
}

interface EvalLite {
  proofRun: string | null;
  evaluationDate: Date;
  traitsJson: string | null;
  reliabilityOverall: number | null;
}

/** One trait's observed history for a bull: value per round, oldest first. */
interface Obs { date: Date; value: number }

/** Cohort-level statistics per trait, learned from the whole reported lineup. */
export interface TraitStats {
  /** Mean of the most recent value across bulls — the regression target. */
  level: number;
  /** Mean/SD of every consecutive round-to-round change. */
  drift: { mean: number; sd: number; n: number };
  /** Mean change on steps that LAND on an April round (the base change). */
  aprilMean: number;
  aprilN: number;
  /** Mean change on steps that do not land on April. */
  ordinaryMean: number;
  ordinaryN: number;
}

/** Extract one trait's ordered observations from a bull's rounds. */
function seriesOf(rounds: { date: Date; traits: Map<string, number> }[], code: string): Obs[] {
  const out: Obs[] = [];
  for (const r of rounds) {
    const v = r.traits.get(code);
    if (v != null && Number.isFinite(v)) out.push({ date: r.date, value: v });
  }
  return out;
}

/** Consecutive changes, tagged with whether the LATER round is an April. */
function deltasOf(obs: Obs[]): { d: number; april: boolean; at: Date }[] {
  const out: { d: number; april: boolean; at: Date }[] = [];
  for (let i = 1; i < obs.length; i++) out.push({ d: obs[i].value - obs[i - 1].value, april: isRollbackRound(obs[i].date), at: obs[i].date });
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
  bulls: { rounds: { date: Date; traits: Map<string, number> }[] }[],
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
    for (const b of bulls) {
      const obs = seriesOf(b.rounds, code);
      if (obs.length) levels.push(obs[obs.length - 1].value);
      for (const { d, april: isApr, at } of deltasOf(obs)) {
        if (cutoff != null && at.getTime() < cutoff) continue;
        all.push(d);
        (isApr ? april : ordinary).push(d);
      }
    }
    if (!levels.length) continue;
    const drift = traitStdStats(all);
    out.set(code, {
      level: levels.reduce((s, v) => s + v, 0) / levels.length,
      drift,
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
  opts: { targetIsApril: boolean; reliability: number | null; params?: ModelParams; publishedShift?: number | null },
): { predicted: number; lo: number; hi: number; basis: TraitForecast["basis"]; steps: number } | null {
  if (obs.length === 0) return null;
  const P = opts.params ?? DEFAULT_PARAMS;
  const last = obs[obs.length - 1].value;
  const deltas = deltasOf(obs);
  const rel = opts.reliability ?? DEFAULT_RELIABILITY;

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
  const cohortSd = stats && stats.drift.n >= MIN_COHORT_OBS ? stats.drift.sd : 0;
  const bullSd = deltas.length >= 3 ? traitStdStats(deltas.map((x) => x.d)).sd : 0;
  const sigma = cohortSd > 0 ? cohortSd : bullSd;
  const half = Z80 * sigma;
  void rel;

  const basis: TraitForecast["basis"] =
    usedPublished ? "base change"
    : deltas.length === 0 ? "hold"
    : Math.abs(pull) > Math.abs(deviation) ? "regression"
    : Math.abs(deviation) > 0 ? "trend"
    : systematic !== 0 ? "base change" : "hold";

  return { predicted: round2(predicted), lo: round2(predicted - half), hi: round2(predicted + half), basis, steps: deltas.length };
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

/** Cutoff date for "recent" steps, or undefined to use all history. */
function sinceWindow(latest: Date, months: number | null): Date | undefined {
  if (months == null) return undefined;
  return new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() - months, 1));
}

const SORTABLE = new Set(["lpi", "conf", "name", "confidence", ...KEY_TRAIT_CODES.map((c) => c.toLowerCase())]);

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
      id: true, primaryName: true, shortName: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true }, select: { idType: true, idValue: true, isPrimary: true } },
      evaluations: { orderBy: { evaluationDate: "asc" }, select: { proofRun: true, evaluationDate: true, traitsJson: true, reliabilityOverall: true } },
    },
  } satisfies Prisma.AnimalFindManyArgs);

  // Decode every round once: date + a code→value map, oldest first.
  const decoded = bulls.map((b) => ({
    b,
    rounds: (b.evaluations as EvalLite[]).map((e) => ({
      date: e.evaluationDate,
      run: e.proofRun,
      reliability: e.reliabilityOverall,
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
  const periods: ProofPeriod[] = [...periodMap.entries()]
    .map(([key, v]) => ({ key, label: periodLabelOf(v.date), official: isOfficialProof(v.date), bulls: v.bulls }))
    .sort((a, b) => b.key.localeCompare(a.key));

  const allDates = [...periodMap.values()].map((v) => v.date);
  // Default target is simply the next round on the observed cadence. Choosing
  // "april" jumps to the next base change instead — the round people actually
  // want to see coming, since it is the only one that moves everyone at once.
  const wantApril = sp.target === "april";
  const nextByCadence = allDates.length ? nextPeriod(allDates) : new Date();
  const latestOnFile = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : new Date();
  const nextApril = new Date(Date.UTC(
    latestOnFile.getUTCFullYear() + (latestOnFile.getUTCMonth() >= 3 ? 1 : 0), 3, 1,
  ));
  const target = wantApril ? nextApril : nextByCadence;
  const targetIsApril = isRollbackRound(target);
  const targetLabel = periodLabelOf(target);
  const latestLabel = periods[0]?.label ?? null;

  // Every trait code present anywhere — index traits AND linear/type traits, so
  // the per-bull view can project a complete profile.
  const codes = new Set<string>();
  for (const x of decoded) for (const r of x.rounds) for (const c of r.traits.keys()) codes.add(c);

  const latestDate = allDates.length ? allDates.reduce((a, b) => (a > b ? a : b)) : new Date();
  const stats = buildTraitStats(decoded, codes, sinceWindow(latestDate, DEFAULT_PARAMS.recentMonths));

  // --- Project every bull ---
  const targetYear = target.getUTCFullYear();
  const rows: ForecastRow[] = decoded.map((x) => {
    const last = x.rounds[x.rounds.length - 1];
    const rel = last.reliability;
    // Published base changes are per breed, so resolve the bull's breed once.
    const breedCode = breedCodeOf(x.b.breed?.breedName ?? null);
    const forecasts: TraitForecast[] = [];
    for (const code of codes) {
      const obs = seriesOf(x.rounds, code);
      if (obs.length === 0) continue;
      // The target April's own published table if we have it; otherwise the most
      // recent published one, which still carries the structural facts (LPI = 0).
      const publishedShift = targetIsApril
        ? projectedShift(targetYear, code, breedCode) ?? fallbackShift(code, breedCode)
        : null;
      const p = projectTrait(obs, stats.get(code), { targetIsApril, reliability: rel, publishedShift });
      if (!p) continue;
      const def = defMap.get(code);
      const current = obs[obs.length - 1].value;
      forecasts.push({
        code,
        name: KEY_TRAITS.find((k) => k.code === code)?.label ?? def?.name ?? code,
        category: def?.category ?? null,
        key: KEY_TRAIT_CODES.includes(code),
        current, predicted: p.predicted, delta: round2(p.predicted - current),
        lo: p.lo, hi: p.hi, basis: p.basis, steps: p.steps,
      });
    }
    const byCode = new Map(forecasts.map((f) => [f.code, f]));
    const keyForecasts = KEY_TRAITS.map((k) => byCode.get(k.code)).filter((f): f is TraitForecast => !!f);
    const allForecasts = [...forecasts].sort((a, b) => {
      if (a.key !== b.key) return a.key ? -1 : 1;
      if (a.key && b.key) return KEY_TRAIT_CODES.indexOf(a.code) - KEY_TRAIT_CODES.indexOf(b.code);
      return (a.category ?? "").localeCompare(b.category ?? "") || a.name.localeCompare(b.name);
    });
    const lpiDelta = byCode.get("LPI")?.delta ?? null;
    const confidence = confidenceOf(x.rounds.length, rel, targetIsApril);

    const drivers: string[] = [];
    if (targetIsApril) {
      drivers.push(
        !breedCode ? "April base change ahead — breed not in the published table, estimated from past Aprils"
        : hasPublished(targetYear) ? `April base change applied (Lactanet published ${targetYear}, ${breedCode})`
        : `April base change ahead — ${targetYear} not published yet, using the ${LATEST_PUBLISHED_YEAR} table (${breedCode})`,
      );
    } else {
      drivers.push("ordinary round — no base change; best estimate is the current proof");
    }
    if (rel != null && rel >= 0.9) drivers.push("high reliability — proof is stable");
    else if (rel != null && rel < 0.75) drivers.push("low reliability — wider range");
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
      },
    };
  });

  // --- Backtest: re-predict the most recent round from history only ---
  const backtest = runBacktest(decoded, codes);

  // --- Lineup trend for the chart (average of the charted trait per round) ---
  const chartCode = (sp.ctrait ?? "LPI").toUpperCase();
  const chartTrait = KEY_TRAITS.find((t) => t.code === chartCode) ?? KEY_TRAITS.find((t) => t.code === "LPI")!;
  const perPeriod = new Map<string, { sum: number; n: number; date: Date }>();
  for (const x of decoded) {
    for (const r of x.rounds) {
      const v = r.traits.get(chartTrait.code);
      if (v == null) continue;
      const k = periodKey(r.date);
      const e = perPeriod.get(k);
      if (e) { e.sum += v; e.n++; } else perPeriod.set(k, { sum: v, n: 1, date: r.date });
    }
  }
  const history = [...perPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([, v]) => ({ label: periodLabelOf(v.date), value: Math.round((v.sum / v.n) * 10) / 10, projected: false, bulls: v.n }));
  const projRows = rows.map((r) => r.forecast.allForecasts.find((f) => f.code === chartTrait.code)?.predicted).filter((v): v is number => v != null);
  const trend: TrendPoint[] = [...history];
  if (projRows.length) {
    trend.push({ label: targetLabel, value: Math.round((projRows.reduce((s, v) => s + v, 0) / projRows.length) * 10) / 10, projected: true, bulls: projRows.length });
  }

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

  const sort = SORTABLE.has((sp.sort ?? "").toLowerCase()) ? (sp.sort as string).toLowerCase() : "lpi";
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const rank = { high: 3, medium: 2, low: 1 } as const;
  if (sort === "name") {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name) * (dir === "asc" ? 1 : -1));
  } else {
    const val = (r: ForecastRow): number | null =>
      sort === "confidence" ? rank[r.forecast.confidence]
      : r.forecast.allForecasts.find((f) => f.code === sort.toUpperCase())?.delta ?? null;
    filtered = [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir === "asc" ? av - bv : bv - av;
    });
  }

  // --- Single-bull focus: the full projected profile for one bull ---
  const focusId = (sp.bull ?? "").trim();
  const focus = focusId ? rows.find((r) => r.id === focusId) ?? null : null;
  const focusSeries: ForecastReport["focusSeries"] = [];
  if (focus) {
    const src = decoded.find((d) => d.b.id === focus.id);
    if (src) {
      for (const kt of KEY_TRAITS) {
        const obs = seriesOf(src.rounds, kt.code);
        if (obs.length === 0) continue;
        const f = focus.forecast.allForecasts.find((x) => x.code === kt.code);
        focusSeries.push({
          code: kt.code, label: kt.label,
          points: obs.slice(-10).map((o) => ({ label: periodLabelOf(o.date), value: o.value })),
          predicted: f?.predicted ?? null, lo: f?.lo ?? null, hi: f?.hi ?? null,
        });
      }
    }
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
    latestLabel, periods,
    trend, chartTrait: { code: chartTrait.code, label: chartTrait.label },
    backtest,
    risers: rows.filter((r) => r.forecast.direction === "up").length,
    fallers: rows.filter((r) => r.forecast.direction === "down").length,
    avgLpiDelta: lpiDeltas.length ? Math.round((lpiDeltas.reduce((s, v) => s + v, 0) / lpiDeltas.length) * 10) / 10 : null,
    target: wantApril ? "april" : "",
    q, breed, sort, dir, blondin, cohortLabel, cohortN: rows.length, minConfidence,
    focus, focusSeries,
  };
}

function buildSummary(keys: TraitForecast[]): string {
  const moved = keys.filter((c) => c.delta != null && Math.abs(c.delta) > 0)
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)).slice(0, 3)
    .map((c) => `${c.name} ${c.delta! > 0 ? "+" : ""}${c.delta}`);
  return moved.length ? moved.join(", ") : "No material change projected";
}

/**
 * Hold out each bull's most recent round, predict it from everything before,
 * and score the result against both the truth and a naive "no change" rule.
 *
 * This is the honesty check: it is measured on real rounds, and the numbers it
 * produces are printed on the report so a projection is never read as fact.
 */
export function runBacktest(
  decoded: { rounds: { date: Date; reliability: number | null; traits: Map<string, number> }[] }[],
  codes: Set<string>,
  params: ModelParams = DEFAULT_PARAMS,
): Backtest {
  // Need 3 rounds: at least 2 to learn from, 1 to predict.
  const usable = decoded.filter((x) => x.rounds.length >= 3);
  if (usable.length < MIN_COHORT_OBS) {
    return { ran: false, bulls: usable.length, roundLabel: null, traits: [], overallSkill: null, overallCoverage: null };
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
    const isApril = isRollbackRound(actualRound.date);

    for (const kt of KEY_TRAITS) {
      const actual = actualRound.traits.get(kt.code);
      if (actual == null) continue;
      const obs = seriesOf(history, kt.code);
      if (obs.length === 0) continue;
      const p = projectTrait(obs, stats.get(kt.code), { targetIsApril: isApril, reliability: rel, params });
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
  };
}
