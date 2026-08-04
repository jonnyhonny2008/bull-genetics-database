// ---------------------------------------------------------------------------
// Two separate measures of how a bull holds his numbers. They answer different
// questions and must not be conflated.
//
//   PROOF PERFORMANCE  (0–100, absolute)
//     Every consecutive pair of proof rounds. For each trait, how much the bull
//     carried into the next round:  retention = clamp(100 + %change, 0, 100).
//     Holding or gaining scores 100; a step that halves the value scores 50.
//     Averaged over every step, then weighted across traits.
//
//     This replaces a first-round-to-last-round comparison, which measured the
//     wrong thing: every bull drifts over a long enough career, so an old bull
//     with 60 rounds always looked worse than a young sire with 3. Step scoring
//     asks "did he hold from one round to the next", which is comparable no
//     matter how long he has been in the lineup.
//
//   ROLLBACK RESISTANCE  (base 100, comparative)
//     APRIL ROUNDS ONLY. Lactanet re-bases the genetic base every April, and
//     that is the round where a bull's numbers move for reasons other than new
//     data — the actual rollback. So this looks only at each step that LANDS on
//     an April round: the round before it versus the April round itself.
//
//     The result is then expressed the way Lactanet expresses health and
//     fertility traits: the ACTIVE LINEUP AVERAGE is defined as 100, and every
//     5 points is one standard deviation. 105 is one SD better at holding
//     through a base change than the lineup; 95 one SD worse. Because it is
//     relative, the size of any given April re-basing — which moves every bull
//     at once — cancels out, leaving only how this bull fared against his peers.
//
//   headline (first→last) is retained as a secondary "lifetime drift" figure.
// ---------------------------------------------------------------------------

export interface EvalLite {
  evaluationDate: Date;
  proofRun: string | null;
  reliabilityOverall: number | null;
  /** Which Lactanet file this row came from. Official wins a same-round tie. */
  runKind?: string | null;
  traitValues: { traitCode: string; numericValue: number | null }[];
}

/**
 * Collapse a bull's evaluations to ONE row per round, preferring the official
 * file over the interim one.
 *
 * Lactanet's official and interim files for a round share a GERUN, so both land
 * on the same proofRun label and the same evaluationDate. Left in, the pair
 * manufactures a phantom "step" between two versions of the same month — and
 * because 82 of 137 shared bulls differ between the files, that step carries a
 * real, spurious magnitude that pollutes every retention figure and can land in
 * the April bucket as fake rollback. Rollback measures change from one round to
 * the NEXT, never one file against the other, so the two must be reconciled to a
 * single canonical value (the official one where it exists) before stepping.
 */
export function canonicalRounds<T extends { proofRun: string | null; evaluationDate: Date; runKind?: string | null }>(evals: T[]): T[] {
  const kindRank = (k: string | null | undefined) => (k === "official" ? 0 : k === "interim" ? 1 : 2);
  const best = new Map<string, T>();
  for (const e of evals) {
    const key = e.proofRun ?? (e.evaluationDate ? e.evaluationDate.toISOString().slice(0, 7) : "?");
    const cur = best.get(key);
    if (!cur || kindRank(e.runKind) < kindRank(cur.runKind)) best.set(key, e);
  }
  return [...best.values()];
}

export interface TraitResistance {
  code: string;
  first: number;
  latest: number;
  delta: number;
  pctChange: number;
  /** First round → last round, 0–100. Lifetime drift. */
  resistance: number;
  /** Mean retention across ALL consecutive rounds, 0–100. Proof Performance. */
  stepResistance: number;
  /** Number of consecutive round pairs behind stepResistance. */
  steps: number;
  /** Mean retention across APRIL (base-change) rounds only, 0–100. Null if none. */
  rollbackResistance: number | null;
  /** Number of April steps behind rollbackResistance. */
  rollbackSteps: number;
  /** The single worst round-to-round retention seen, 0–100. */
  worstStep: number;
  series: (number | null)[]; // value per round, oldest→newest
}

