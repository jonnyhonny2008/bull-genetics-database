// ---------------------------------------------------------------------------
// THE AMERICAN TRAIT CATALOGUE — every CDCB code this app has seen, with its
// NAME, its GROUP and, above all, WHICH WAY IS BETTER.
//
// This is the repository's single reasoned source for trait direction. The
// linear graphs, the bull card's trait tables, the range picker and the genetics
// agent all read it, which is the point: a bull's Stature must not be shaded
// "good" on one screen and "neutral" on another.
//
// It was called `specialists.ts` until the Specialists finder was replaced by
// range filters. The finder is gone; the catalogue outlived it because direction
// was never really a property of that feature. If you are removing the last of
// the specialist code, THIS FILE IS NOT PART OF IT.
//
// DIRECTION IS NOT DERIVABLE FROM THE DATA, so nothing but the catalogue and its
// test (trait-direction.test.ts) protects these calls from being "tidied" into a
// symmetric-looking list later.
//
// INTERMEDIATE-OPTIMUM CALLS. Rump Angle is the one the product rules name, but
// it is not alone, and the evidence is in this codebase's own index formulas:
// index-registry.ts transforms TLG and RLS through TLstar/SVstar — curves that
// PEAK and then fall away — precisely because credit stops at an optimum, and
// jpi.ts scores UDP as distance from an optimum outright.
//
// STATURE, RUMP ANGLE AND REAR TEAT PLACEMENT ARE INTERMEDIATE OPTIMUM HERE TOO —
// the owner's call, 2026-08-07, and it now matches the Canadian chart exactly (see
// lib/ca-linear.ts). Both extremes are faults on all three: neither the tallest
// bull nor the shortest is the target. Dairy Form is the one trait of the four
// that keeps a direction — higher is better.
//
// The arithmetic agrees. index-registry.ts already runs RTP through RPstar, a
// curve that PEAKS at 1.0 and falls away after it, and subtracts 0.20 x STA from
// both UDC and FLC — published formulas that stop rewarding a trait past a point
// are describing an optimum, not a direction.
//
// WHAT THIS DOES NOT CHANGE: those composite formulas stay exactly as HAUSA
// publishes them. They are someone else's arithmetic computed on their behalf, and
// a house preference must never edit one.
// ---------------------------------------------------------------------------

/** Which way is better for a CDCB trait. Mirrors TraitDirection in key-traits.ts. */
export type UsTraitDirection = "higher" | "lower" | "intermediate" | "unknown";

export interface UsTraitInfo {
  code: string;
  name: string;
  /** Section label wherever traits are grouped. */
  group: string;
  direction: UsTraitDirection;
  unit: string | null;
  /**
   * A warning that must travel with the trait wherever it is ranked, sorted or
   * shaded good/bad. Set on exactly the traits where sorting high-to-low and
   * reading the top of the list gives the WRONG bull — the intermediate optima,
   * the unconfirmed codes, and the lower-is-better traits that CDCB does not
   * publish as a deviation from zero.
   *
   * `direction` still says which way is better; this says why naive use of it
   * misleads. Shown verbatim, so a trait that cannot simply be ranked says why.
   */
  caution?: string;
}

export const WHY_INTERMEDIATE =
  "Intermediate optimum — neither the highest nor the lowest value is best, so there is no bull to find at the top of the list.";
export const WHY_DOWN =
  "Favourable direction is down, and CDCB does not publish it as a deviation from zero. Ranking it high-to-low would name the worse bull. A range handles it correctly by asking for a ceiling instead of a floor.";
export const WHY_UNCONFIRMED =
  "CDCB publishes this code, but we have not confirmed what it measures or which way is better. Left unranked rather than guessed at.";

