// ---------------------------------------------------------------------------
// "SIRES THAT MOVE LIKE HIM" — matching one bull's proof BEHAVIOUR to other
// NAMED, INDIVIDUAL BULLS.
//
// THIS IS NOT THE ANALOGUE MATCHER. proof-analogue.ts matches a bull's CAREER
// POSITION (age, reliability, daughter count, one lag of change, …) against
// every historical (bull, trait, round) case, takes k=100 neighbours and turns
// their realised moves into a DISTRIBUTION — a forecast band. It looks at one
// step. It never names anybody.
//
// This module asks a different question: whose CURVE rhymes with his? It reads
// a bull's whole series of rises, falls and flat rounds and finds the other
// individual bulls whose series has the same shape. It returns a list of bulls
// a breeder can go and look at. Nothing in here feeds a forecast, and nothing
// in here changes a published number.
//
// WHAT A MATCH IS AND IS NOT
// A match is a statement about the past: these two bulls moved alike. It is NOT
// evidence that they will move alike next round. The direction of the next proof
// is settled as unforecastable in this codebase — see the header of
// proof-analogue.ts, where eight independent methods were all beaten by "assume
// no change". Any UI built on this module must say so.
//
// ---------------------------------------------------------------------------
// THE CORRECTNESS TRAP: RESIDUALISE FIRST
//
// Proof rounds move EVERYONE at once. April is a base change: Lactanet re-bases
// the genetic base and the whole population shifts on the same day. Ordinary
// rounds carry a smaller version of the same thing. So if you compare RAW
// round-to-round changes, two bulls who merely lived through the same number of
// April rollbacks look "similar" for a reason that has nothing to do with either
// animal, and the top matches collapse into "bulls of the same age".
//
// Every change is therefore residualised before anything is compared:
//
//     residual(bull, trait, round) = change(bull, trait, round)
//                                  − cohortChange(trait, round)
//
// `cohortChange` is the same quantity proof-forecast.ts calls the SYSTEMATIC
// term — "what this round does to everyone, for reasons that are nothing to do
// with the bull". The two are the same definition read at different times:
//
//   • proof-forecast must predict a round that has NOT happened, so it can only
//     ESTIMATE the term, as the cohort's mean change over past rounds of that
//     kind (`aprilMean` / `ordinaryMean`, restricted to a recent window).
//   • Here every round has already happened, so the term is MEASURED directly on
//     the round itself.
//
// The median is used rather than the mean for one reason: a handful of bulls
// taking a genuine individual jump would drag a mean, and that leakage would
// reappear inside every OTHER bull's residual as a spurious common movement —
// which is precisely the artefact this whole exercise exists to remove. On a
// base-change round, where the shift really is common to everyone, the mean and
// the median agree closely.
//
// A round with fewer than MIN_ROUND_COHORT bulls on file cannot have its cohort
// term measured at all, so that step is dropped rather than compared raw. Mixing
// residualised and un-residualised steps in one window would be worse than
// either.
//
// GAPS. A bull who has no row for a round steps straight over it, and that step
// carries the base change of EVERY round it crossed, not just the one it landed
// on. Subtracting only the destination round's term would leave the skipped
// round's base change sitting in his residual — and two bulls who missed the
// same round would then match each other perfectly for that reason alone, which
// is the very artefact this module exists to remove, wearing a different hat.
// Steps are therefore measured against the lineup's ROUND GRID: a step that
// spans k rounds has all k cohort terms subtracted, and is dropped outright if
// any of them is unmeasurable. Only single-round steps are allowed to DEFINE a
// cohort term, so a multi-round jump can never bias the median it is corrected
// against.
// ---------------------------------------------------------------------------
//
// WHAT A LOW DISTANCE IS WORTH — RANKING
//
// A short window makes a low distance cheap. The correlation between two
// unrelated residual windows has a null standard deviation of about 1/√(n−1),
// so over 4 rounds an unrelated bull scores |r| ≈ 0.58 by luck alone and over
// 40 rounds only ≈ 0.16. Ranking on raw distance therefore does not rank on
// similarity at all: it ranks, overwhelmingly, on WHO HAS THE LEAST HISTORY. In
// a pure-noise lineup of 8 four-step bulls and 60 forty-step bulls — where by
// construction nobody resembles anybody — the eight short bulls took 59 of the
// 68 top spots.
//
// Ranking is therefore by EVIDENCE, not by distance: the agreement is divided
// by its own null standard deviation (see `evidenceScore`), so a modest score
// across a long career outranks a flattering one across four rounds. The
// distance is still reported, because it is the thing with a unit.
//
// AND WHAT COUNTS AS A ROUND OF EVIDENCE
//
// Not every comparable round is an informative one. Conformation does not move
// at all for most bulls in most rounds, so a window can be comparable at eight
// positions and yet contain exactly one round where either animal did anything.
// z-normalising two such windows collapses both to the same spike and returns
// r = 1.00 — a "perfect match" resting on a single coincidence. A position only
// counts as INFORMATIVE when BOTH bulls moved on their own that round (see
// INFORMATIVE_MOVE), and a trait with fewer than `minInformative` of them is
// left out of the comparison exactly as a trait with too little overlap is.
// ---------------------------------------------------------------------------

