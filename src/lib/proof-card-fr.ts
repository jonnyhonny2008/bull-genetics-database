// ---------------------------------------------------------------------------
// Proof Card — French label/translation tables for BOTH the CA and US cards.
//
// PURE DATA. No PDF/react code, no locale-switching logic — that wiring (a
// `locale` parameter on CaProofCardPdf/UsProofCardPdf) is explicitly a later
// review/integration phase's job, not this one's. This file only has to be
// correct and complete enough for that phase to consume without having to
// come back here and add missing keys.
//
// TRAIT-CODE KEYS, NOT DISPLAY-NAME KEYS. linearTraitNames/linearDescriptors
// below are keyed by the real TraitDefinition.traitCode (CA) or CDCB code
// (US) — the same codes proof-card-ca.ts's CaLinearRow.code and
// proof-card-us.ts's UsLinearRow.code already carry — so a consumer can look
// up a row's French name with `FR_CA_LABELS.linearTraitNames[row.code]`
// without a second name-matching step.
// ---------------------------------------------------------------------------

/** English descriptor word/phrase -> French, shared where the CA and US
 *  linear charts happen to use the identical English word for the same
 *  conformation concept (e.g. both call a narrow trait "Narrow"). Kept as one
 *  dictionary so "Weak" or "Deep" is not translated two different ways on the
 *  two cards. CA- and US-only words are added on top of this in each card's
 *  own `linearDescriptors` below. Standard French Canadian dairy appraisal
 *  vocabulary; genuinely uncertain entries are flagged inline as best-effort
 *  rather than a confirmed official term. */
const COMMON_LINEAR_DESCRIPTORS: Record<string, string> = {
  Weak: "Faible",
  Strong: "Forte",
  Low: "Bas",
  High: "Haut",
  Narrow: "Étroit",
  Wide: "Large",
  Deep: "Profond",
  Shallow: "Peu profond",
  Close: "Rapprochés",
  Short: "Court",
  Long: "Long",
  Steep: "Raide",
  "Hocked in": "Jarrets rentrés",
  Parallel: "Parallèles",
  Sickled: "Courbés",
  Tall: "Grande",
  "High pins": "Ischions hauts",
  Sloped: "Inclinée",
  // Rib Structure/Angularity and Dairy Form both read Lacks…Angular — "lacks
  // [angularity]" at the weak end.
  Lacks: "Manque d'angularité",
  Angular: "Anguleuse",
  // Every composite row (CA's CONF/MAMM/FL/DS/RUMP and US's PTAT/UDC/FLC/BSC)
  // uses this exact pair — shared so it is translated once, not per-country.
  Poor: "Faible",
  Excellent: "Excellent",
};

/**
 * Section/group-header translations for the linear chart's group-divider rows
 * (LinearChartTable draws one whenever row.group changes — see
 * proof-card-shared.tsx). Keyed by the EXACT group string the data layers
 * emit, since that string is what a French-locale template would look up
 * directly (row.group -> groupNames[row.group]).
 */
export const CA_GROUP_NAMES: Record<string, string> = {
  "Composite Indexes": "Indices composites", // proof-card-ca.ts's own 5-row group, added this session
  "Mammary System": "Système mammaire",
  "Feet & Legs": "Pieds et membres",
  "Dairy Strength": "Puissance laitière",
  Rump: "Croupe",
};

export const US_GROUP_NAMES: Record<string, string> = {
  "Type Composites": "Indices composites", // proof-card-us.ts's own composite-rows group
  "Overall & udder": "Ensemble et pis",
  "Feet & legs": "Pieds et membres",
  Body: "Corps",
};

// ---------------------------------------------------------------------------
// CANADA
// ---------------------------------------------------------------------------

