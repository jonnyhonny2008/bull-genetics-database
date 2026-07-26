// Extended Holstein genetic trait catalogue derived from the official Lactanet
// bull-proof file (aiobgepa..._ho.csv). Adds the remaining indexes, functional
// traits, and — most importantly — the LINEAR conformation traits with the
// metadata needed to draw the classic "linear" chart on a proof.
//
// Linear traits use the Canadian STA-style scale (roughly -15..+15, breed
// average = 0). leftLabel/rightLabel are the biological descriptors at each end.

export interface HoloTrait {
  traitCode: string;
  traitName: string;
  category?: string; // set for all; linear traits receive it in HOLSTEIN_ALL_EXTRA
  displayOrder: number;
  unit?: string;
  higherIsBetter?: boolean;
  isLinear?: boolean;
  graphMin?: number;
  graphMax?: number;
  leftLabel?: string;
  rightLabel?: string;
  graphGroup?: string;
}

// Additional index traits (LPI, PRO$, MILK, FAT, PROT, %s already seeded in seed-config).
export const HOLSTEIN_INDEXES: HoloTrait[] = [
  { traitCode: "PI", traitName: "Production Index (PI)", category: "Index", displayOrder: 3 },
  { traitCode: "LTI", traitName: "Longevity & Type Index (LTI)", category: "Index", displayOrder: 4 },
  { traitCode: "HWI", traitName: "Health & Welfare Index (HWI)", category: "Index", displayOrder: 5 },
  { traitCode: "RI", traitName: "Reproduction Index (RI)", category: "Index", displayOrder: 6 },
  { traitCode: "MI", traitName: "Milkability Index (MI)", category: "Index", displayOrder: 7 },
  { traitCode: "EI", traitName: "Environmental Impact Index (EI)", category: "Index", displayOrder: 8 },
];

// Additional functional traits (100-scale ratings). SCS, HL, DF, MR, MDR, MSPD,
// MTMP, CA, DCA, LP, FE, METH already seeded; add the rest from the proof file.
export const HOLSTEIN_FUNCTIONAL: HoloTrait[] = [
  { traitCode: "HH", traitName: "Hoof Health", category: "Health", displayOrder: 42 },
  { traitCode: "BMR", traitName: "Body Maintenance Requirements", category: "Efficiency", displayOrder: 43 },
  { traitCode: "CO", traitName: "Cystic Ovaries", category: "Health", displayOrder: 44 },
  { traitCode: "CH", traitName: "Calf Health", category: "Health", displayOrder: 45 },
  { traitCode: "BCS", traitName: "Body Condition Score", category: "Health", displayOrder: 46 },
  { traitCode: "SEMFERT", traitName: "Semen Fertility", category: "Fertility", displayOrder: 47 },
];

// Conformation composites (already have CONF, MAMM, FL, DS, RUMP; add final score).
export const HOLSTEIN_CONF: HoloTrait[] = [
  { traitCode: "AFS", traitName: "Average Final Score (daughters)", category: "Type", displayOrder: 19, unit: "pts" },
];

