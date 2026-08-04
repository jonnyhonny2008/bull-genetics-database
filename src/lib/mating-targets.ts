// ---------------------------------------------------------------------------
// Trait direction and targets for CORRECTIVE MATING.
//
// Pure module — no prisma, no "server-only" — so the scoring maths can be unit
// tested and the same table can be read from a tsx script.
//
// WHY THIS FILE EXISTS
// TraitDefinition.higherIsBetter is `true` for all 26 linear traits in the
// database. That is fine for a lineup ranking, where "more Fore Attachment" is
// unambiguously better, but it is WRONG for corrective mating on the traits
// below, where BOTH extremes are recognised faults. A cow at +10 Stature does
// not need a +12 Stature bull "to improve her weakness" — she needs a negative
// one, or her daughters get bigger still. Reading higherIsBetter alone would
// make the system confidently produce worse animals, so the direction used for
// mating is declared here rather than inferred from the trait table.
//
// THE CORRECTIVE FORMULA
// A daughter's expected value is the parent average, (cow + bull) / 2. To land
// her on `target`, the bull must therefore sit at
//
//      idealBull = 2 * target - cowValue
//
// which is `idealBullValue()` below. For a DIRECTIONAL trait there is no such
// turning point: the cow is weak if she is low, and the best bull is the
// highest one available, weighted by how weak she is.
//
// The Canadian linear scale is a deviation from breed average on [-15, +15], so
// 0 IS breed average and the targets below are read directly off that scale.
// ---------------------------------------------------------------------------

/**
 * Linear traits where both extremes are faults, with the value we aim the
 * DAUGHTER at. Anything not listed here is treated as directional (higher is
 * better, or lower for the few LOWER_IS_BETTER codes the ranking already knows).
 *
 * These are editable on purpose — they are breeding policy, not arithmetic.
 * Every number is a judgement call and is justified in its comment.
 */
export const INTERMEDIATE_TARGETS: Record<string, number> = {
  // Short -> Tall. Deliberately 0, NOT the "slightly above average" default.
  // Stature is the one linear trait where more is actively expensive: feed
  // cost, stall fit and longevity all move the wrong way with size, and the
  // industry has spent a decade breeding away from the tall cow. Raise this if
  // the stud's market genuinely rewards frame.
  STA: 0,

  // Shallow -> Deep. A little capacity is wanted; an extremely deep-bodied cow
  // loses it again in longevity and mobility.
  BODY: 1,

  // High pins -> Sloped. A slight slope drains the reproductive tract and helps
  // calving. High pins are a fault; an extreme slope is a different fault.
  RA: 2,

  // Straight/posty -> Sickled. The textbook intermediate trait: posty legs and
  // sickled legs are BOTH classified down. Middle of the scale is correct, with
  // the faintest lean toward straight for mobility.
  RLSV: 0,

  // Wide -> Close. Slightly close sits the teats under the quarters for machine
  // fit. Too close and the cluster crowds; too wide and it slips.
  FTP: 2,
  RTP: 2,

  // Short -> Long. Medium is ideal. Short teats cup badly, long teats injure
  // and slow milk-out. Neither end is a goal.
  TL: 0,
};

/** Traits where the mating logic aims at a target rather than a maximum. */
export function isIntermediate(traitCode: string): boolean {
  return Object.prototype.hasOwnProperty.call(INTERMEDIATE_TARGETS, traitCode.toUpperCase());
}

/** The daughter value we aim at, or null for a directional trait. */
export function targetFor(traitCode: string): number | null {
  const t = INTERMEDIATE_TARGETS[traitCode.toUpperCase()];
  return t === undefined ? null : t;
}

/**
 * The bull value that would land the daughter exactly on target, given the
 * cow's own value. Returns null for a directional trait, where there is no
 * single ideal — the answer there is simply "as high as you can get".
 *
 *   cow +10 STA, target 0  ->  ideal bull -10   (pull her back)
 *   cow  -8 STA, target 0  ->  ideal bull  +8   (bring her up)
 */
export function idealBullValue(traitCode: string, cowValue: number): number | null {
  const target = targetFor(traitCode);
  return target === null ? null : 2 * target - cowValue;
}

/**
 * How badly this cow needs help on this trait, as a positive magnitude on the
 * trait's own scale. Drives the correction weighting: the further she is from
 * where she should be, the more the mating leans on fixing it.
 *
 * Intermediate: distance from target in EITHER direction.
 * Directional : how far BELOW the reference she sits (0 if at or above it);
 *               a cow who is already strong needs no correction there.
 */
export function deficit(traitCode: string, cowValue: number, directionalReference = 0): number {
  const target = targetFor(traitCode);
  if (target !== null) return Math.abs(cowValue - target);
  return Math.max(0, directionalReference - cowValue);
}

/**
 * How well a bull serves this cow on this trait, normalised so that larger is
 * always better regardless of trait type. Kept on the trait's own scale — the
 * caller standardises across traits before combining them, because raw LPI and
 * raw Conformation are not commensurable (see mating-score).
 *
 * Intermediate: negative distance of the PROJECTED DAUGHTER from target, so the
 *               best bull is the one landing her closest to ideal — which for a
 *               cow already past target means a bull BELOW her, not above.
 * Directional : the projected daughter's value itself.
 */
export function matingFit(
  traitCode: string,
  cowValue: number,
  bullValue: number,
  lowerIsBetter = false,
): number {
  const daughter = (cowValue + bullValue) / 2;
  const target = targetFor(traitCode);
  if (target !== null) return -Math.abs(daughter - target);
  return lowerIsBetter ? -daughter : daughter;
}

/**
 * Human-readable direction for the UI, so a recommendation can explain itself:
 * "she is +9 — needs a bull below average to bring her back".
 */
export function correctionNote(
  traitCode: string,
  traitLabel: string,
  cowValue: number,
  lowerIsBetter = false,
): string | null {
  const target = targetFor(traitCode);
  if (target === null) {
    if (lowerIsBetter) return cowValue > 0 ? `${traitLabel}: ${fmt(cowValue)} — looking for lower.` : null;
    return cowValue < 0 ? `${traitLabel}: ${fmt(cowValue)} — looking for higher.` : null;
  }
  const gap = cowValue - target;
  if (Math.abs(gap) < 1) return null; // already on target; nothing to correct
  const ideal = 2 * target - cowValue;
  return gap > 0
    ? `${traitLabel}: ${fmt(cowValue)} is above the ${fmt(target)} target — needs a bull near ${fmt(ideal)} to come back.`
    : `${traitLabel}: ${fmt(cowValue)} is below the ${fmt(target)} target — needs a bull near ${fmt(ideal)}.`;
}

const fmt = (n: number) => (n > 0 ? `+${round1(n)}` : `${round1(n)}`);
const round1 = (n: number) => Math.round(n * 10) / 10;