import type { AnalogueBull, RoundKind } from "./proof-analogue";

/**
 * SHAPE     — z-normalise each bull's residual window, then Euclidean.
 *             Scale-free: it finds the same RHYTHM of ups and downs no matter
 *             how big the moves were.
 * MAGNITUDE — Euclidean on the residuals as they stand (converted to trait
 *             units, see `scale`). It finds bulls who moved the same AMOUNTS as
 *             well as the same way.
 */
export type SimilarityMode = "shape" | "magnitude";
export const SIMILARITY_MODES: SimilarityMode[] = ["shape", "magnitude"];

export function parseMode(v: string | null | undefined): SimilarityMode {
  return v === "magnitude" ? "magnitude" : "shape";
}

/**
 * Comparable career steps required before a match may be reported. Below this,
 * a bull is reported as having too little history to match — a two-point
 * "match" is a coincidence with a number attached.
 */
export const MIN_OVERLAP = 4;

/**
 * INFORMATIVE career steps required before a trait may be compared — steps
 * where BOTH bulls actually moved on their own. Comparable is not the same as
 * informative: two windows of mostly zeros are "comparable" at every position
 * and yet contain almost no evidence, and z-normalising them turns one shared
 * non-zero round into r = 1.00. See INFORMATIVE_MOVE.
 */
export const MIN_INFORMATIVE = 4;

/**
 * How big a residual has to be, as a fraction of the bull's OWN root-mean-square
 * residual over the compared window, before that round counts as him having
 * moved. Relative to himself rather than to the trait, so it works the same for
 * LPI (hundreds) and Conformation (single digits), and so a bull whose window is
 * one 200-point spike and seven rounds of rounding noise is correctly read as
 * having moved once — not eight times.
 */
export const INFORMATIVE_MOVE = 0.2;

/** Bulls a round needs before its cohort term is measurable rather than noise. */
export const MIN_ROUND_COHORT = 5;

/** How many bulls a panel shows by default. */
export const DEFAULT_LIMIT = 8;

/**
 * Sentinel trait selection meaning "all nine key traits, combined". Lives here,
 * in the pure module, so the client component that renders the selector can
 * import it without dragging a Prisma client into the browser bundle.
 */
export const ALL_TRAITS = "ALL9";

const EPS = 1e-9;

// --- small numeric helpers ---------------------------------------------------

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Root mean square about ZERO — "how much did he typically move", not "how much did he vary". */
export function rmsOf(xs: number[]): number {
  if (!xs.length) return 0;
  return Math.sqrt(xs.reduce((s, v) => s + v * v, 0) / xs.length);
}

/** Population SD. Zero for a window with one point or no variation. */
export function sdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
}

/**
 * z-normalise a window: subtract its mean, divide by its SD.
 *
 * A window with NO variation (every value identical — most often a bull who
 * tracked the cohort exactly, so every residual is zero) has no shape at all,
 * and dividing by its zero SD would produce NaN and silently poison every
 * distance it touched. It returns zeros instead, and callers must additionally
 * refuse to match such a window — see `compareBulls`. Returning zeros without
 * that refusal would make every flat bull "identical" to every other flat bull,
 * which is the vacuous match this module is built to avoid.
 */
export function zNormalise(xs: number[]): number[] {
  if (!xs.length) return [];
  const m = meanOf(xs);
  const sd = sdOf(xs);
  if (!(sd > EPS)) return xs.map(() => 0);
  return xs.map((v) => (v - m) / sd);
}

