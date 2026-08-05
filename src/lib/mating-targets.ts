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

// ---------------------------------------------------------------------------
// CORRECTION ELIGIBILITY — which traits a mating actually tries to FIX, and the
// reference that separates "weak" from "fine" and "positive" from "negative".
//
// This is the table the never-worsen floor and the weakness scan read. It is
// breeding policy, like INTERMEDIATE_TARGETS above, and every base is a
// deliberate choice justified in its comment — never inferred from the trait
// table, because TraitDefinition carries no base and higherIsBetter is wrong for
// the intermediate traits (see the note at the top of this file).
//
// WHY A PER-TRAIT BASE, NOT ONE NUMBER
// The evaluations in this database do not share a scale. Measured over the
// preferred proofs: the functional RBVs (DF, MSPD, MR, HL …) sit at 100, SCS at
// about 3.0, and the linear type traits and the fat/protein percentages near 0.
// "Positive" therefore means a different number on each — a bull "positive for
// Daughter Fertility" is one above 100, "positive for Bone Quality" one above 0.
// Reading a single origin for all of them is the exact bug WeaknessInput.mean was
// added to kill (see mating-score.ts): with base 0, no cow could ever be weak on
// a 100-based trait. The composite indexes Conformation and Mammary have no clean
// published base here (they read ~12-15, not 0), so they carry base "pool" and
// take the candidate-pool mean as their centre instead.
//
// LPI and Pro$ are ABSENT on purpose. They are aggregate money indexes you
// MAXIMISE, not faults you fix; they drive the merit half of the ranking, never
// the correction floor. A bull is never set aside for "worsening her LPI".
// ---------------------------------------------------------------------------

export interface CorrectionTrait {
  code: string;
  label: string;
  /** The reference point. A number is a published/breed base; "pool" means take
   *  the candidate-pool mean, for the composites that have no fixed base here. */
  base: number | "pool";
  lowerIsBetter: boolean;
  /** true = lives only inside traitsJson (no indexed GeneticEvaluation column),
   *  so the floor on it runs on the recommended shortlist, not pool-wide. */
  deep: boolean;
  /** true = intermediate optimum; the goal is the INTERMEDIATE_TARGETS value,
   *  and BOTH extremes are faults. `base` is that target. */
  intermediate?: boolean;
}

export const CORRECTION_TRAITS: CorrectionTrait[] = [
  // --- indexed (a GeneticEvaluation column exists → floored across the pool) ---
  // Production is a deviation in kg around the breed base of 0; more is the
  // improvement a cow low on components needs.
  { code: "MILK", label: "Milk", base: 0, lowerIsBetter: false, deep: false },
  { code: "FAT", label: "Fat", base: 0, lowerIsBetter: false, deep: false },
  { code: "PROT", label: "Protein", base: 0, lowerIsBetter: false, deep: false },
  // The fat/protein percentages sit near 0; a negative one genuinely dilutes.
  { code: "FATPCT", label: "Fat %", base: 0, lowerIsBetter: false, deep: false },
  { code: "PROTPCT", label: "Protein %", base: 0, lowerIsBetter: false, deep: false },
  // Functional RBV, base 100. This is one of the three the meeting cow needs.
  { code: "DF", label: "Daughter Fertility", base: 100, lowerIsBetter: false, deep: false },
  // Somatic Cell — LOWER is healthier. Its scale is not fixed here: some rounds
  // publish the ~3.0 score, others a ~100 index, so the base is the POOL MEAN
  // rather than a hard-coded number that is right for one and nonsense for the
  // other. The never-worsen floor is base-independent, so it is correct either
  // way; only "is she weak" and the goal text read this.
  { code: "SCS", label: "SCS", base: "pool", lowerIsBetter: true, deep: false },
  // Conformation and Mammary are composites with no clean fixed base here
  // (they read ~12-15), so their centre is the pool mean. Still floored, because
  // Blondin breeds for type and a bull who lowers her class is a real setback.
  { code: "CONF", label: "Conformation", base: "pool", lowerIsBetter: false, deep: false },
  { code: "MAMM", label: "Mammary", base: "pool", lowerIsBetter: false, deep: false },

  // --- deep (traitsJson only → floored on the recommended shortlist) ----------
  // Milking Speed: functional RBV, base 100. The second of the meeting cow's
  // three needs, and the KEY trait with no indexed column.
  { code: "MSPD", label: "Milking Speed", base: 100, lowerIsBetter: false, deep: true },
  // Bone Quality: linear type, deviation base 0, higher = flatter/cleaner bone.
  // The third of the meeting cow's needs.
  { code: "BQ", label: "Bone Quality", base: 0, lowerIsBetter: false, deep: true },
];

