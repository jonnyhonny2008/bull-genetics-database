// ---------------------------------------------------------------------------
// The American linear type chart — bounds, end descriptors, and which end is good.
//
// THE AXIS IS ±3, on the owner's instruction, and it is worth naming as a display
// choice rather than a measurement. CDCB publishes type traits as standardised
// deviations, so ±3 covers the working spread of the breed and leaves the extremes
// at the rail. A value beyond it is CLAMPED to the end of the track — which is
// exactly why the real figure is printed beside every bar and never dropped.
//
// THE END DESCRIPTORS ARE THE BREED'S, NOT OURS. prisma/traits-holstein.ts already
// seeds this vocabulary for the Canadian card, and the two associations describe
// the same animal in the same words and the same order. Reusing them is what stops
// one bull's two cards from disagreeing about which way "wide" points.
//
// DIRECTION IS NOT DECIDED HERE. It is read from US_TRAIT_CATALOG, so the
// chart, the specialist finder and the trait tables cannot drift apart. That
// matters most on the traits whose good end is the LOW one: shading by sign would
// paint a correctly short bull in the warning colour, and a reader takes the
// picture, not the caption.
// ---------------------------------------------------------------------------

import type { LinearTraitDatum } from "@/components/LinearGraph";
import { usTrait } from "./trait-catalog";

export const US_LINEAR_MIN = -3;
export const US_LINEAR_MAX = 3;

/** code -> [descriptor at the negative end, descriptor at the positive end]. */
export const US_LINEAR_ENDS: Record<string, [string, string]> = {
  // Udder
  FUA: ["Weak", "Strong"],
  RUH: ["Low", "High"],
  RUW: ["Narrow", "Wide"],
  UCL: ["Weak", "Strong"],
  UDP: ["Deep", "Shallow"],
  FTP: ["Wide", "Close"],
  RTP: ["Wide", "Close"],
  TLG: ["Short", "Long"],
  // Feet & legs
  FTA: ["Low", "Steep"],
  RLR: ["Hocked in", "Parallel"],
  RLS: ["Posty", "Sickled"],
  // Body
  STA: ["Short", "Tall"],
  STR: ["Frail", "Strong"],
  BDE: ["Shallow", "Deep"],
  TRW: ["Narrow", "Wide"],
  RPA: ["High pins", "Sloped"],
  DFM: ["Lacks", "Angular"],
};

/**
 * PTAT and FLS are deliberately absent. Both are composite SCORES rather than a
 * trait measured between two named extremes, so there is no honest pair of
 * descriptors to hang on the ends of a track. They stay in the table below the
 * chart, where a number needs no axis.
 */
export const US_LINEAR_SECTIONS: { group: string; codes: string[] }[] = [
  { group: "Overall & udder", codes: ["FUA", "RUH", "RUW", "UCL", "UDP", "FTP", "RTP", "TLG"] },
  { group: "Feet & legs", codes: ["FTA", "RLR", "RLS"] },
  { group: "Body", codes: ["STA", "STR", "BDE", "TRW", "RPA", "DFM"] },
];

/** Where the app's reasoned direction puts the better animal on the track. */
export function usFavourableEnd(code: string): LinearTraitDatum["favourable"] {
  switch (usTrait(code)?.direction) {
    case "higher": return "right";
    case "lower": return "left";
    case "intermediate": return "intermediate";
    // An unrecognised or unconfirmed trait claims nothing: it falls back to plain
    // sign shading rather than asserting a direction we have not established.
    default: return undefined;
  }
}

export function usLinearGroups(gpta: Record<string, number>): { group: string; traits: LinearTraitDatum[] }[] {
  return US_LINEAR_SECTIONS.map((s) => ({
    group: s.group,
    traits: s.codes.flatMap((code): LinearTraitDatum[] => {
      const ends = US_LINEAR_ENDS[code];
      const v = gpta[code];
      if (!ends || typeof v !== "number" || !Number.isFinite(v)) return [];
      return [{
        name: usTrait(code)?.name ?? code,
        value: Number(v.toFixed(2)),
        min: US_LINEAR_MIN,
        max: US_LINEAR_MAX,
        left: ends[0],
        right: ends[1],
        favourable: usFavourableEnd(code),
      }];
    }),
  })).filter((g) => g.traits.length > 0);
}