// --- the residual index ------------------------------------------------------

/** One career step: the move INTO round `position + 1`. */
export interface StepRef {
  /** Career position, 0-based: 0 is the bull's FIRST observed move. */
  position: number;
  time: number;
  kind: RoundKind;
  /**
   * How many rounds of the LINEUP'S grid this step crossed. 1 is the ordinary
   * case — the bull was present at both ends and missed nothing in between. 2 or
   * more means he has no row for a round that happened, so this one step carries
   * that round's base change too and must be corrected for all of them.
   */
  span: number;
}

export interface CohortTerm {
  /** The cohort's median change for this trait on this round. */
  median: number;
  /** Bulls behind it. */
  n: number;
}

export interface ResidualIndex {
  codes: string[];
  ids: string[];
  /** bull → his career steps, oldest first. */
  steps: Map<string, StepRef[]>;
  /** bull → trait → residual per career position (null where not comparable). */
  residuals: Map<string, Map<string, (number | null)[]>>;
  /** bull → trait → the RAW change per career position, kept for auditing. */
  raw: Map<string, Map<string, (number | null)[]>>;
  /** trait → round time → the cohort term that was subtracted. */
  cohort: Map<string, Map<number, CohortTerm>>;
  /**
   * trait → SD of every residual in the cohort. A UNIT CONVERSION, not a fitted
   * parameter, and identical for every bull — which is what lets "magnitude"
   * preserve real size differences BETWEEN bulls while still being commensurable
   * ACROSS traits. LPI residuals run in the hundreds and Conformation residuals
   * in single digits; concatenating those raw would be an LPI-only match wearing
   * a nine-trait label. Same commensurability rule the mating blend follows.
   */
  scale: Map<string, number>;
  /** The lineup's round grid, oldest first — every round anybody has a row for. */
  grid: number[];
  /** (trait, round) pairs too thin for a cohort term — their steps were dropped. */
  unmeasuredRounds: number;
  /**
   * Residual elements whose step crossed a round the bull has no row for, and
   * which were corrected against EVERY round they crossed rather than only the
   * one they landed on.
   */
  spanningSteps: number;
  /**
   * …and elements dropped outright because a round the step crossed had no
   * measurable cohort term, so the base change could not be taken off.
   */
  droppedSteps: number;
}

/**
 * Build the residual series for every bull and trait, once.
 *
 * Takes already-loaded rounds in exactly the shape proof-analogue's AnalogueBull
 * uses, so a caller that has built one has built both. Pure: no database, no
 * network, no I/O.
 */