export interface FrCaLabels {
  title: string;
  lifetimePerformance: string;
  gpaLpi: string;
  proDollar: string;
  production: string;
  functionalTraits: string;
  reliability: string;
  dataSuppliedBy: string;
  proofDate: string;
  typeReliability: string;
  milk: string;
  fat: string;
  protein: string;
  /** In proof-card-ca.ts's functionalLeft column order (FE, HL, MR, MDR, HH, LP). */
  functionalLeft: string[];
  /** In proof-card-ca.ts's functionalRight column order (DF, MSPD, MTMP, CA, DCA, BCS). */
  functionalRight: string[];
  dtrsHerds: string;
  /** Keyed by TraitDefinition.traitCode, as seeded by prisma/traits-holstein.ts
   *  and prisma/seed-config.ts. Trait NAME only — descriptor pairs are the
   *  separate linearDescriptors map below, since one trait's descriptor word
   *  (e.g. "Deep") can recur on a different trait with a different meaning. */
  linearTraitNames: Record<string, string>;
  /** English descriptor word/phrase, EXACTLY as it appears in
   *  prisma/traits-holstein.ts's leftLabel/rightLabel (the real values this
   *  database stores) -> French. See the file-level ambiguity note for why
   *  this deliberately does NOT key off this task's own worked examples where
   *  they name a different English word than the seed file does. */
  linearDescriptors: Record<string, string>;
}

export const FR_CA_LABELS: FrCaLabels = {
  title: "CHIFFRES CANADIENS",
  lifetimePerformance: "Performance à Vie",
  gpaLpi: "IPV MPG",
  proDollar: "PRO $",
  production: "Production",
  functionalTraits: "Fonctionnels",
  reliability: "Fiab",
  dataSuppliedBy: "Données fournies par CDN",
  proofDate: "Date de l'épreuve",
  typeReliability: "Fiabilité",
  milk: "Lait",
  fat: "Gras",
  protein: "Protéine",

  functionalLeft: [
    "Efficacité Alimentaire",       // Feed Efficiency
    "Durée de Vie",                 // Herd Life
    "Résistance à la Mammite",      // Mastitis Resistance
    "Maladies Métaboliques",        // Metabolic Disease Resistance
    "Santé des Onglons",            // Hoof Health
    "Persistance de la Lactation",  // Lactation Persistency
  ],
  functionalRight: [
    "Fertilité des Filles",             // Daughter Fertility
    "Vitesse de Traite",                // Milking Speed
    "Tempérament de Traite",            // Milking Temperament
    "Aptitude au Vêlage",               // Calving Ability
    "Aptitude des Filles au Vêlage",    // Dtr Calving Ability
    "Condition de Chair",               // Body Condition
  ],
  dtrsHerds: "Filles/Troupeaux",

  linearTraitNames: {
    // The five composite/section codes (seed-config.ts) — NOT currently
    // isLinear=true (see the previous phase's documented gap: today's chart
    // renders exactly the 26 HOLSTEIN_LINEAR rows below, not these five), but
    // translated now per this phase's spec so a later migration that flips
    // isLinear on them needs no French-label follow-up.
    CONF: "Conformation",
    MAMM: "Système mammaire",   // DB traitName is "Mammary System"; task's own label is "Mammary"
    FL: "Pieds et Membres",     // DB traitName "Feet & Legs"
    DS: "Puissance Laitière",   // DB traitName "Dairy Strength"
    RUMP: "Croupe",

    // The 26 real isLinear=true rows (prisma/traits-holstein.ts HOLSTEIN_LINEAR),
    // grouped the same way that file groups them.
    STA: "Stature",
    HFE: "Hauteur à l'avant-Train",
    CHW: "Largeur du Poitrail",
    BODY: "Profondeur du Corps",
    RIB: "Structure des côtes",

    RA: "Angle de la Croupe",
    PW: "Largeur aux Ischions",
    LOIN: "Force du Rein",
    THURL: "Position du Trochanter",

    FA: "Angle du Pied",
    HD: "Profondeur du Talon",
    BQ: "Qualité de l'Ossature",
    RLSV: "Vue Côté-Membres Arrière",
    RLRV: "Vue Arrière-Membres Arrière",
    FLV: "Vue des Membres Avant",  // DB traitName "Front Legs View"
    LOCO: "Locomotion",

    UFLOOR: "Plancher du Pis",
    FUA: "Attache Avant",
    RAH: "Hauteur Attache Arrière",
    RAW: "Largeur Attache Arrière",
    UDEP: "Profondeur du Pis",
    UTEX: "Texture du Pis",
    MSUS: "Suspension Médiane",
    FTP: "Position Trayons Avant",  // DB traitName "Fore Teat Placement"
    RTP: "Position Trayons Arrière",
    TL: "Longueur des Trayons",
  },

  linearDescriptors: {
    ...COMMON_LINEAR_DESCRIPTORS,
    // CA-only words (not shared with the US dictionary above).
    Posterior: "Postérieure",       // Thurl Placement
    Anterior: "Antérieure",
    Coarse: "Grossière",            // Bone Quality / Udder Texture left end
    "Flat/Clean": "Plate et nette", // Bone Quality right end
    Soft: "Souple",                 // Udder Texture right end
    "Toes out": "Panards",          // Front Legs View left end — best-effort
                                     // standard term, not verified against an
                                     // official French Canadian glossary.
    Straight: "Droits",             // Front Legs View right end
    "Straight (posty)": "Droits (raides)", // Rear Legs Side View left end
    Poor: "Faible",                 // Locomotion left end / composite rows generally
    Excellent: "Excellent",         // Locomotion right end / composite rows generally
    "Below hock": "Sous le jarret", // Udder Floor left end — see the note below.
    "Above hock": "Au-dessus du jarret",
  },
};

