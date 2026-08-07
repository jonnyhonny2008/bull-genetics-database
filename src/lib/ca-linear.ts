// ---------------------------------------------------------------------------
// CANADIAN INTERMEDIATE-OPTIMUM TYPE TRAITS.
//
// The Canadian proof prints its linear traits in two blocks, and the second one
// is headed INTERMEDIATE OPTIMUM: ten traits where the middle of the scale is the
// target and BOTH extremes are faults. A bull is not a better bull for being
// further right on any of them, which is exactly what an ordinary linear bar
// implies — so they are drawn neutral and badged rather than shaded good/bad.
//
// THE LIST IS THE BREED'S, NOT A DERIVATION. It comes from the Canadian linear
// chart itself (owner-supplied, 2026-08-07), which is why it is written out
// literally instead of inferred from higherIsBetter. A boolean cannot express a
// third state, and guessing one from index weights is how Stature ended up
// mislabelled before.
//
// WHY THIS IS NOT SHARED WITH THE AMERICAN CATALOGUE. The two associations do not
// agree about these traits, and that disagreement is real rather than a bug to be
// reconciled: see us-cdcb/specialists.ts, where Stature and Rear Teat Placement
// carry a stated direction on the owner's instruction for the US index. One bull
// can legitimately read "intermediate" on his Canadian card and "lower is better"
// on his American one. Merging the two lists would silently overwrite one
// country's convention with the other's.
// ---------------------------------------------------------------------------

import type { LinearTraitDatum } from "@/components/LinearGraph";

/** Trait codes, as seeded by prisma/traits-holstein.ts. */
export const CA_INTERMEDIATE_OPTIMUM = new Set<string>([
  "UFLOOR", // Udder Floor — Tilt … Reverse Tilt
  "UDEP",   // Udder Depth — Deep … Shallow
  "FTP",    // Front (Fore) Teat Placement — Wide … Close
  "RTP",    // Rear Teat Placement — Wide … Close
  "TL",     // Teat Length — Short … Long
  "RLSV",   // Rear Legs Side View — Straight … Curved
  "FLV",    // Front Leg View — Knock Kneed … Straight
  "STA",    // Stature — Short … Tall
  "RA",     // Rump Angle — High … Low
  "THURL",  // Thurl Placement — Back … Ahead
]);

/**
 * The same ten by NAME, normalised. A safety net, not a duplicate: the codes above
 * are this repo's seed codes, and a trait renamed or re-coded upstream would
 * otherwise drop out of the list silently and start being drawn as if one end were
 * better. Both spellings of the two traits the chart and the seed disagree on are
 * present ("front"/"fore" teat placement, "front leg"/"front legs" view).
 */
const CA_INTERMEDIATE_NAMES = new Set<string>([
  "udder floor",
  "udder depth",
  "front teat placement", "fore teat placement",
  "rear teat placement",
  "teat length",
  "rear legs side view",
  "front leg view", "front legs view",
  "stature",
  "rump angle",
  "thurl placement",
]);

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

/** True when the Canadian chart treats this trait as an intermediate optimum. */
export function isCaIntermediateOptimum(traitCode: string, traitName?: string | null): boolean {
  if (CA_INTERMEDIATE_OPTIMUM.has(traitCode.toUpperCase())) return true;
  return traitName ? CA_INTERMEDIATE_NAMES.has(normalise(traitName)) : false;
}

/**
 * Which end of a Canadian linear track holds the better animal.
 *
 * `higherIsBetter` comes from the trait's own configuration row, so a trait whose
 * good end is the LOW one (Udder Depth is seeded Deep…Shallow, for instance) keeps
 * whatever the configuration says rather than being assumed upward here.
 */
export function caFavourableEnd(
  traitCode: string,
  traitName: string | null | undefined,
  higherIsBetter: boolean | null | undefined,
): LinearTraitDatum["favourable"] {
  if (isCaIntermediateOptimum(traitCode, traitName)) return "intermediate";
  if (higherIsBetter === true) return "right";
  if (higherIsBetter === false) return "left";
  return undefined; // unconfigured — shaded by sign, claiming nothing
}