export function buildResidualIndex(bulls: AnalogueBull[], codes: string[]): ResidualIndex {
  // The lineup's round grid. A bull's step is only a SINGLE round's worth of
  // movement if his two rounds are adjacent on this grid; otherwise it silently
  // contains the base change of every round he was absent for.
  const gridSet = new Set<number>();
  for (const b of bulls) for (const r of b.rounds) gridSet.add(r.time);
  const grid = [...gridSet].sort((a, b) => a - b);
  const gridPos = new Map<number, number>();
  grid.forEach((t, i) => gridPos.set(t, i));

  const steps = new Map<string, StepRef[]>();
  const raw = new Map<string, Map<string, (number | null)[]>>();
  /** trait → round time → the raw change of every bull who was present either side. */
  const byRound = new Map<string, Map<number, number[]>>();
  for (const code of codes) byRound.set(code, new Map());

  for (const b of bulls) {
    const s: StepRef[] = [];
    for (let i = 1; i < b.rounds.length; i++) {
      const from = gridPos.get(b.rounds[i - 1].time)!;
      const to = gridPos.get(b.rounds[i].time)!;
      s.push({ position: i - 1, time: b.rounds[i].time, kind: b.rounds[i].kind, span: Math.max(1, to - from) });
    }
    steps.set(b.id, s);

    const perCode = new Map<string, (number | null)[]>();
    for (const code of codes) {
      const arr: (number | null)[] = new Array(s.length).fill(null);
      const roundMap = byRound.get(code)!;
      for (let i = 1; i < b.rounds.length; i++) {
        const p = b.rounds[i - 1].traits.get(code);
        const q = b.rounds[i].traits.get(code);
        if (p == null || q == null || !Number.isFinite(p) || !Number.isFinite(q)) continue;
        const d = q - p;
        arr[i - 1] = d;
        // ONLY a single-round step may define a round's cohort term. A step that
        // skipped rounds is several rounds of movement added together; dropping
        // it into one round's bucket would drag that round's median toward a
        // change that did not happen there.
        if (s[i - 1].span !== 1) continue;
        const list = roundMap.get(b.rounds[i].time);
        if (list) list.push(d);
        else roundMap.set(b.rounds[i].time, [d]);
      }
      perCode.set(code, arr);
    }
    raw.set(b.id, perCode);
  }

  // The cohort term per (trait, round). This is the whole point of the module:
  // whatever the round did to everybody comes out here and never reaches a
  // comparison.
  const cohort = new Map<string, Map<number, CohortTerm>>();
  let unmeasuredRounds = 0;
  for (const code of codes) {
    const out = new Map<number, CohortTerm>();
    for (const [time, deltas] of byRound.get(code)!) {
      if (deltas.length < MIN_ROUND_COHORT) { unmeasuredRounds++; continue; }
      out.set(time, { median: median(deltas), n: deltas.length });
    }
    cohort.set(code, out);
  }

  const residuals = new Map<string, Map<string, (number | null)[]>>();
  const pooled = new Map<string, number[]>();
  for (const code of codes) pooled.set(code, []);
  let spanningSteps = 0;
  let droppedSteps = 0;
  for (const b of bulls) {
    const s = steps.get(b.id)!;
    const rawPer = raw.get(b.id)!;
    const perCode = new Map<string, (number | null)[]>();
    for (const code of codes) {
      const src = rawPer.get(code)!;
      const terms = cohort.get(code)!;
      const out: (number | null)[] = new Array(s.length).fill(null);
      for (let i = 0; i < s.length; i++) {
        const d = src[i];
        if (d == null) continue;
        // Every round this step crossed has to come off it, not just the one it
        // landed on: the bull's change since his last row contains all of them.
        const end = gridPos.get(s[i].time)!;
        let common = 0;
        let complete = true;
        for (let g = end - s[i].span + 1; g <= end; g++) {
          const term = terms.get(grid[g]);
          if (!term) { complete = false; break; } // round too thin to residualise
          common += term.median;
        }
        if (!complete) { droppedSteps++; continue; } // not comparable at all
        if (s[i].span > 1) spanningSteps++;
        const r = d - common;
        out[i] = r;
        pooled.get(code)!.push(r);
      }
      perCode.set(code, out);
    }
    residuals.set(b.id, perCode);
  }

  const scale = new Map<string, number>();
  for (const code of codes) scale.set(code, sdOf(pooled.get(code)!) || 1);

  return {
    codes: [...codes],
    ids: bulls.map((b) => b.id),
    steps, residuals, raw, cohort, scale, grid,
    unmeasuredRounds, spanningSteps, droppedSteps,
  };
}

// --- comparison --------------------------------------------------------------

export interface TraitComparison {
  code: string;
  /** Career steps where BOTH bulls have a comparable residual. */
  overlap: number;
  /** …of which this many are steps where BOTH bulls actually moved. */
  informative: number;
  /** This trait's own RMS distance, for explaining a combined match. */
  distance: number;
}

export interface Comparison {
  /**
   * ROOT-MEAN-SQUARE distance over every compared element, pooled across traits.
   * RMS rather than plain Euclidean because overlap varies from pair to pair and
   * from trait to trait: a raw Euclidean sum would rank a bull with 12 shared
   * rounds as "less similar" than one with 5 purely for having more evidence.
   * Lower is more alike; 0 is identical.
   */
  distance: number;
  /**
   * CAREER STEPS where the two bulls were comparable on at least one of the
   * traits that made it into the comparison.
   *
   * This is the number a reader means by "rounds overlapped", and it is NOT the
   * number the RMS is divided by. With nine traits selected, four shared career
   * rounds produce thirty-six compared elements; reporting the thirty-six as
   * "rounds" overstates the evidence ninefold and, worse, lifts every combined
   * match over any thin-window warning threshold expressed in rounds. Keep the
   * two apart: `rounds` for the reader, `elements` for the arithmetic.
   */
  rounds: number;
  /** …of which this many are steps where both bulls moved on at least one trait. */
  informativeRounds: number;
  /** Compared elements, pooled across traits — the denominator of the RMS. */
  elements: number;
  /** Informative elements, pooled across traits. */
  informative: number;
  traits: TraitComparison[];
}