export const US_TRAIT_CATALOG: UsTraitInfo[] = [
  // --- Production -----------------------------------------------------------
  { code: "MILK", name: "Milk", group: "Production", direction: "higher", unit: "lb" },
  { code: "FAT", name: "Fat", group: "Production", direction: "higher", unit: "lb" },
  { code: "PRO", name: "Protein", group: "Production", direction: "higher", unit: "lb" },
  { code: "FATPCT", name: "Fat %", group: "Production", direction: "higher", unit: "%" },
  { code: "PROPCT", name: "Protein %", group: "Production", direction: "higher", unit: "%" },

  // --- Merit indexes --------------------------------------------------------
  { code: "NM", name: "Net Merit", group: "Merit indexes", direction: "higher", unit: "$" },
  { code: "CM", name: "Cheese Merit", group: "Merit indexes", direction: "higher", unit: "$" },
  { code: "FM", name: "Fluid Merit", group: "Merit indexes", direction: "higher", unit: "$" },
  { code: "GM", name: "Grazing Merit", group: "Merit indexes", direction: "higher", unit: "$" },

  // --- Fitness & efficiency -------------------------------------------------
  { code: "PL", name: "Productive Life", group: "Fitness & efficiency", direction: "higher", unit: "mo" },
  { code: "LIV", name: "Cow Livability", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "HLV", name: "Heifer Livability", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "DPR", name: "Daughter Pregnancy Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "CCR", name: "Cow Conception Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "HCR", name: "Heifer Conception Rate", group: "Fitness & efficiency", direction: "higher", unit: "%" },
  { code: "EFC", name: "Early First Calving", group: "Fitness & efficiency", direction: "higher", unit: "d" },
  { code: "FS", name: "Feed Saved", group: "Fitness & efficiency", direction: "higher", unit: "lb" },
  { code: "MSPD", name: "Milking Speed", group: "Fitness & efficiency", direction: "higher", unit: "lb/min" },
  // A range CAN filter these two — ask for a ceiling instead of a floor — which is
  // exactly what the finder they used to be excluded from could not do.
  { code: "SCS", name: "Somatic Cell Score", group: "Fitness & efficiency", direction: "lower", unit: null, caution: WHY_DOWN },
  { code: "RFI", name: "Residual Feed Intake", group: "Fitness & efficiency", direction: "lower", unit: "lb", caution: WHY_DOWN },
  {
    code: "GL", name: "Gestation Length", group: "Fitness & efficiency", direction: "intermediate", unit: "d",
    caution: "Neither direction is uniformly favourable — a shorter gestation frees days but a very short one costs calf vigour — so there is no end of the list to rank.",
  },

  // --- Calving ability (published as % of hard births / stillbirths) ---------
  { code: "SCE", name: "Service Sire Calving Ease", group: "Calving", direction: "lower", unit: "%", caution: WHY_DOWN },
  { code: "DCE", name: "Daughter Calving Ease", group: "Calving", direction: "lower", unit: "%", caution: WHY_DOWN },
  { code: "SSB", name: "Service Sire Stillbirth", group: "Calving", direction: "lower", unit: "%", caution: WHY_DOWN },
  { code: "DSB", name: "Daughter Stillbirth", group: "Calving", direction: "lower", unit: "%", caution: WHY_DOWN },

  // --- Disease resistance (deviations in % resistant — more is better) -------
  { code: "MAS", name: "Mastitis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "MET", name: "Metritis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "RPL", name: "Retained Placenta resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "KET", name: "Ketosis resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "DAB", name: "Displaced Abomasum resistance", group: "Disease resistance", direction: "higher", unit: "%" },
  { code: "MFV", name: "Milk Fever resistance", group: "Disease resistance", direction: "higher", unit: "%" },

  // --- Type: overall & udder ------------------------------------------------
  { code: "PTAT", name: "Type (PTAT)", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "FUA", name: "Fore Udder Attachment", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "RUH", name: "Rear Udder Height", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "RUW", name: "Rear Udder Width", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "UCL", name: "Udder Cleft", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "FTP", name: "Front Teat Placement", group: "Type — overall & udder", direction: "higher", unit: null },
  { code: "UDP", name: "Udder Depth", group: "Type — overall & udder", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },
  // Scale runs Wide (−) to Close (+). Both ends are faults; RPstar peaks and falls.
  { code: "RTP", name: "Rear Teat Placement", group: "Type — overall & udder", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },
  { code: "TLG", name: "Teat Length", group: "Type — overall & udder", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },

  // --- Type: feet & legs ----------------------------------------------------
  { code: "FLS", name: "Feet & Legs Score", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "FTA", name: "Foot Angle", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "RLR", name: "Rear Legs, Rear View", group: "Type — feet & legs", direction: "higher", unit: null },
  { code: "RLS", name: "Rear Legs, Side View", group: "Type — feet & legs", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },

  // --- Type: body -----------------------------------------------------------
  { code: "STR", name: "Strength", group: "Type — body", direction: "higher", unit: null },
  { code: "BDE", name: "Body Depth", group: "Type — body", direction: "higher", unit: null },
  { code: "TRW", name: "Thurl Width", group: "Type — body", direction: "higher", unit: null },
  { code: "RPA", name: "Rump Angle", group: "Type — body", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },
  // Scale runs Short (−) to Tall (+). Moderate is the target; UDC and FLC both subtract STA.
  { code: "STA", name: "Stature", group: "Type — body", direction: "intermediate", unit: null, caution: WHY_INTERMEDIATE },
  { code: "DFM", name: "Dairy Form", group: "Type — body", direction: "higher", unit: null },

  // --- Published, but not identified ---------------------------------------
  { code: "MSP", name: "MSP", group: "Unidentified", direction: "unknown", unit: null, caution: WHY_UNCONFIRMED },
  { code: "RTS", name: "RTS", group: "Unidentified", direction: "unknown", unit: null, caution: WHY_UNCONFIRMED },
];

/** The traits that can simply be sorted high-to-low with the best bull on top. */
export const US_SAFELY_RANKED_TRAITS = US_TRAIT_CATALOG.filter((t) => !t.caution);

/** The rest, grouped by the reason they cannot, for a page to explain. */
export function usTraitCautions(): { why: string; traits: UsTraitInfo[] }[] {
  const m = new Map<string, UsTraitInfo[]>();
  for (const t of US_TRAIT_CATALOG) {
    if (!t.caution) continue;
    const a = m.get(t.caution) ?? [];
    a.push(t);
    m.set(t.caution, a);
  }
  return [...m.entries()].map(([why, traits]) => ({ why, traits }));
}

export function usTrait(code: string): UsTraitInfo | undefined {
  return US_TRAIT_CATALOG.find((t) => t.code === code.toUpperCase());
}