export interface RollbackResult {
  rounds: { label: string; date: Date; reliability: number | null; isRollback: boolean }[];
  traits: Record<string, TraitResistance>;
  /** Weighted first→last score, 0–100 (secondary). */
  headline: number | null;
  /** PROOF PERFORMANCE — weighted mean retention over every round, 0–100. */
  proofPerformance: number | null;
  /** Consecutive round pairs evaluated for Proof Performance. */
  proofSteps: number;
  /** Raw April-only retention, 0–100. Feeds Rollback Resistance. Null if the bull has never been through an April. */
  rollbackRaw: number | null;
  /** April steps evaluated. */
  rollbackSteps: number;
  verdict: { label: string; tone: "good" | "warn" | "danger" | "slate" };
  progeny: "genomic" | "progeny" | "unknown";
  hasHistory: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Is this evaluation date an April (base-change / rollback) round?
 * evaluationDate is built from the file's GERUN (YYMM), so it is always the 1st
 * of the run's month in UTC — the month alone is authoritative.
 */
export function isRollbackRound(d: Date): boolean {
  return d.getUTCMonth() === 3; // 0-indexed: 3 = April
}

/**
 * Official proof rounds are April, August and December (Lactanet's three yearly
 * evaluation releases); every other month is an interim run. Month alone is
 * authoritative — evaluationDate is the 1st of the run's month in UTC.
 */
export function isOfficialProof(d: Date): boolean {
  const m = d.getUTCMonth();
  return m === 3 || m === 7 || m === 11; // April, August, December
}
export function proofKind(d: Date): "official" | "interim" {
  return isOfficialProof(d) ? "official" : "interim";
}

// Traits we score. The first five drive the headline; the rest feed the
// "remaining averaged" weight.
const HEADLINE_WEIGHTS: Record<string, number> = { LPI: 32, CONF: 22, MILK: 16, FAT: 8, PROT: 8 };
const OTHER_TRAITS = ["PRO$", "LTI", "HWI", "MAMM", "FL", "DS", "HL", "PROT", "PROTPCT", "FATPCT"];
const REMAINING_WEIGHT = 12;
const ALL_TRAITS = [...Object.keys(HEADLINE_WEIGHTS), ...OTHER_TRAITS.filter((t) => !(t in HEADLINE_WEIGHTS))];

function num(ev: EvalLite, code: string): number | null {
  const t = ev.traitValues.find((v) => v.traitCode === code);
  return t?.numericValue ?? null;
}

/** Percent change from `from` to `to`, guarding against a near-zero base. */
function pctChange(from: number, to: number): number {
  const base = Math.abs(from) < 1 ? 1 : Math.abs(from);
  return ((to - from) / base) * 100;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Blend per-trait scores into one weighted figure, or null if nothing scored. */
function weightedBlend(pick: (code: string) => number | null | undefined): number | null {
  let wSum = 0, wTotal = 0;
  for (const [code, w] of Object.entries(HEADLINE_WEIGHTS)) {
    const v = pick(code);
    if (v != null) { wSum += v * w; wTotal += w; }
  }
  const others = OTHER_TRAITS.map(pick).filter((r): r is number => r != null);
  if (others.length) {
    wSum += (mean(others)) * REMAINING_WEIGHT;
    wTotal += REMAINING_WEIGHT;
  }
  return wTotal ? wSum / wTotal : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeRollback(evals: EvalLite[]): RollbackResult {
  // One row per round (official over interim), then oldest→newest. The secondary
  // sort on run kind only breaks a same-date tie that canonicalRounds already
  // resolves; it is kept so ordering is deterministic even if a caller passes
  // rows that skipped the collapse.
  const kindRank = (k: string | null | undefined) => (k === "official" ? 0 : k === "interim" ? 1 : 2);
  const sorted = canonicalRounds(evals.filter((e) => e.evaluationDate))
    .sort((a, b) => a.evaluationDate.getTime() - b.evaluationDate.getTime() || kindRank(a.runKind) - kindRank(b.runKind));

  const rounds = sorted.map((e) => ({
    label: e.proofRun ?? e.evaluationDate.toISOString().slice(0, 7),
    date: e.evaluationDate,
    reliability: e.reliabilityOverall,
    isRollback: isRollbackRound(e.evaluationDate),
  }));

  if (sorted.length < 2) {
    return {
      rounds, traits: {}, headline: null, proofPerformance: null, proofSteps: 0,
      rollbackRaw: null, rollbackSteps: 0,
      verdict: { label: "Single proof round", tone: "slate" }, progeny: "unknown", hasHistory: false,
    };
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const traits: Record<string, TraitResistance> = {};
  let maxProofSteps = 0, maxRollbackSteps = 0;

  for (const code of ALL_TRAITS) {
    const series = sorted.map((e) => num(e, code));

    // Walk consecutive rounds. Only pairs where BOTH rounds carry the trait
    // count as a step, so a gap in the file does not read as a collapse.
    const allSteps: number[] = [];
    const aprilSteps: number[] = [];
    let prev: number | null = null;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v != null && prev != null) {
        const retention = clamp(100 + pctChange(prev, v), 0, 100);
        allSteps.push(retention);
        // A rollback step is one that LANDS on an April round: the round before
        // the base change versus the base change itself.
        if (isRollbackRound(sorted[i].evaluationDate)) aprilSteps.push(retention);
      }
      if (v != null) prev = v;
    }

    const f = num(first, code);
    const l = num(last, code);
    if (f === null || l === null || allSteps.length === 0) continue;

    maxProofSteps = Math.max(maxProofSteps, allSteps.length);
    maxRollbackSteps = Math.max(maxRollbackSteps, aprilSteps.length);
    traits[code] = {
      code, first: f, latest: l, delta: l - f, pctChange: pctChange(f, l),
      resistance: clamp(100 + pctChange(f, l), 0, 100),
      stepResistance: mean(allSteps),
      steps: allSteps.length,
      rollbackResistance: aprilSteps.length ? mean(aprilSteps) : null,
      rollbackSteps: aprilSteps.length,
      worstStep: Math.min(...allSteps),
      series,
    };
  }

  const headlineRaw = weightedBlend((c) => traits[c]?.resistance);
  const perfRaw = weightedBlend((c) => traits[c]?.stepResistance);
  const rbRaw = weightedBlend((c) => traits[c]?.rollbackResistance);

  // Kept to one decimal: step scores cluster tightly (most rounds barely move),
  // and rounding to an integer would collapse real differences before the
  // base-100 rating can spread them out again.
  const proofPerformance = perfRaw == null ? null : round1(perfRaw);
  const rollbackRaw = rbRaw == null ? null : round1(rbRaw);
  const headline = headlineRaw == null ? null : Math.round(headlineRaw);

  // Absolute verdict on Proof Performance, calibrated for step scores (which sit
  // far higher than first→last scores because most individual steps barely move).
  let verdict: RollbackResult["verdict"] = { label: "—", tone: "slate" };
  if (proofPerformance != null) {
    if (proofPerformance >= 99.5) verdict = { label: "Held strong across rounds", tone: "good" };
    else if (proofPerformance >= 98) verdict = { label: "Held well", tone: "good" };
    else if (proofPerformance >= 95) verdict = { label: "Some movement", tone: "warn" };
    else verdict = { label: "Moves a lot between rounds", tone: "danger" };
  }

  // Genomic re-eval vs progeny-driven: did reliability climb meaningfully?
  let progeny: RollbackResult["progeny"] = "unknown";
  if (first.reliabilityOverall != null && last.reliabilityOverall != null) {
    progeny = last.reliabilityOverall - first.reliabilityOverall >= 0.1 ? "progeny" : "genomic";
  }

  return {
    rounds, traits, headline, proofPerformance, proofSteps: maxProofSteps,
    rollbackRaw, rollbackSteps: maxRollbackSteps, verdict, progeny, hasHistory: true,
  };
}

// --- Rollback Resistance: the base-100 scale --------------------------------
// Same presentation Lactanet uses for health and fertility traits: the
// population average is 100 and one standard deviation is 5 points.

/** Points per standard deviation. Matches the health-trait convention. */
export const RATING_SD_POINTS = 5;

export interface Baseline {
  mean: number;
  sd: number;
  n: number;
}

/** Population mean and (population, not sample) standard deviation. */
export function baselineOf(values: number[]): Baseline {
  const n = values.length;
  if (n === 0) return { mean: 0, sd: 0, n: 0 };
  const m = mean(values);
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  return { mean: m, sd: Math.sqrt(variance), n };
}

/**
 * Place a raw April-only retention score on the base-100 Rollback Resistance
 * scale. 100 is the lineup average; every 5 points is one standard deviation.
 *
 * Clamped to 70–130 (±6 SD) so one freak bull cannot render the scale useless,
 * and returns exactly 100 when the population has no spread to measure.
 */
export function relativeRating(value: number, base: Baseline): number {
  if (!base.n || base.sd < 1e-9) return 100;
  return clamp(Math.round(100 + RATING_SD_POINTS * ((value - base.mean) / base.sd)), 70, 130);
}

// --- Cohort baselines: compare like with like -------------------------------
//
// A bull who has been through ONE April has one observation; a bull who has been
// through FIVE has five. Pooling them ranks thin records above long ones — the
// young sire simply has not had time to give anything back yet.
//
// So the baseline is stratified by April count: a 3-rollback bull is measured
// against the other 3-rollback bulls, a 5-rollback bull against the other
// 5-rollback bulls. Each cohort's own average becomes that cohort's 100, which
// removes the bias at source rather than correcting for it afterwards.

/** A cohort smaller than this has no usable mean or spread on its own. */
export const MIN_COHORT = 8;

/**
 * One baseline per April-step count. Cohorts too small to stand alone widen to
 * take in neighbouring step counts until they reach `minN` — a 6-rollback bull
 * with only three peers is better compared against the 5- and 7-rollback bulls
 * than against the whole lineup.
 */
export function buildCohortBaselines(
  entries: { steps: number; raw: number }[],
  minN: number = MIN_COHORT,
): Map<number, Baseline> {
  const byStep = new Map<number, number[]>();
  for (const e of entries) {
    const arr = byStep.get(e.steps) ?? [];
    arr.push(e.raw);
    byStep.set(e.steps, arr);
  }
  const steps = [...byStep.keys()].sort((a, b) => a - b);
  const span = steps.length ? steps[steps.length - 1] - steps[0] : 0;
  const out = new Map<number, Baseline>();

  for (const s of steps) {
    let pool = byStep.get(s) ?? [];
    for (let radius = 1; pool.length < minN && radius <= span; radius++) {
      pool = [];
      for (const [k, v] of byStep) if (Math.abs(k - s) <= radius) pool.push(...v);
    }
    out.set(s, baselineOf(pool));
  }
  return out;
}

/**
 * Rollback Resistance for one bull: his April-only retention placed against the
 * baseline for bulls with the SAME number of April rounds. Returns null when the
 * bull has never been through an April — there is nothing to measure.
 */
export function cohortRating(
  raw: number | null,
  steps: number,
  baselines: Map<number, Baseline>,
): number | null {
  if (raw == null || steps < 1) return null;
  const base = baselines.get(steps);
  return base ? relativeRating(raw, base) : 100;
}

/** Verdict for a Rollback Resistance score, phrased relative to the lineup. */
export function ratingVerdict(rating: number): { label: string; tone: "good" | "warn" | "danger" | "slate" } {
  if (rating >= 110) return { label: "Resists rollback — well above lineup", tone: "good" };
  if (rating >= 105) return { label: "Above lineup", tone: "good" };
  if (rating >= 96) return { label: "Around lineup average", tone: "slate" };
  if (rating >= 91) return { label: "Below lineup", tone: "warn" };
  return { label: "Rolls back — well below lineup", tone: "danger" };
}

export const ROLLBACK_TRAIT_LABELS: Record<string, string> = {
  LPI: "LPI", "PRO$": "Pro$", CONF: "Conformation", MILK: "Milk", FAT: "Fat", PROT: "Protein",
  LTI: "LTI", HWI: "HWI", MAMM: "Mammary", FL: "Feet & Legs", DS: "Dairy Strength", HL: "Herd Life",
};