export interface CompareOptions {
  mode: SimilarityMode;
  /** Defaults to every trait in the index. */
  codes?: string[];
  minOverlap?: number;
  /** Informative steps a trait needs before it may be compared. */
  minInformative?: number;
}

/**
 * Distance between two bulls' residual series, aligned by CAREER POSITION —
 * his 1st move against the other's 1st move — never by calendar date. That is
 * deliberate: the question is "whose career rhymes with his", so a bull from
 * 2015 must be allowed to match a bull from 2024. (Matching by date would ask
 * "who moved WITH him", which after residualisation is nearly empty anyway.)
 *
 * Returns null when the pair has nothing legitimate to compare.
 */
export function compareBulls(
  index: ResidualIndex,
  aId: string,
  bId: string,
  opts: CompareOptions,
): Comparison | null {
  const codes = opts.codes ?? index.codes;
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP;
  const minInformative = opts.minInformative ?? MIN_INFORMATIVE;
  const ra = index.residuals.get(aId);
  const rb = index.residuals.get(bId);
  if (!ra || !rb) return null;

  let sumSq = 0;
  let elements = 0;
  let informative = 0;
  /** Career positions that reached the comparison, so `rounds` counts each once. */
  const comparedAt = new Set<number>();
  const informativeAt = new Set<number>();
  const traits: TraitComparison[] = [];

  for (const code of codes) {
    const sa = ra.get(code);
    const sb = rb.get(code);
    if (!sa || !sb) continue;

    const n = Math.min(sa.length, sb.length);
    const va: number[] = [], vb: number[] = [], at: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = sa[i], y = sb[i];
      if (x != null && y != null) { va.push(x); vb.push(y); at.push(i); }
    }
    if (va.length < minOverlap) continue;

    // How much of this window is EVIDENCE rather than agreement about sitting
    // still? A round only counts when both bulls moved appreciably relative to
    // their own window. Judged on the residuals as they stand, before any
    // normalisation, so the answer is the same in both modes.
    const ta = INFORMATIVE_MOVE * rmsOf(va);
    const tb = INFORMATIVE_MOVE * rmsOf(vb);
    const infoAt: number[] = [];
    for (let i = 0; i < va.length; i++) {
      if (Math.abs(va[i]) > ta && Math.abs(vb[i]) > tb) infoAt.push(at[i]);
    }
    if (infoAt.length < minInformative) continue;

    let xa: number[], xb: number[];
    if (opts.mode === "shape") {
      // A flat window has no shape, so there is nothing to match — skip rather
      // than emit a zero-vector that would read as a perfect match.
      if (sdOf(va) <= EPS || sdOf(vb) <= EPS) continue;
      xa = zNormalise(va);
      xb = zNormalise(vb);
    } else {
      // Two bulls who both did nothing of their own are not "moving alike";
      // they are two flat lines. Refuse the vacuous zero distance.
      if (sdOf(va) <= EPS && sdOf(vb) <= EPS) continue;
      const sc = index.scale.get(code) || 1;
      xa = va.map((v) => v / sc);
      xb = vb.map((v) => v / sc);
    }

    let traitSq = 0;
    for (let i = 0; i < xa.length; i++) traitSq += (xa[i] - xb[i]) ** 2;
    sumSq += traitSq;
    elements += xa.length;
    informative += infoAt.length;
    for (const p of at) comparedAt.add(p);
    for (const p of infoAt) informativeAt.add(p);
    traits.push({ code, overlap: va.length, informative: infoAt.length, distance: Math.sqrt(traitSq / xa.length) });
  }

  if (!traits.length || elements === 0) return null;
  return {
    distance: Math.sqrt(sumSq / elements),
    rounds: comparedAt.size,
    informativeRounds: informativeAt.size,
    elements,
    informative,
    traits,
  };
}

// --- the search --------------------------------------------------------------

/**
 * Why a subject cannot be matched at all. Reported rather than papered over: a
 * weak match presented as a match is worse than an honest refusal.
 */
export type SubjectStatus =
  | "ok"
  /** Fewer than MIN_OVERLAP comparable career steps on file. */
  | "insufficient-history"
  /** Enough steps, but every residual is flat — he only ever tracked the cohort. */
  | "no-own-movement"
  /** Not in the index. */
  | "unknown";

