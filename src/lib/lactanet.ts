import "server-only";
import fs from "fs";
import path from "path";
import readline from "readline";

// ---------------------------------------------------------------------------
// Parser for the official Lactanet bull-proof CSV (aiobgepa..._ho.csv).
// Maps the 274-column layout to structured identity, pedigree, and trait data.
// ---------------------------------------------------------------------------

export interface ParsedTrait {
  traitCode: string;
  numericValue: number | null;
  textValue: string | null; // ALPHA descriptor for linear traits
  reliability: number | null;
  percentileRank: number | null;
}

export interface ParsedPedigree {
  relation: string; // sire | dam | mgs | mgd | gmgs | gmgd
  reg: string | null;
  name: string | null;
}

export interface ParsedBull {
  registrationNumber: string;
  registeredName: string;
  shortName: string | null;
  birthDate: string | null; // ISO yyyy-mm-dd
  naabCode: string | null;
  naabMarketingCode: string | null;
  polled: string | null;
  betaCasein: string | null;
  colourCode: string | null;
  country: string; // CA | US | INT
  regIdType: string;
  proofRun: string | null;
  // Lactanet status codes for this round — see BULL_PROOF_FILE_LAYOUT.pdf and
  // src/lib/sire-class.ts for the decoded meanings.
  activityCode: string | null; // col 24 PROOF ACTIVITY CODE and GENOTYPE INDICATOR
  officialCode: string | null; // col 44 LPI OFFICIAL CODE
  daughters: number | null;    // col 63 NUMBER OF DAUGHTERS 120/90 DIM
  herds: number | null;        // col 59 HERDS PROTEIN
  traits: ParsedTrait[];
  pedigree: ParsedPedigree[];
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "" || t === ".") return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function signed(valStr: string | undefined, signStr: string | undefined): number | null {
  const v = num(valStr);
  if (v === null) return null;
  const s = (signStr ?? "").trim();
  if (s === "-") return -Math.abs(v);
  if (s === "+") return Math.abs(v);
  return v; // no sign column → value already carries its sign
}