// The intermediate linear traits are correction-eligible too — their base IS the
// INTERMEDIATE_TARGETS value, and they are all deep (no indexed column). Built
// from the same table so the two cannot fall out of step.
const INTERMEDIATE_LABELS: Record<string, string> = {
  STA: "Stature", BODY: "Body Depth", RA: "Rump Angle", RLSV: "Rear Legs Side View",
  FTP: "Front Teat Placement", RTP: "Rear Teat Placement", TL: "Teat Length",
};
for (const code of Object.keys(INTERMEDIATE_TARGETS)) {
  CORRECTION_TRAITS.push({
    code,
    label: INTERMEDIATE_LABELS[code] ?? code,
    base: INTERMEDIATE_TARGETS[code],
    lowerIsBetter: false,
    deep: true,
    intermediate: true,
  });
}

const CORRECTION_BY_CODE = new Map(CORRECTION_TRAITS.map((t) => [t.code, t]));

/** The correction policy for a trait, or null if it is not one we fix. */
export function correctionTrait(code: string): CorrectionTrait | null {
  return CORRECTION_BY_CODE.get(code.toUpperCase()) ?? null;
}

/**
 * The reference point for judging weak-vs-fine and positive-vs-negative on this
 * trait. For a "pool"-based composite the caller passes the pool mean; it is used
 * only then, so an unknown pool mean (null) leaves the trait uncorrectable rather
 * than silently centred on 0.
 */
export function correctionCentre(code: string, poolMean: number | null): number | null {
  const t = correctionTrait(code);
  if (!t) return null;
  if (t.intermediate) return t.base as number; // the target itself
  return t.base === "pool" ? poolMean : (t.base as number);
}

const EPS = 1e-9;

/**
 * True when this bull would push the projected daughter AWAY from where the cow
 * already sits on the trait — i.e. make an existing weakness worse. This is the
 * never-worsen floor, and it is deliberately base-INDEPENDENT: it compares the
 * daughter's fit with the cow's own, so it is well defined for every trait
 * (intermediate, directional or lower-is-better) whether or not we know its base.
 *
 *   directional higher : worse ⟺ bull below the cow      (daughter drops)
 *   lower-is-better     : worse ⟺ bull above the cow      (daughter rises)
 *   intermediate        : worse ⟺ daughter further from target than the cow
 */
export function worsensWeakness(code: string, cowValue: number, bullValue: number, lowerIsBetter = false): boolean {
  const held = matingFit(code, cowValue, cowValue, lowerIsBetter); // her own line, unchanged
  const daughter = matingFit(code, cowValue, bullValue, lowerIsBetter);
  return daughter < held - EPS;
}

/** True when the projected daughter is strictly BETTER on the trait than the cow
 *  — the bull moves her fault in the right direction, however far. */
export function improvesWeakness(code: string, cowValue: number, bullValue: number, lowerIsBetter = false): boolean {
  const held = matingFit(code, cowValue, cowValue, lowerIsBetter);
  const daughter = matingFit(code, cowValue, bullValue, lowerIsBetter);
  return daughter > held + EPS;
}

/**
 * True when the bull is himself POSITIVE for the trait — on the good side of its
 * base. This is the strict "only bulls that are positive" test.
 *
 * For an intermediate trait "positive" has no meaning (both extremes are faults),
 * so the strict test there is simply that he IMPROVES her — lands the daughter
 * closer to target than she is now.
 */
export function isPositiveImprover(
  code: string,
  cowValue: number,
  bullValue: number,
  centre: number,
  lowerIsBetter = false,
): boolean {
  const t = correctionTrait(code);
  if (t?.intermediate) return improvesWeakness(code, cowValue, bullValue, lowerIsBetter);
  return lowerIsBetter ? bullValue < centre - EPS : bullValue > centre + EPS;
}