// ---------------------------------------------------------------------------
// UNITED STATES
// ---------------------------------------------------------------------------

export interface FrUsLabels {
  title: string;
  /** Kept as-is, not translated — confirmed from the reference image. */
  gtpi: string;
  /** Kept as-is, not translated — confirmed from the reference image. */
  netMerit: string;
  lifetimePerformance: string;
  production: string;
  functionalTraits: string;
  dataSuppliedBy: string;
  milk: string;
  fat: string;
  protein: string;
  /** In proof-card-us.ts's functionalLeft column order (SCS, PL, Proof Basis,
   *  Combined F&P, Cheese Merit $, Fertility Index). See the file-level
   *  ambiguity note — slot 3 here is spec'd as "Filles/Troupeaux", which is a
   *  literal daughters/herds count label, NOT a translation of the English
   *  card's real slot-3 content (the Daughter-Proven/Genomic Proof Basis
   *  indicator — the US side has no daughter/herd count field to translate). */
  functionalLeft: string[];
  /** In proof-card-us.ts's functionalRight column order (CCR, DPR, SCE, DCE, SSB, DSB). */
  functionalRight: string[];
  linearTraitNames: Record<string, string>;
  linearDescriptors: Record<string, string>;
}

export const FR_US_LABELS: FrUsLabels = {
  title: "CHIFFRES AMERICAINS",
  gtpi: "GTPI",
  netMerit: "NET MERIT",
  lifetimePerformance: "Performance à Vie",
  production: "Production",
  functionalTraits: "Fonctionnels",
  dataSuppliedBy: "Données fournies par Holstein USA",
  milk: "Lait",
  fat: "Gras",
  protein: "Protéine",

  functionalLeft: [
    "SCS",
    "Vie Productive",              // Productive Life
    "Filles/Troupeaux",            // see FrUsLabels.functionalLeft doc comment above
    "Combiné Gras & Protéine",     // Combined F&P
    "Mérite du Fromage",           // Cheese Merit $
    "Fertilité des Filles (calc.)", // Fertility Index — "(calc.)" matches the
                                     // English card's disclosure that this is
                                     // computed in-house, not HAUSA-published.
  ],
  functionalRight: [
    "CCR",
    "DPR",
    "Facilité au Vêlage",              // Sire Calving Ease
    "F. à Vêlage des Filles",          // Daughter Calving Ease
    "M. à la Naissance",               // Sire Stillbirth
    "M. à la Nais. des Filles",        // Daughter Stillbirth
  ],

  // Keyed by CDCB code, matching UsLinearRow.code (src/lib/proof-card-us.ts)
  // and US_LINEAR_ENDS (src/lib/us-cdcb/linear.ts) — the 17 two-ended traits,
  // plus the 4 composite-row codes proof-card-us.ts's compositeRows carries
  // (PTAT/UDC/FLC kept as-is, not translated — international abbreviations,
  // same treatment as GTPI/NET MERIT above; BSC gets the "(calc.)" suffix
  // translated too, matching the English card's own disclosure marker).
  linearTraitNames: {
    PTAT: "PTAT",
    UDC: "UDC",
    FLC: "FLC",
    BSC: "BSC (calc.)",

    STA: "Stature",
    STR: "Puissance laitière",
    BDE: "Profondeur du Corps",
    DFM: "Angularité",
    RPA: "Angle de la Croupe",
    TRW: "Largeur de la Croupe",   // thurl width
    RLS: "Vue côté-membres arr",
    RLR: "Vue Arr. Membres Arr",
    FTA: "Angle du Pied",
    FUA: "Attache Avant",
    RUH: "Hauteur. Attache-pis",
    RUW: "Larg. attache-pis",
    UCL: "Suspension médiane",
    UDP: "Profondeur Du Pis",
    FTP: "Position Trayons avant",
    RTP: "Position Trayons arr",
    TLG: "Longueur des Trayons",
  },

  linearDescriptors: {
    ...COMMON_LINEAR_DESCRIPTORS,
    // US-only words (US_LINEAR_ENDS, src/lib/us-cdcb/linear.ts) not shared
    // with the CA dictionary above.
    Frail: "Frêle",   // STR ("Strength") left end — distinct from Weak/Faible
                       // used elsewhere, since CDCB's own wording differs
                       // (Frail, not Weak) for this trait specifically.
    Posty: "Droits (raides)", // RLS left end — same conformation concept as
                               // CA's "Straight (posty)", translated the same way.
  },
};