function isoDate(yyyymmdd: string | undefined): string | null {
  const t = (yyyymmdd ?? "").trim();
  if (!/^\d{8}$/.test(t)) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

function countryFromReg(reg: string): { country: string; idType: string } {
  const r = reg.toUpperCase();
  if (r.includes("CAN")) return { country: "CA", idType: "registration_ca" };
  if (r.includes("USA") || /HO?840/.test(r)) return { country: "US", idType: "registration_us" };
  return { country: "INT", idType: "registration_int" };
}

// Index traits: [traitCode, valueCol, relCol?, pctCol?]
const INDEX_MAP: [string, string, string?, string?][] = [
  ["LPI", "LPI", "LPI RELIABILITY", "LPI PERCENTILE RANK"],
  ["PRO$", "PRO$"],
  ["PI", "PRODUCTION INDEX (PI)", "PI RELIABILITY", "PI PERCENTILE RANK"],
  ["LTI", "LONGEVITY & TYPE INDEX (LTI)", "LTI RELIABILITY", "LTI PERCENTILE RANK"],
  ["HWI", "HEALTH & WELFARE INDEX (HWI)", "HWI RELIABILITY", "HWI PERCENTILE RANK"],
  ["RI", "REPRODUCTION INDEX (RI)", "RI RELIABILITY", "RI PERCENTILE RANK"],
  ["MI", "MILKABILITY INDEX (MI)", "MI RELIABILITY", "MI PERCENTILE RANK"],
  ["EI", "ENVIRONMENTAL IMPACT INDEX (EI)", "EI RELIABILITY", "EI PERCENTILE RANK"],
];

// Production EBVs: [traitCode, valueCol, pctCol?]
const PROD_MAP: [string, string, string?][] = [
  ["MILK", "EBV MILK KG", "PERCENTILE RANK MILK"],
  ["FAT", "EBV FAT KG", "PERCENTILE RANK FAT"],
  ["PROT", "EBV PROTEIN KG", "PERCENTILE RANK PROTEIN"],
  ["FATPCT", "EBV FAT PERCENT"],
  ["PROTPCT", "EBV PROTEIN PERCENT"],
];

// Functional ratings (100-scale): [traitCode, ratingCol, relCol?, pctCol?]
const FUNC_MAP: [string, string, string?, string?][] = [
  ["LP", "LP RATING", "RELIABILITY (LP)", "PERCENTILE RANK LP"],
  ["SCS", "SCS RATING", "RELIABILITY (SCS)", "PERCENTILE RANK SCS"],
  ["CA", "CA RATING", "RELIABILITY (CA)", "PERCENTILE RANK CA"],
  ["DCA", "DCA RATING", "RELIABILITY (DCA)", "PERCENTILE RANK DCA"],
  ["HL", "HL RATING", "RELIABILITY (HL)", "PERCENTILE RANK HL"],
  ["MSPD", "MSP RATING", "RELIABILITY (MSP)", "PERCENTILE RANK MSP"],
  ["MTMP", "MT RATING", "RELIABILITY (MT)", "PERCENTILE RANK MT"],
  ["DF", "DF RATING", "RELIABILITY (DF)", "PERCENTILE RANK DF"],
  ["BCS", "BCS RATING", "RELIABILITY (BCS)", "PERCENTILE RANK BCS"],
  ["MR", "MR RATING", "RELIABILITY (MR)", "PERCENTILE RANK MR"],
  ["MDR", "MDR RATING", "RELIABILITY (MDR)", "PERCENTILE RANK MDR"],
  ["HH", "HH RATING", "RELIABILITY (HH)", "PERCENTILE RANK HH"],
  ["FE", "FE RATING", "RELIABILITY (FE)", "PERCENTILE RANK FE"],
  ["METH", "ME RATING", "RELIABILITY (ME)", "PERCENTILE RANK ME"],
  ["BMR", "BMR RATING", "RELIABILITY (BMR)", "PERCENTILE RANK BMR"],
  ["CO", "CO RATING", "RELIABILITY (CO)", "PERCENTILE RANK CO"],
  ["CH", "CH RATING", "RELIABILITY (CH)", "PERCENTILE RANK CH"],
];

// Conformation composites: [traitCode, valueCol, pctCol?]
const CONF_MAP: [string, string, string?][] = [
  ["CONF", "EBV CONFORMATION", "PERCENTILE RANK CONFORMATION"],
  ["AFS", "AVERAGE FINAL SCORE"],
  ["MAMM", "MAMMARY SYSTEM", "PERCENTILE RANK MAMMARY SYSTEM"],
  ["FL", "FEET & LEGS", "PERCENTILE RANK FEET & LEGS"],
  ["DS", "DAIRY STRENGTH", "PERCENTILE RANK DAIRY STRENGTH"],
  ["RUMP", "RUMP", "PERCENTILE RANK RUMP"],
];

// Linear traits: [traitCode, valueCol, signCol?, alphaCol?]
const LINEAR_MAP: [string, string, string?, string?][] = [
  ["STA", "STATURE", "STATURE SIGN", "STATURE ALPHA"],
  ["HFE", "HEIGHT AT FRONT END"],
  ["CHW", "CHEST WIDTH"],
  ["BODY", "BODY DEPTH"],
  ["RIB", "RIB STRUCTURE"],
  ["RA", "RUMP ANGLE", "RUMP ANGLE SIGN", "RUMP ANGLE ALPHA"],
  ["PW", "PIN WIDTH"],
  ["LOIN", "LOIN STRENGTH"],
  ["THURL", "THURL PLACEMENT", "THURL PLACEMENT SIGN", "THURL PLACEMENT ALPHA"],
  ["FA", "FOOT ANGLE"],
  ["HD", "HEEL DEPTH"],
  ["BQ", "BONE QUALITY"],
  ["RLSV", "REAR LEGS SIDE VIEW", "REAR LEGS SIDE VIEW - SIGN", "REAR LEGS SIDE VIEW ALPHA"],
  ["RLRV", "REAR LEGS REAR VIEW"],
  ["FLV", "FRONT LEGS VIEW", "FRONT LEGS VIEW SIGN", "FRONT LEGS VIEW ALPHA"],
  ["LOCO", "LOCOMOTION"],
  ["FUA", "FORE ATTACHMENT"],
  ["RAH", "REAR ATTACHMENT HEIGHT"],
  ["RAW", "REAR ATTACHMENT WIDTH"],
  ["UDEP", "UDDER DEPTH", "UDDER DEPTH SIGN", "UDDER DEPTH ALPHA"],
  ["UTEX", "UDDER TEXTURE"],
  ["MSUS", "MEDIAN SUSPENSORY"],
  ["FTP", "FORE TEAT PLACEMENT", "FORE TEAT PLACEMENT SIGN", "FORE TEAT PLACEMENT ALPHA"],
  ["RTP", "REAR TEAT PLACEMENT", "REAR TEAT PLACEMENT SIGN", "REAR TEAT PLACEMENT ALPHA"],
  ["TL", "TEAT LENGTH", "TEAT LENGTH SIGN", "TEAT LENGTH ALPHA"],
];

export function parseHeader(headerLine: string): Map<string, number> {
  const cols = headerLine.split(",").map((c) => c.trim());
  const idx = new Map<string, number>();
  cols.forEach((c, i) => { if (!idx.has(c)) idx.set(c, i); });
  return idx;
}

export function parseRow(fields: string[], idx: Map<string, number>): ParsedBull | null {
  const get = (col: string): string | undefined => {
    const i = idx.get(col);
    return i === undefined ? undefined : fields[i];
  };
  const reg = (get("REGISTRATION NUMBER") ?? "").trim();
  if (!reg) return null;

  const { country, idType } = countryFromReg(reg);
  const traits: ParsedTrait[] = [];
  const relProt = num(get("RELIABILITY PROTEIN"));

  for (const [code, valCol, relCol, pctCol] of INDEX_MAP) {
    const v = num(get(valCol));
    if (v === null) continue;
    traits.push({ traitCode: code, numericValue: v, textValue: null, reliability: relCol ? num(get(relCol)) : null, percentileRank: pctCol ? num(get(pctCol)) : null });
  }
  for (const [code, valCol, pctCol] of PROD_MAP) {
    const v = num(get(valCol));
    if (v === null) continue;
    traits.push({ traitCode: code, numericValue: v, textValue: null, reliability: relProt, percentileRank: pctCol ? num(get(pctCol)) : null });
  }
  for (const [code, ratingCol, relCol, pctCol] of FUNC_MAP) {
    const v = num(get(ratingCol));
    if (v === null) continue;
    traits.push({ traitCode: code, numericValue: v, textValue: null, reliability: relCol ? num(get(relCol)) : null, percentileRank: pctCol ? num(get(pctCol)) : null });
  }
  for (const [code, valCol, pctCol] of CONF_MAP) {
    const v = num(get(valCol));
    if (v === null) continue;
    traits.push({ traitCode: code, numericValue: v, textValue: null, reliability: null, percentileRank: pctCol ? num(get(pctCol)) : null });
  }
  for (const [code, valCol, signCol, alphaCol] of LINEAR_MAP) {
    const v = signed(get(valCol), signCol ? get(signCol) : undefined);
    if (v === null) continue;
    const alpha = alphaCol ? (get(alphaCol) ?? "").trim() || null : null;
    traits.push({ traitCode: code, numericValue: v, textValue: alpha, reliability: null, percentileRank: null });
  }

  const pedigree: ParsedPedigree[] = [
    { relation: "sire", reg: (get("SIRE REGISTRATION NUMBER") ?? "").trim() || null, name: (get("SIRE NAME") ?? "").trim() || null },
    { relation: "dam", reg: (get("DAM REGISTRATION NUMBER") ?? "").trim() || null, name: (get("DAM NAME") ?? "").trim() || null },
    { relation: "mgs", reg: (get("MGS REGISTRATION NUMBER") ?? "").trim() || null, name: (get("MGS NAME") ?? "").trim() || null },
    { relation: "mgd", reg: (get("MGD REGISTRATION NUMBER") ?? "").trim() || null, name: (get("MGD NAME") ?? "").trim() || null },
    { relation: "gmgs", reg: (get("GMGS REGISTRATION NUMBER") ?? "").trim() || null, name: (get("GMGS NAME") ?? "").trim() || null },
    { relation: "gmgd", reg: (get("GMGD REGISTRATION NUMBER") ?? "").trim() || null, name: (get("GMGD NAME") ?? "").trim() || null },
  ].filter((p) => p.name || p.reg);

  const gerun = (get("GERUN") ?? "").trim();

  return {
    registrationNumber: reg,
    registeredName: (get("REGISTERED NAME") ?? "").trim() || reg,
    shortName: (get("SHORT NAME") ?? "").trim() || null,
    birthDate: isoDate(get("BIRTH DATE")),
    naabCode: (get("NAAB CODE") ?? "").trim() || null,
    naabMarketingCode: (get("NAAB MARKETING CODE") ?? "").trim() || null,
    polled: (get("POLLED") ?? "").trim() || null,
    betaCasein: (get("BETA CASEIN (A2)") ?? "").trim() || null,
    colourCode: (get("COLOUR CODE") ?? "").trim() || null,
    country,
    regIdType: idType,
    proofRun: gerun || null,
    activityCode: (get("PROOF ACTIVITY CODE and GENOTYPE INDICATOR") ?? "").trim() || null,
    officialCode: (get("LPI OFFICIAL CODE") ?? "").trim() || null,
    daughters: num(get("NUMBER OF DAUGHTERS 120/90 DIM (HO/CB)")) ?? num(get("DAUGHTERS PROTEIN")),
    herds: num(get("HERDS PROTEIN")),
    traits,
    pedigree,
  };
}

// --- File access ---------------------------------------------------------

// Where uploaded proof files live (drop the big CSV here).
export function importsDir(): string {
  return process.env.IMPORTS_DIR || "./imports";
}

export function listProofFiles(): { name: string; sizeMB: number }[] {
  const dir = importsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => ({ name: f, sizeMB: Math.round((fs.statSync(path.join(dir, f)).size / 1048576) * 10) / 10 }));
}