export interface SimilarMatch {
  id: string;
  distance: number;
  /**
   * See similarityOf: the Pearson correlation of the two residual windows in
   * shape mode (−1 to 1), a monotone 0-1 reading of the distance in magnitude
   * mode. Monotone in `distance` either way — it is NOT the ordering, which is
   * `score`.
   */
  similarity: number;
  /** The ranking statistic — see evidenceScore. Higher is stronger evidence. */
  score: number;
  /** Career steps compared. Read the similarity against THIS — see shapeCorrelation. */
  rounds: number;
  /** …of which this many are steps where both bulls actually moved. */
  informativeRounds: number;
  /** Compared elements pooled across traits — the RMS denominator, not a round count. */
  elements: number;
  traits: TraitComparison[];
}

export interface SimilarityResult {
  subject: string;
  status: SubjectStatus;
  mode: SimilarityMode;
  codes: string[];
  minOverlap: number;
  minInformative: number;
  matches: SimilarMatch[];
  /** Other bulls in the cohort. */
  cohort: number;
  /** …of whom this many had enough comparable history to be scored. */
  compared: number;
  /** …and this many did not, so were left out rather than scored weakly. */
  skipped: number;
}

/**
 * SHAPE DISTANCE IS EXACTLY A CORRELATION, and this converts it back.
 *
 * Both windows are z-normalised with a population SD, so Σz² = n for each, and
 *
 *   d² = (1/n) Σ (za − zb)²  =  (1/n)(n + n − 2 Σ za·zb)  =  2 (1 − r)
 *
 * where r is the Pearson correlation between the two residual windows. So
 * d = 0 is r = 1, d = √2 ≈ 1.414 is r = 0 (no relationship at all), and d = 2 is
 * r = −1 (mirror images). Reporting r rather than an invented 0-1 "similarity"
 * means the headline figure is a quantity with a known meaning — including the
 * fact that anything past 1.414 is a bull moving OPPOSITE to him.
 *
 * It also makes the thin-window caveat concrete: r has a null standard deviation
 * of roughly 1/√(n−1), so over 4 rounds an unrelated bull scores |r| ≈ 0.58 by
 * luck alone, while over 40 rounds he scores ≈ 0.16. A short overlap buys a
 * flattering number. That is why the overlap is reported beside every match and
 * MUST be shown — and why the ranking divides this figure by its own null
 * standard deviation rather than taking it at face value (see evidenceScore).
 */
export function shapeCorrelation(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2));
}

/** Fisher's transform, clamped so a perfect agreement cannot return Infinity. */
export function fisherZ(r: number): number {
  return Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
}

/**
 * THE RANKING STATISTIC. Roughly "how many null standard deviations out is this
 * agreement" — the agreement pushed through Fisher's transform and multiplied by
 * √(n−1), the reciprocal of the correlation's null standard deviation.
 *
 * It exists because ranking on raw distance does not rank on similarity. A short
 * window makes a low distance cheap, so the top of a distance-ordered list fills
 * up with whoever has the least history: in a pure-noise lineup of 8 four-step
 * bulls and 60 forty-step bulls, the eight short bulls took 59 of the 68 top
 * spots. Dividing by the null SD removes exactly that advantage, so a modest
 * agreement over a long career outranks a flattering one over four rounds.
 *
 * `n` is the count of INFORMATIVE CAREER ROUNDS, never the pooled element count.
 * With nine traits selected the pooled count is nine times larger, and the nine
 * are anything but independent — LPI is largely a function of the other eight —
 * so scaling by it would inflate every combined match by a factor of three.
 *
 * In shape mode the agreement is exactly the Pearson correlation and this is a
 * genuine test statistic. In magnitude mode the residuals keep their size, so
 * 1 − d²/2 is a close analogue of the correlation rather than the thing itself,
 * and the score is a ranking heuristic — sound for ordering candidates measured
 * the same way, not a p-value. Nothing downstream treats it as one.
 */
export function evidenceScore(agreement: number, informativeRounds: number): number {
  return fisherZ(agreement) * Math.sqrt(Math.max(0, informativeRounds - 1));
}

/**
 * The headline figure beside a match. For shape it is the correlation above —
 * a real quantity. For magnitude there is no such identity (the residuals keep
 * their size), so it is a plain monotone reading of the distance, and the
 * distance is the number that means something.
 */
