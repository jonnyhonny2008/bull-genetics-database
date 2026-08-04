// ---------------------------------------------------------------------------
// Mating Program — the RANKING MATHS, and nothing else.
//
// Split out of mating-program.ts (which is `server-only`) so the numbers that
// decide which bull a breeder is shown can be unit-tested directly. Pure: no
// Prisma, no React, no I/O.
//
// --- WHY STANDARDISATION, AND NOT A SUM -------------------------------------
// A mating run may now be ranked on several traits at once. The obvious
// implementation — add the traits up — is WRONG, and wrong in a way that hides
// itself: LPI runs to about 3000 and Conformation to about ±20, so
// "LPI + Conformation" is an LPI ranking with a rounding error attached. It
// would print the word "Conformation" on the report while ranking on nothing of
// the kind. That is worse than not offering the feature.
//
// So every selected trait is first placed on a COMMON SCALE — its own z-score
// across the candidate pool actually being ranked — and only then blended:
//
//     z_t(bull)  = (value - mean_t) / sd_t          negated when lower is better
//     composite  = SUM(w_t * z_t) / SUM(w_t)
//     matchScore = 100 + 5 * composite
//
// mean_t and sd_t come from THE POOL, not from the trait's national base, so the
// score answers the only question a breeder is actually asking: how does this
// bull compare with the other bulls I could order today.
//
// 100 = pool average, 5 points = one standard deviation, is this application's
// own existing convention — see Animal.rollbackResistance and
// src/lib/rollback.ts (RATING_SD_POINTS / relativeRating). A breeder who has
// read a 112 on a bull profile reads a 112 here the same way.
//
// The bull's OWN value is standardised, never the parent average. For a single
// female the dam's contribution is a constant and the ordering is identical
// either way, but one pool-wide standardisation keeps the cross-female "bull
// coverage" view coherent: a bull's Match score means the same thing on every
// row of the report. The figure DISPLAYED per trait stays the parent average.
//
// --- WHAT IS DELIBERATELY NOT DONE ------------------------------------------
// A bull missing any selected trait gets NO composite. He is not scored on the
// traits he happens to carry: re-normalising over the survivors would raise the
// score of a bull precisely because his weak trait is unrecorded, which is the
// exact failure this whole module exists to prevent.
//
// A trait the pool cannot separate on (sd 0, or fewer than two bulls with a
// value) contributes NOTHING and says so out loud. It is never divided by.
// ---------------------------------------------------------------------------

import { correctionNote, deficit, idealBullValue, isIntermediate, targetFor } from "./mating-targets";

/** One rankable index: its code, how it is spelled to a user, and its column. */
export interface MatingIndex {
  code: string;
  label: string;
  col: string;
}

/**
 * The indexes a mating run may be ranked on.
 *
 * PI and F&L are DELIBERATELY ABSENT. Only about half of the preferred
 * evaluations carry them, so ranking on either would silently drop half the
 * lineup — the user would see a shorter list and no explanation.
 */
export const MATING_INDEXES: MatingIndex[] = [
  { code: "LPI", label: "LPI", col: "lpi" },
  { code: "PRO$", label: "Pro$", col: "proDollar" },
  { code: "CONF", label: "Conformation", col: "conf" },
  { code: "MAMM", label: "Mammary", col: "mamm" },
  { code: "MILK", label: "Milk", col: "milk" },
  { code: "FAT", label: "Fat", col: "fat" },
  { code: "PROT", label: "Protein", col: "prot" },
  { code: "SCS", label: "SCS", col: "scs" },
];

/**
 * Indexes where a LOWER number is the better animal. Somatic Cell Score is the
 * only one on the menu. Ranking it descending — as a naive "highest index wins"
 * would — recommends the worst udder-health bulls in the barn, so the sort
 * direction is derived, never assumed. In a blend its z-score is NEGATED, which
 * is the same rule expressed on the common scale.
 */
export const LOWER_IS_BETTER = new Set(["SCS"]);

export const DEFAULT_INDEX = "LPI";

/**
 * How many traits may be blended at once. Four is already more than a breeder
 * can hold in their head, and every extra trait dilutes the ones that matter:
 * at five equal weights no single trait can move the score by more than a fifth
 * of its own spread.
 */
export const MAX_SELECTED_TRAITS = 4;

/** Weight bounds. Below 0.1 a trait is decoration; above 10 it is the ranking. */
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 10;