/**
 * ---------------------------------------------------------------------------
 * REAL AMBIGUITIES IN THIS FILE (not hidden, not silently resolved either way)
 * ---------------------------------------------------------------------------
 *
 * 1. FR_CA_LABELS.linearDescriptors deliberately keys off the ENGLISH TEXT
 *    prisma/traits-holstein.ts ACTUALLY STORES for each trait's left/right
 *    labels, not off this task's own three worked examples where they differ:
 *      - "Udder Floor: Tilt→Incliné / Reverse→Inc. avant" — the seed file's
 *        real UFLOOR pair is "Below hock"/"Above hock" (a floor-HEIGHT
 *        measure), not a tilt-direction one. Translating "Tilt"/"Reverse"
 *        would attach a French label to English words this trait's real row
 *        never carries. Translated the real pair instead: "Sous le
 *        jarret"/"Au-dessus du jarret".
 *      - "Udder Depth: Deep→Profond / Shallow→Peu profond" matches the real
 *        UDEP pair exactly — used verbatim.
 *      - "Rear Legs Side View: Straight→Droit / Curved→Courbés" — the real
 *        RLSV pair is "Straight (posty)"/"Sickled", not "Straight"/"Curved".
 *        Translated as "Droits (raides)"/"Courbés" — same conformation fault,
 *        adapted wording to match the real descriptor text.
 *
 * 2. FR_US_LABELS.functionalLeft[2] is specified in this task as
 *    "Filles/Troupeaux" (a literal Daughters/Herds translation), but the
 *    English American card's actual slot 3 (src/lib/proof-card-us.ts,
 *    proofBasisLabel) is a Daughter-Proven/Genomic indicator — chosen
 *    specifically BECAUSE the US side has no daughter/herd count field to
 *    show. Built exactly as this task's French-label spec literally states
 *    (matching the precedent proof-card-ca.ts set of using a literal
 *    instruction as given rather than guessing a "more correct" value), but
 *    a locale-aware template built on this file in the review/integration
 *    phase must NOT wire this string to that slot unchanged — it would show
 *    a count label over a Proof Basis value. Flagged here rather than quietly
 *    "corrected" to something this file was not asked to contain.
 * ---------------------------------------------------------------------------
 */