// LINEAR type traits — the ones plotted on the linear graph.
export const HOLSTEIN_LINEAR: HoloTrait[] = [
  // Dairy Strength / Frame
  { traitCode: "STA", traitName: "Stature", graphGroup: "Dairy Strength", leftLabel: "Short", rightLabel: "Tall", displayOrder: 100 },
  { traitCode: "HFE", traitName: "Height at Front End", graphGroup: "Dairy Strength", leftLabel: "Low", rightLabel: "High", displayOrder: 101 },
  { traitCode: "CHW", traitName: "Chest Width", graphGroup: "Dairy Strength", leftLabel: "Narrow", rightLabel: "Wide", displayOrder: 102 },
  { traitCode: "BODY", traitName: "Body Depth", graphGroup: "Dairy Strength", leftLabel: "Shallow", rightLabel: "Deep", displayOrder: 103 },
  { traitCode: "RIB", traitName: "Rib Structure / Angularity", graphGroup: "Dairy Strength", leftLabel: "Lacks", rightLabel: "Angular", displayOrder: 104 },
  // Rump
  { traitCode: "RA", traitName: "Rump Angle", graphGroup: "Rump", leftLabel: "High pins", rightLabel: "Sloped", displayOrder: 110 },
  { traitCode: "PW", traitName: "Pin Width", graphGroup: "Rump", leftLabel: "Narrow", rightLabel: "Wide", displayOrder: 111 },
  { traitCode: "LOIN", traitName: "Loin Strength", graphGroup: "Rump", leftLabel: "Weak", rightLabel: "Strong", displayOrder: 112 },
  { traitCode: "THURL", traitName: "Thurl Placement", graphGroup: "Rump", leftLabel: "Posterior", rightLabel: "Anterior", displayOrder: 113 },
  // Feet & Legs
  { traitCode: "FA", traitName: "Foot Angle", graphGroup: "Feet & Legs", leftLabel: "Low", rightLabel: "Steep", displayOrder: 120 },
  { traitCode: "HD", traitName: "Heel Depth", graphGroup: "Feet & Legs", leftLabel: "Shallow", rightLabel: "Deep", displayOrder: 121 },
  { traitCode: "BQ", traitName: "Bone Quality", graphGroup: "Feet & Legs", leftLabel: "Coarse", rightLabel: "Flat/Clean", displayOrder: 122 },
  { traitCode: "RLSV", traitName: "Rear Legs Side View", graphGroup: "Feet & Legs", leftLabel: "Straight (posty)", rightLabel: "Sickled", displayOrder: 123 },
  { traitCode: "RLRV", traitName: "Rear Legs Rear View", graphGroup: "Feet & Legs", leftLabel: "Hocked in", rightLabel: "Parallel", displayOrder: 124 },
  { traitCode: "FLV", traitName: "Front Legs View", graphGroup: "Feet & Legs", leftLabel: "Toes out", rightLabel: "Straight", displayOrder: 125 },
  { traitCode: "LOCO", traitName: "Locomotion", graphGroup: "Feet & Legs", leftLabel: "Poor", rightLabel: "Excellent", displayOrder: 126 },
  // Mammary System
  { traitCode: "UFLOOR", traitName: "Udder Floor", graphGroup: "Mammary System", leftLabel: "Below hock", rightLabel: "Above hock", displayOrder: 129 },
  { traitCode: "FUA", traitName: "Fore Attachment", graphGroup: "Mammary System", leftLabel: "Weak", rightLabel: "Strong", displayOrder: 130 },
  { traitCode: "RAH", traitName: "Rear Attachment Height", graphGroup: "Mammary System", leftLabel: "Low", rightLabel: "High", displayOrder: 131 },
  { traitCode: "RAW", traitName: "Rear Attachment Width", graphGroup: "Mammary System", leftLabel: "Narrow", rightLabel: "Wide", displayOrder: 132 },
  { traitCode: "UDEP", traitName: "Udder Depth", graphGroup: "Mammary System", leftLabel: "Deep", rightLabel: "Shallow", displayOrder: 133 },
  { traitCode: "UTEX", traitName: "Udder Texture", graphGroup: "Mammary System", leftLabel: "Coarse", rightLabel: "Soft", displayOrder: 134 },
  { traitCode: "MSUS", traitName: "Median Suspensory", graphGroup: "Mammary System", leftLabel: "Weak", rightLabel: "Strong", displayOrder: 135 },
  { traitCode: "FTP", traitName: "Fore Teat Placement", graphGroup: "Mammary System", leftLabel: "Wide", rightLabel: "Close", displayOrder: 136 },
  { traitCode: "RTP", traitName: "Rear Teat Placement", graphGroup: "Mammary System", leftLabel: "Wide", rightLabel: "Close", displayOrder: 137 },
  { traitCode: "TL", traitName: "Teat Length", graphGroup: "Mammary System", leftLabel: "Short", rightLabel: "Long", displayOrder: 138 },
];

// Descriptive genomic attributes (stored as text values).
export const HOLSTEIN_DESCRIPTIVE: HoloTrait[] = [
  { traitCode: "A2", traitName: "Beta Casein (A2)", category: "Genomics", displayOrder: 60 },
  { traitCode: "POLLED", traitName: "Polled Status", category: "Genomics", displayOrder: 61 },
  { traitCode: "COLOUR", traitName: "Colour Code", category: "Genomics", displayOrder: 62 },
];

export const HOLSTEIN_ALL_EXTRA: HoloTrait[] = [
  ...HOLSTEIN_INDEXES,
  ...HOLSTEIN_FUNCTIONAL,
  ...HOLSTEIN_CONF,
  ...HOLSTEIN_DESCRIPTIVE,
  ...HOLSTEIN_LINEAR.map((t) => ({ ...t, isLinear: true, graphMin: -15, graphMax: 15, category: "Type-Linear" })),
];