/**
 * The `step` for the weight inputs on the form.
 *
 * It must stay "any". A numeric step is measured from `min` (0.1), so ANY
 * numeric step that does not divide 0.9 exactly makes the default weight of 1 a
 * stepMismatch — and HTML constraint validation then refuses to submit the whole
 * GET form, killing the single-trait run as well. The server clamps to
 * MIN_WEIGHT/MAX_WEIGHT and warns, so there is nothing for a client-side step to
 * add.
 */
export const WEIGHT_STEP = "any";

/** The base-100 scale, shared with Rollback Resistance. */
export const SCORE_BASE = 100;
export const SCORE_SD_POINTS = 5;

// --- corrective mating: the merit/correction dial ---------------------------

/**
 * How the final score splits between MERIT (raise the calf's index) and
 * CORRECTION (fix what is wrong with this particular cow):
 *
 *     final = blend × meritZ + (1 − blend) × correctionZ
 *
 * 1 is the ranking this report has always produced. 0 ignores merit entirely and
 * ranks purely on how well the bull suits her faults. 0.5 is the default because
 * neither half is worth having alone: merit alone breeds a high-index cow with
 * the same bad legs, and correction alone breeds a correct cow nobody wants.
 */
export const DEFAULT_BLEND = 0.5;
export const MIN_BLEND = 0;
export const MAX_BLEND = 1;

/**
 * The `step` for the blend slider. A STRING for the same reason WEIGHT_STEP is:
 * a numeric step is measured from `min`, and any value off that grid is a
 * stepMismatch that makes the browser refuse to submit the whole GET form. "0.05"
 * as a string is passed through to the attribute verbatim and divides 1 exactly,
 * but keeping it out of the numeric-literal shape also keeps the form free of the
 * hard-coded steps that broke it once already.
 */
export const BLEND_STEP = "0.05";

/**
 * How many of her weaknesses a run acts on. Five is a real mating decision;
 * beyond that every trait's weight is diluted to the point where the correction
 * term is just noise, and no breeder mates a cow on ten faults at once.
 */
export const DEFAULT_WEAK_N = 5;
export const MIN_WEAK_N = 1;
export const MAX_WEAK_N = 10;

/**
 * Decimal places for the Match score, everywhere it is shown — screen and
 * workbook alike.
 *
 * It is NOT zero. matchScoreOf rounds to one decimal while the ranking sorts on
 * the unrounded composite, so at zero decimals bulls up to 0.2 sd apart print
 * the same integer and a numbered ranking has nothing on screen to justify its
 * own order. The Excel export writes the same 1-dp number, so a rounder screen
 * would also contradict the printed sheet.
 */
export const MATCH_SCORE_DIGITS = 1;

/** A trait the run is ranked on, with the weight it carries in the blend. */
export interface SelectedTrait {
  code: string;
  label: string;
  col: string;
  weight: number;
  /** false for SCS — its z-score is negated before blending. */
  higherIsBetter: boolean;
}