export function similarityOf(distance: number, mode: SimilarityMode): number {
  return mode === "shape" ? shapeCorrelation(distance) : 1 / (1 + Math.max(0, distance));
}

/**
 * The number of CAREER ROUNDS below which a low distance should be read with
 * suspicion — see shapeCorrelation. Presentation only: it changes no maths.
 *
 * Compare it against `rounds` or `informativeRounds`, never against `elements`.
 * Testing it against the pooled element count silently disables it in combined
 * mode, where four career rounds across nine traits present as thirty-six.
 */
export const THIN_OVERLAP = 8;

export interface FindSimilarOptions extends CompareOptions {
  limit?: number;
}

export function findSimilar(
  index: ResidualIndex,
  subjectId: string,
  opts: FindSimilarOptions,
): SimilarityResult {
  const codes = opts.codes ?? index.codes;
  const minOverlap = opts.minOverlap ?? MIN_OVERLAP;
  const minInformative = opts.minInformative ?? MIN_INFORMATIVE;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const base = {
    subject: subjectId, mode: opts.mode, codes: [...codes], minOverlap, minInformative,
    cohort: Math.max(0, index.ids.length - 1),
  };

  const own = index.residuals.get(subjectId);
  if (!own) {
    return { ...base, status: "unknown", matches: [], compared: 0, skipped: 0 };
  }

  // Can this bull be matched at all? Judged on his own series, before any
  // candidate is looked at, so the answer is about him and not about who
  // happens to be in the lineup.
  let longEnough = false;
  let anyMovement = false;
  for (const code of codes) {
    const s = own.get(code);
    if (!s) continue;
    const vals = s.filter((v): v is number => v != null);
    if (vals.length < minOverlap) continue;
    longEnough = true;
    if (sdOf(vals) > EPS) anyMovement = true;
  }
  if (!longEnough) {
    return { ...base, status: "insufficient-history", matches: [], compared: 0, skipped: 0 };
  }
  if (!anyMovement) {
    return { ...base, status: "no-own-movement", matches: [], compared: 0, skipped: 0 };
  }

  const matches: SimilarMatch[] = [];
  let skipped = 0;
  for (const id of index.ids) {
    if (id === subjectId) continue;
    const c = compareBulls(index, subjectId, id, { mode: opts.mode, codes, minOverlap, minInformative });
    if (!c) { skipped++; continue; }
    matches.push({
      id,
      distance: c.distance,
      similarity: similarityOf(c.distance, opts.mode),
      score: evidenceScore(shapeCorrelation(c.distance), c.informativeRounds),
      rounds: c.rounds,
      informativeRounds: c.informativeRounds,
      elements: c.elements,
      traits: c.traits,
    });
  }
  // Strongest EVIDENCE first, not smallest distance — see evidenceScore. Ties
  // fall back to distance, then to id, so the same request always renders the
  // same list.
  matches.sort((a, b) => b.score - a.score || a.distance - b.distance || (a.id < b.id ? -1 : 1));

  return {
    ...base,
    status: "ok",
    compared: matches.length,
    skipped,
    matches: matches.slice(0, limit),
  };
}

// --- curves for display ------------------------------------------------------

export interface CurvePoint {
  position: number;
  time: number;
  kind: RoundKind;
  /** The bull's own move that round, cohort removed. Null where not comparable. */
  residual: number | null;
  /**
   * Running sum of the residuals — "where his proof would have travelled if the
   * whole population had stood still". Carried flat across a non-comparable
   * round so that career position stays aligned across bulls; `residual === null`
   * marks those, and a UI should say so rather than draw them as a real hold.
   */
  cumulative: number;
}

/** One bull's residual curve for one trait, oldest first. */
export function curveOf(index: ResidualIndex, bullId: string, code: string): CurvePoint[] {
  const steps = index.steps.get(bullId);
  const series = index.residuals.get(bullId)?.get(code);
  if (!steps || !series) return [];
  const out: CurvePoint[] = [];
  let run = 0;
  for (let i = 0; i < steps.length; i++) {
    const r = series[i] ?? null;
    if (r != null) run += r;
    out.push({ position: steps[i].position, time: steps[i].time, kind: steps[i].kind, residual: r, cumulative: run });
  }
  return out;
}