// Reduce any client-supplied file name to a safe CSV basename (no path parts,
// no shell metacharacters) — the ONLY shape a proof file name may ever take.
export function safeProofFileName(fileName: string): string | null {
  const base = path.basename(String(fileName ?? "").trim());
  if (!/^[A-Za-z0-9._-]+\.csv$/i.test(base)) return null;
  return base;
}

// Resolve a client-supplied file name to an absolute path that is provably
// inside the imports dir and actually exists. Returns null otherwise. This is
// the single choke-point that closes path-traversal + command-injection: no
// caller may touch a file outside the imports dir or with unsafe characters.
export function resolveProofFile(fileName: string): string | null {
  const base = safeProofFileName(fileName);
  if (!base) return null;
  const dir = path.resolve(importsDir());
  const full = path.resolve(dir, base);
  if (full !== path.join(dir, base)) return null; // paranoia: reject anything that escaped
  if (!full.startsWith(dir + path.sep) && full !== dir) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

// Look up one bull by registration number OR NAAB code, streaming the file.
export async function findBull(fileName: string, query: string): Promise<ParsedBull | null> {
  const full = resolveProofFile(fileName);
  if (!full) return null;
  const q = query.trim().toUpperCase();
  const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
  let idx: Map<string, number> | null = null;
  let regIdx = -1, naabIdx = -1, mktIdx = -1;
  try {
    for await (const line of rl) {
      if (!idx) {
        idx = parseHeader(line);
        regIdx = idx.get("REGISTRATION NUMBER") ?? -1;
        naabIdx = idx.get("NAAB CODE") ?? -1;
        mktIdx = idx.get("NAAB MARKETING CODE") ?? -1;
        continue;
      }
      const fields = line.split(",");
      const reg = (fields[regIdx] ?? "").trim().toUpperCase();
      const naab = (fields[naabIdx] ?? "").trim().toUpperCase();
      const mkt = (fields[mktIdx] ?? "").trim().toUpperCase();
      if (reg === q || naab === q || mkt === q) {
        rl.close();
        return parseRow(fields, idx);
      }
    }
  } finally {
    rl.close();
  }
  return null;
}

// Stream the top-N bulls by an index column (default LPI), for bulk import.
export async function topBulls(fileName: string, sortCol: string, limit: number): Promise<ParsedBull[]> {
  const full = resolveProofFile(fileName);
  if (!full) return [];
  const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
  let idx: Map<string, number> | null = null;
  let sortIdx = -1;
  const heap: { score: number; fields: string[] }[] = [];
  try {
    for await (const line of rl) {
      if (!idx) { idx = parseHeader(line); sortIdx = idx.get(sortCol) ?? idx.get("LPI") ?? -1; continue; }
      const fields = line.split(",");
      const score = num(fields[sortIdx]);
      if (score === null) continue;
      heap.push({ score, fields });
    }
  } finally {
    rl.close();
  }
  heap.sort((a, b) => b.score - a.score);
  return heap.slice(0, limit).map((h) => parseRow(h.fields, idx!)).filter((b): b is ParsedBull => b !== null);
}