/** Pool mean and spread for one trait, over the bulls that HAVE a value. */
export interface TraitStats {
  code: string;
  mean: number;
  sd: number;
  n: number;
  /**
   * False when the pool cannot be separated on this trait (sd 0, or fewer than
   * two bulls with a value). An unusable trait contributes nothing to the
   * composite — it is never divided by, and never silently treated as zero
   * spread.
   */
  usable: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// --- parsing the selection --------------------------------------------------

/**
 * Read the trait selection out of the request.
 *
 * Each raw entry is a comma-separated list of `CODE` or `CODE:weight`
 * ("LPI", "LPI,CONF", "LPI:2,CONF:1"). A bare single code is the classic
 * single-trait run and must stay that way — see rankIsComposite().
 *
 * Everything rejected is REPORTED. An unknown code, a weight that is not a
 * number, a weight outside the sane range and a fifth trait all produce a
 * warning rather than a quiet substitution, because the whole report is a
 * ranking and a silently different ranking is indistinguishable from the one
 * the user asked for.
 */
export function parseTraitSelection(raw: (string | undefined)[]): {
  selected: SelectedTrait[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const tokens: string[] = [];
  for (const entry of raw) {
    for (const part of (entry ?? "").split(",")) {
      const t = part.trim();
      if (t) tokens.push(t);
    }
  }

  const selected: SelectedTrait[] = [];
  const seen = new Set<string>();
  let overflow = 0;

  for (const token of tokens) {
    const [codeRaw, weightRaw] = token.split(":");
    const code = (codeRaw ?? "").trim().toUpperCase();
    const idx = MATING_INDEXES.find((i) => i.code === code);
    if (!idx) {
      warnings.push(`"${token}" is not a rankable index in this build — it was left out of the ranking.`);
      continue;
    }
    if (seen.has(idx.code)) {
      warnings.push(`${idx.label} was selected twice — the second copy was ignored, not added to its weight.`);
      continue;
    }
    if (selected.length >= MAX_SELECTED_TRAITS) {
      overflow++;
      continue;
    }

    let weight = 1;
    const w = (weightRaw ?? "").trim();
    if (w !== "") {
      const parsed = Number.parseFloat(w);
      if (!Number.isFinite(parsed)) {
        warnings.push(`"${w}" is not a usable weight for ${idx.label} — a weight of 1 was used.`);
      } else if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        weight = Math.min(Math.max(parsed, MIN_WEIGHT), MAX_WEIGHT);
        warnings.push(
          `A weight of ${parsed} for ${idx.label} is outside the ${MIN_WEIGHT}–${MAX_WEIGHT} range — it was held at ${weight}.`,
        );
      } else {
        weight = parsed;
      }
    }

    seen.add(idx.code);
    selected.push({
      code: idx.code,
      label: idx.label,
      col: idx.col,
      weight,
      higherIsBetter: !LOWER_IS_BETTER.has(idx.code),
    });
  }

  if (overflow) {
    warnings.push(
      `Only ${MAX_SELECTED_TRAITS} traits can be blended in one ranking — ${overflow} further trait${overflow === 1 ? " was" : "s were"} ignored. Rank on fewer traits, or give the ones that matter a higher weight.`,
    );
  }

  if (selected.length === 0) {
    if (tokens.length) warnings.push(`Nothing rankable was selected — ranked on ${DEFAULT_INDEX} instead.`);
    const d = MATING_INDEXES.find((i) => i.code === DEFAULT_INDEX)!;
    selected.push({
      code: d.code,
      label: d.label,
      col: d.col,
      weight: 1,
      higherIsBetter: !LOWER_IS_BETTER.has(d.code),
    });
  }

  return { selected, warnings };
}

/**
 * True when the run must be ranked on the standardised composite.
 *
 * ONE trait is ranked on its raw parent average, exactly as this report always
 * has been. Ranking one trait by its z-score would produce the identical order,
 * but it would change the number printed in the ranking column and in the
 * export — so the single-trait path skips standardisation entirely rather than
 * arriving at the same order by a different road.
 */
export function rankIsComposite(selected: SelectedTrait[]): boolean {
  return selected.length > 1;
}

/** "LPI + Conformation ×2" — the blend, in the order it was selected. */
export function blendLabel(selected: SelectedTrait[]): string {
  if (selected.length === 1) return selected[0].label;
  return selected.map((s) => (s.weight === 1 ? s.label : `${s.label} ×${s.weight}`)).join(" + ");
}

// --- the pool scale ---------------------------------------------------------

/**
 * Mean and (population, not sample) standard deviation for each selected trait,
 * over the candidate pool. Computed ONCE per run, before any female is looked
 * at: the scale a bull is measured against is the lineup, and it must not shift
 * from one cow to the next.
 */
export function poolTraitStats(
  selected: SelectedTrait[],
  pool: { cols: Map<string, number | null> }[],
): Map<string, TraitStats> {
  const out = new Map<string, TraitStats>();
  for (const s of selected) {
    const values: number[] = [];
    for (const c of pool) {
      const v = c.cols.get(s.code);
      if (v != null && Number.isFinite(v)) values.push(v);
    }
    const n = values.length;
    if (n === 0) {
      out.set(s.code, { code: s.code, mean: 0, sd: 0, n: 0, usable: false });
      continue;
    }
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    // Fewer than two bulls has no spread to measure; sd 0 means every bull is
    // identical on this trait. Either way it cannot rank anything, and dividing
    // by it would be a divide-by-zero dressed up as a score.
    out.set(s.code, { code: s.code, mean, sd, n, usable: n >= 2 && sd > 1e-9 });
  }
  return out;
}

export interface CompositeScore {
  /** Weighted mean z-score, in standard deviations. null = not scorable. */
  composite: number | null;
  /** 100 + 5 × composite. null whenever composite is null. */
  matchScore: number | null;
  /** Selected traits this bull has no value for. Non-empty ⇒ composite null. */
  missing: string[];
}

const UNSCORED: CompositeScore = { composite: null, matchScore: null, missing: [] };

/** 100 at the pool average, 5 points per standard deviation of the blend. */
export function matchScoreOf(composite: number): number {
  return round1(SCORE_BASE + SCORE_SD_POINTS * composite);
}

/**
 * One bull's standardised composite against the pool.
 *
 * A bull missing ANY selected trait scores null — he is not re-normalised over
 * the traits he does carry, because that would reward him for the missing one.
 * Traits the pool cannot separate on drop out of both the numerator and the
 * denominator, so the remaining traits keep their stated proportions rather
 * than being quietly shrunk toward the mean.
 */
export function compositeScore(
  cols: Map<string, number | null>,
  selected: SelectedTrait[],
  stats: Map<string, TraitStats>,
): CompositeScore {
  const missing = selected.filter((s) => cols.get(s.code) == null).map((s) => s.code);
  if (missing.length) return { composite: null, matchScore: null, missing };

  let num = 0;
  let den = 0;
  for (const s of selected) {
    const st = stats.get(s.code);
    if (!st || !st.usable) continue;
    const value = cols.get(s.code)!;
    const z = (value - st.mean) / st.sd;
    num += s.weight * (s.higherIsBetter ? z : -z);
    den += s.weight;
  }
  if (den === 0) return UNSCORED; // nothing in the blend could be standardised

  const composite = num / den;
  return { composite, matchScore: matchScoreOf(composite), missing: [] };
}

/**
 * The projected calf figure for one trait: the mean of the two parents, or the
 * bull's own value when the dam has none. Never invented — a bull with no value
 * has no projection.
 */
export function parentAverage(own: number | null, dam: number | null): number | null {
  if (own == null) return null;
  return dam == null ? own : (own + dam) / 2;
}

/**
 * Composite sort order: higher first, and a bull with no score ALWAYS last.
 * Returns 0 for a tie so the caller can add its own tie-break.
 */
export function compareByScore(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return b - a;
}

// --- saying it in words -----------------------------------------------------

/**
 * What the composite IS, in a sentence a breeder can act on, plus a named
 * warning for every trait that turned out to be dead weight in this pool.
 *
 * Empty for a single-trait run: nothing has been standardised, the ranking is
 * the projected calf value itself, and the report already says so.
 */
export function describeSelection(
  selected: SelectedTrait[],
  stats: Map<string, TraitStats>,
  poolN: number,
): string[] {
  if (!rankIsComposite(selected)) return [];
  const out: string[] = [];

  const parts = selected.map((s) => `${s.label} (weight ${s.weight})`);
  const list = parts.length === 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  out.push(
    `Ranked on a blend of ${list}. These traits are not on the same scale — LPI runs into the thousands while Conformation runs in single digits — so adding them up would be an LPI ranking wearing another trait's name. Instead each trait is measured against the ${poolN} bull${poolN === 1 ? "" : "s"} in this pool and the results are combined in the weights above. The Match score is ${SCORE_BASE} at the pool average and moves ${SCORE_SD_POINTS} points for every standard deviation, so a bull on ${SCORE_BASE + SCORE_SD_POINTS * 3} is three standard deviations above the pool on the blend you chose.`,
  );

  for (const s of selected) {
    if (!s.higherIsBetter) {
      out.push(
        `${s.label}: a LOWER value is the better animal, so its contribution to the Match score is reversed before blending. A bull is rewarded for a low ${s.label}, not punished for it.`,
      );
    }
  }

  const usable = selected.filter((s) => stats.get(s.code)?.usable);
  for (const s of selected) {
    const st = stats.get(s.code);
    if (st?.usable) continue;
    const shared = usable.length
      ? `It contributes NOTHING to the Match score, and the remaining ${usable.length === 1 ? "trait carries" : "traits carry"} the full weight.`
      : "It contributes NOTHING to the Match score.";
    if (!st || st.n < 2) {
      out.push(`Only ${st?.n ?? 0} bull${(st?.n ?? 0) === 1 ? "" : "s"} in this pool ${(st?.n ?? 0) === 1 ? "has" : "have"} a ${s.label}, so there is no spread to measure it against. ${shared}`);
    } else {
      out.push(`Every bull in this pool has the same ${s.label} (${round2(st.mean)}), so it cannot tell them apart. ${shared}`);
    }
  }

  if (!usable.length) {
    out.push(
      "None of the selected traits varies across this pool, so no Match score could be computed and no bull was ranked. Widen the bull pool, or rank on a trait the lineup actually differs on.",
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// CORRECTIVE MATING — finding a cow's weaknesses and weighting them.
//
// The scoring above answers "which bull is best?". This section answers "which
// bull is best FOR HER?", and the two are not the same question.
//
// --- WHY THE DEFICIT IS DIVIDED BY THE POOL SD ------------------------------
// A cow's deficit is measured on the trait's OWN scale: −250 kg on Milk is a
// deficit of 250, +9 on Stature is a deficit of 9. Weighting the traits by those
// raw numbers directly — the obvious implementation — is the same defect this
// whole module was written to prevent, one level up: Milk's hundreds would carry
// 96% of the weight and every cow in the country would be "weakest on Milk",
// including one standing three points off the Stature target. The word
// "correction" would appear on the report while the ranking corrected nothing.
//
// So a deficit is expressed in POOL STANDARD DEVIATIONS of that trait before the
// traits are compared with one another:
//
//     deficitSd_t = deficit_t / sd_t          sd_t from the candidate pool
//     w_t         = deficitSd_t / SUM(deficitSd)      so the weights sum to 1
//
// The raw deficit is still what is DISPLAYED and exported — it is the number a
// classifier would recognise. deficitSd exists only to make "which fault is
// worse?" a question with an answer.
//
// A trait she is already on target for has deficit 0, so it carries weight 0 by
// construction. Nothing has to remember to exclude it.
//
// --- WHAT IS DELIBERATELY NOT DONE ------------------------------------------
// A trait she has NO value for is UNASSESSABLE. It is reported by name and left
// out; it is never read as "0", which on the Canadian linear scale means breed
// average and would silently declare an unmeasured cow perfect.
//
// A trait the POOL has no spread on cannot be corrected by any bull in it. It is
// also reported by name and left out, rather than dividing by a zero sd.
// ---------------------------------------------------------------------------

/** One trait offered to the weakness scan, with the spread available to fix it. */
export interface WeaknessInput {
  code: string;
  label: string;
  /** HER value. null means unassessable — it is never guessed and never zeroed. */
  cowValue: number | null;
  /**
   * Where the POPULATION sits on this trait — the pool mean, not an assumed
   * origin. Required for directional traits, because the scales in this
   * database do not share one: measured over the 1,047 preferred evaluations,
   * LPI averages 3242, Pro$ 1433, the LPI subindexes 450-700, the functional
   * RBVs (DF, HL, MR, SCS, CA, DCA) 100, and only the linear traits and the
   * fat/protein percentages sit near 0. Defaulting this to 0 made
   * `max(0, 0 - cowValue)` identically zero for every trait with a positive
   * mean, so a cow could never be weak on Conformation, Daughter Fertility or
   * Milking Speed no matter how poor she was. Deriving it from the pool also
   * survives an LPI rebasing without a code change.
   *
   * null = we do not know where this trait's population sits, so the fault
   * cannot be measured -> the trait is reported as uncorrectable, never as 0.
   * Ignored for intermediate-optimum traits, which carry an explicit target.
   */
  mean: number | null;
  /** Spread of this trait across the bull pool. null or 0 = uncorrectable here. */
  sd: number | null;
}

/** One fault worth mating for, with everything needed to explain it. */
export interface Weakness {
  code: string;
  label: string;
  /** Her own value, on the trait's own scale. */
  cowValue: number;
  /** The daughter value aimed at, or null for a directional trait. */
  target: number | null;
  /** How far off she is, on the trait's OWN scale. This is the displayed number. */
  deficit: number;
  /** The same distance in pool standard deviations — the comparable magnitude. */
  deficitSd: number;
  /** The bull value that would land the daughter exactly on target. Null when
   *  directional: there the answer is "as high as you can get", not a number. */
  idealBull: number | null;
  /** Share of the correction term this fault carries. 0 unless acted on. */
  weight: number;
  /** One sentence a breeder can read, from correctionNote(). */
  note: string | null;
}

export interface WeaknessSet {
  /** The faults actually acted on, worst first. Their weights sum to 1. */
  weaknesses: Weakness[];
  /** Every fault found, worst first — including the ones past the cut, which
   *  carry weight 0. Shown so the report can say what it chose NOT to act on. */
  ranked: Weakness[];
  /** Traits she has no value for. Named, never guessed. */
  unassessable: { code: string; label: string }[];
  /** Traits she is weak on that this pool has no spread to fix. Named, never
   *  divided by. */
  uncorrectable: { code: string; label: string }[];
}

/**
 * Rank a cow's faults and hand the worst `topK` their share of the correction
 * weight. Pure: the caller supplies her values and the pool spreads.
 */
export function rankWeaknesses(
  inputs: WeaknessInput[],
  topK: number,
  lowerIsBetter: Set<string> = LOWER_IS_BETTER,
): WeaknessSet {
  const unassessable: { code: string; label: string }[] = [];
  const uncorrectable: { code: string; label: string }[] = [];
  const ranked: Weakness[] = [];

  for (const i of inputs) {
    if (i.cowValue == null || !Number.isFinite(i.cowValue)) {
      unassessable.push({ code: i.code, label: i.label });
      continue;
    }
    // A directional trait is measured against where the POPULATION sits, not
    // against an assumed origin — see WeaknessInput.mean. Without a centre the
    // fault is unmeasurable and must be named as such rather than scored 0,
    // which would quietly read as "she is fine here".
    const intermediate = isIntermediate(i.code);
    if (!intermediate && (i.mean == null || !Number.isFinite(i.mean))) {
      uncorrectable.push({ code: i.code, label: i.label });
      continue;
    }
    // For a lower-is-better trait the fault is being ABOVE the population, so
    // the comparison flips: reflect her through the centre and the same
    // "how far below" arithmetic applies.
    const centre = intermediate ? 0 : (i.mean as number);
    const value = !intermediate && lowerIsBetter.has(i.code)
      ? centre - (i.cowValue - centre)
      : i.cowValue;
    const d = deficit(i.code, value, centre);
    // Already where she should be. Weight 0 falls out of the arithmetic; there is
    // nothing here to remember to skip.
    if (!(d > 0)) continue;
    if (i.sd == null || !(i.sd > 1e-9)) {
      uncorrectable.push({ code: i.code, label: i.label });
      continue;
    }
    ranked.push({
      code: i.code,
      label: i.label,
      cowValue: i.cowValue,
      target: targetFor(i.code),
      deficit: d,
      deficitSd: d / i.sd,
      idealBull: idealBullValue(i.code, i.cowValue),
      weight: 0,
      note: correctionNote(i.code, i.label, i.cowValue, lowerIsBetter.has(i.code)),
    });
  }

  ranked.sort((a, b) => b.deficitSd - a.deficitSd || a.code.localeCompare(b.code));
  // The same objects appear in both lists on purpose: setting a weight below is
  // visible in `ranked` too, so the report can show weight 0 against the faults
  // that fell past the cut without holding two copies that can disagree.
  const weaknesses = ranked.slice(0, Math.max(0, Math.floor(topK)));
  const total = weaknesses.reduce((s, w) => s + w.deficitSd, 0);
  for (const w of weaknesses) w.weight = total > 0 ? w.deficitSd / total : 0;

  return { weaknesses, ranked, unassessable, uncorrectable };
}

/**
 * The correction term as a SelectedTrait[], so the fit values can be pushed
 * through poolTraitStats() and compositeScore() — the same two functions the
 * merit term uses, rather than a second standardisation that could drift from
 * the first.
 *
 * `higherIsBetter` is always true here: matingFit() has already turned every
 * trait, intermediate or directional, into a number where larger is better. A
 * second reversal at this point would undo it.
 */
export function correctionTraits(weaknesses: Weakness[]): SelectedTrait[] {
  return weaknesses.map((w) => ({
    code: w.code,
    label: w.label,
    col: "",
    weight: w.weight,
    higherIsBetter: true,
  }));
}

/**
 * The blended final score.
 *
 *     final = blend × meritZ + (1 − blend) × correctionZ
 *
 * Both terms are already in standard deviations of their own pool, so they are
 * on one scale and this addition is legitimate — unlike adding LPI to
 * Conformation, which is the defect at the top of this file.
 *
 * A null on EITHER side is null overall. A bull whose correction could not be
 * computed is not quietly ranked on merit alone at (1 − blend) of the score
 * missing: that would flatter him for exactly the traits nobody could read.
 * The one exception is a cow with NOTHING to correct — pass correctionZ = null
 * and blend = 1 for her, which the caller does explicitly.
 */
export function blendScores(meritZ: number | null, correctionZ: number | null, blend: number): number | null {
  const b = Math.min(Math.max(blend, MIN_BLEND), MAX_BLEND);
  if (b >= 1) return meritZ;
  if (b <= 0) return correctionZ;
  if (meritZ == null || correctionZ == null) return null;
  return b * meritZ + (1 - b) * correctionZ;
}
