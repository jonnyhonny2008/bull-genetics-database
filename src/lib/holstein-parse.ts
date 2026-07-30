// ---------------------------------------------------------------------------
// Holstein.ca parsing — PURE (no server-only imports) so it can be used from
// the Next.js server actions, the tsx bulk importer (prisma/import-holstein.ts),
// and unit tests alike.
//
// Two entry points:
//   parseHolsteinAis(text)      — parse a page a user copied & pasted (legacy).
//   parseHolsteinExtract(raw)   — parse the structured output of the browser
//                                 scraper (scripts/holstein-extract.js), which
//                                 returns the Main + Genetics page innerText plus
//                                 the Genetics page's tables as raw string[][].
//
// Nothing here fetches Holstein.ca. Fetching happens in the user's own browser
// (same-origin fetch) via the scraper; this module only interprets the result.
// ---------------------------------------------------------------------------

export function buildAisUrl(regNo: string, animalId?: string): string {
  const params = new URLSearchParams();
  if (animalId) params.set("animalId", animalId);
  params.set("animalRegNo", regNo.trim());
  return `https://www.holstein.ca/en/AIS/AIS?${params.toString()}`;
}

export interface HTrait {
  code: string;
  numericValue: number | null;
  textValue: string | null; // ALPHA descriptor for linear traits
  reliability: number | null;
  percentileRank: number | null;
}

export interface ParsedHolstein {
  regNo: string | null;
  nationalId: string | null;
  name: string | null;
  sex: string; // M | F
  birthDate: string | null; // ISO
  purity: string | null;
  herdNo: string | null;
  colour: string | null;
  betaCasein: string | null;
  inbreeding: number | null;
  rValue: number | null;
  classification: { code: string; score: number; age: string | null } | null;
  classificationSections: { code: string; name: string; value: string }[];
  evaluation: { runLabel: string; runDate: string; reliability: number | null; basis: string | null } | null;
  traits: HTrait[];
  pedigree: { relation: string; reg: string | null; name: string | null }[];
  warnings: string[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Full month names so a Holstein.ca run label ("April 2026") matches the
// convention used by prisma/import-cdn.ts and dedupes correctly per source.
const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function toIsoFromDMY(s: string): string | null {
  const m = s.trim().match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, "0")}-${String(parseInt(m[1])).padStart(2, "0")}`;
}

function nums(s: string): number[] {
  return (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

// Return the remainder of the line that contains the first occurrence of `label`.
function lineAfter(text: string, label: string): string | null {
  for (const line of text.split("\n")) {
    const i = line.indexOf(label);
    if (i >= 0) return line.slice(i + label.length);
  }
  return null;
}

// Functional trait label -> code (100-scale rating + reliability).
const FUNC: [string, string][] = [
  ["Herd Life", "HL"], ["Lactation Persistency", "LP"], ["Daughter Fertility", "DF"],
  ["Milking Speed", "MSPD"], ["Milking Temperament", "MTMP"], ["Calving Ability", "CA"],
  ["Daughter Calving Ability", "DCA"], ["Body Condition Score", "BCS"],
  ["Mastitis Resistance", "MR"], ["Metabolic Disease Resistance", "MDR"], ["Hoof Health", "HH"],
  ["Feed Efficiency", "FE"], ["Methane Efficiency", "METH"], ["Body Maintenance Requirements", "BMR"],
  ["Calf Health", "CH"],
];

// Composite conformation label -> code (value + rank).
const COMPOSITE: [string, string][] = [
  ["Conformation", "CONF"], ["Dairy Strength", "DS"], ["Mammary System", "MAMM"], ["Feet & Legs", "FL"], ["Rump", "RUMP"],
];

// Linear trait label -> code (signed value + optional descriptor letter).
// Order matters: longer labels first so "Rump Angle" wins over "Rump".
const LINEAR: [string, string][] = [
  ["Rump Angle", "RA"], ["Pin Width", "PW"], ["Loin Strength", "LOIN"], ["Thurl Placement", "THURL"], ["Rib Structure", "RIB"],
  ["Stature", "STA"], ["Height at Front End", "HFE"], ["Chest Width", "CHW"], ["Body Depth", "BODY"],
  ["Udder Floor", "UFLOOR"], ["Udder Depth", "UDEP"], ["Udder Texture", "UTEX"], ["Median Suspensory", "MSUS"],
  ["Fore Attachment", "FUA"], ["Fore Teat Placement", "FTP"], ["Front Teat Placement", "FTP"], ["Rear Attachment Height", "RAH"],
  ["Rear Attachment Width", "RAW"], ["Rear Teat Placement", "RTP"], ["Teat Length", "TL"],
  ["Foot Angle", "FA"], ["Heel Depth", "HD"], ["Bone Quality", "BQ"],
  ["Rear Legs Side View", "RLSV"], ["Rear Legs Rear View", "RLRV"], ["Front Legs View", "FLV"], ["Locomotion", "LOCO"],
];

// Index group label (as shown on Holstein.ca) -> trait code.
const INDEX_GROUPS: [string, string][] = [
  ["Production", "PI"], ["Reproduction", "RI"], ["Longevity & Type", "LTI"],
  ["Milkability", "MI"], ["Health & Welfare", "HWI"], ["Environmental Impact", "EI"],
];

const FUNC_MAP = new Map(FUNC.map(([l, c]) => [l.toLowerCase(), c]));
const COMPOSITE_MAP = new Map(COMPOSITE.map(([l, c]) => [l.toLowerCase(), c]));
const LINEAR_MAP = new Map(LINEAR.map(([l, c]) => [l.toLowerCase(), c]));

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&");
}

// "1025" -> 1025 ; "" / "-" -> null
function num(s: string | undefined): number | null {
  if (s == null) return null;
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
// "81%" -> 81 ; "" -> null
function pct(s: string | undefined): number | null {
  if (s == null) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

// ===========================================================================
// LEGACY: parse a page the user copied & pasted from their signed-in session.
// ===========================================================================
export function parseHolsteinAis(text: string): ParsedHolstein {
  const t = text.replace(/\r/g, "");
  const warnings: string[] = [];
  const traits: HTrait[] = [];

  const regNo = (t.match(/\b(HOCAN[FM]\d{6,})\b/) ?? [])[1] ?? null;
  const nationalId = (t.match(/National Id:\s*(\d+)/i) ?? [])[1] ?? null;
  const sex = regNo && /HOCANM/.test(regNo) ? "M" : "F";

  // Name: the non-empty line immediately before the registration number.
  let name: string | null = null;
  if (regNo) {
    const lines = t.split("\n").map((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes(regNo));
    for (let i = idx - 1; i >= 0 && i >= idx - 3; i--) {
      if (lines[i] && !/holstein canada|logo|search|inquiry/i.test(lines[i])) { name = lines[i]; break; }
    }
  }

  const birthDate = (() => { const m = t.match(/Born:\s*([0-9]{1,2}\s+[A-Za-z]{3}\s+\d{4})/i); return m ? toIsoFromDMY(m[1]) : null; })();
  const purity = (t.match(/Purity:\s*([A-Za-z]+)/i) ?? [])[1] ?? null;
  const herdNo = (t.match(/Herd #:\s*(\d+)/i) ?? [])[1] ?? null;
  const betaCasein = (t.match(/\b(A1A1|A1A2|A2A2)\b/) ?? [])[1] ?? null;
  const colour = (t.match(/(B&W|R&W)/i) ?? [])[1] ?? null;
  const inbreeding = (() => { const m = t.match(/([\d.]+)\s*%INB/i); return m ? parseFloat(m[1]) : null; })();
  const rValue = (() => { const m = t.match(/([\d.]+)\s*%R\b/i); return m ? parseFloat(m[1]) : null; })();

  // Animal classification (anchored to "Registered", not the dam's).
  let classification: ParsedHolstein["classification"] = null;
  const clsM = t.match(/Registered\s*(EX|VG|GP|G|F|P)-(\d{2,3})(?:-([0-9A-Z]+))?-CAN/);
  if (clsM) classification = { code: clsM[1], score: parseInt(clsM[2]), age: clsM[3] ?? null };

  const classificationSections: ParsedHolstein["classificationSections"] = [];
  const secM = t.match(/MS:(\d+).*?F&L:(\d+)\s*DS:(\d+)\s*RP:(\d+)/);
  if (secM) {
    classificationSections.push({ code: "C_MAMM", name: "Mammary System", value: secM[1] });
    classificationSections.push({ code: "C_FL", name: "Feet & Legs", value: secM[2] });
    classificationSections.push({ code: "C_DS", name: "Dairy Strength", value: secM[3] });
    classificationSections.push({ code: "C_RUMP", name: "Rump", value: secM[4] });
  }

  // Genomic evaluation header: e.g. "Jul*26 CAN-GEBV" + reliability.
  let evaluation: ParsedHolstein["evaluation"] = null;
  const runM = t.match(/([A-Za-z]{3})\*(\d{2})\s+CAN-GE[BP]V/);
  if (runM) {
    const mon = MONTHS[runM[1].toLowerCase()] ?? 1;
    const year = 2000 + parseInt(runM[2]);
    const monthName = MONTH_NAMES[mon] ?? runM[1];
    const relM = t.match(/(\d+)%\s*Reliability/i);
    evaluation = { runLabel: `${monthName} ${year}`, runDate: `${year}-${String(mon).padStart(2, "0")}-01`, reliability: relM ? parseInt(relM[1]) / 100 : null, basis: "GEBV" };
  }

  const push = (code: string, v: number | null, text: string | null, rel: number | null, pctRank: number | null) => {
    if (v === null && text === null) return;
    traits.push({ code, numericValue: v, textValue: text, reliability: rel, percentileRank: pctRank });
  };

  // Indexes: GLPI -> LPI, Pro$.
  const glpi = t.match(/GLPI\s+(\d+)/i); if (glpi) push("LPI", parseInt(glpi[1]), null, evaluation?.reliability ?? null, null);
  const proD = t.match(/Pro\$\s+(\d+)/i); if (proD) push("PRO$", parseInt(proD[1]), null, null, null);

  // Production EBVs.
  const milk = lineAfter(t, "Milk (kg)"); if (milk) { const n = nums(milk); if (n.length) push("MILK", n[0], null, null, n.length > 1 ? n[n.length - 1] : null); }
  const fat = lineAfter(t, "Fat (kg)"); if (fat) { const n = nums(fat); if (n.length) { push("FAT", n[0], null, null, n.length >= 3 ? n[2] : null); if (n.length >= 2) push("FATPCT", n[1], null, null, null); } }
  const prot = lineAfter(t, "Protein (kg)"); if (prot) { const n = nums(prot); if (n.length) { push("PROT", n[0], null, null, n.length >= 3 ? n[2] : null); if (n.length >= 2) push("PROTPCT", n[1], null, null, null); } }
  const scs = lineAfter(t, "Somatic Cell Score"); if (scs) { const n = nums(scs); if (n.length) push("SCS", n[0], null, null, n.length > 1 ? n[n.length - 1] : null); }

  // Functional traits.
  for (const [labelR, code] of FUNC) {
    const m = t.match(new RegExp(esc(labelR) + "\\s+[A-Z]{2,4}\\s+(\\d+)\\s+(\\d+)%"));
    if (m) push(code, parseInt(m[1]), null, parseInt(m[2]) / 100, null);
  }

  // Composite conformation (value + optional rank).
  for (const [labelR, code] of COMPOSITE) {
    const m = t.match(new RegExp(esc(labelR) + "\\s+(-?\\d+)(?:\\s+(\\d+))?"));
    if (m) push(code, parseInt(m[1]), null, null, m[2] ? parseInt(m[2]) : null);
  }

  // Linear traits (signed value + optional descriptor letter attached to the number).
  for (const [labelR, code] of LINEAR) {
    const m = t.match(new RegExp(esc(labelR) + "\\s+(-?\\d+)([A-Za-z]?)"));
    if (m) push(code, parseInt(m[1]), m[2] ? m[2].toUpperCase() : null, null, null);
  }

  // Pedigree (sire + dam).
  const pedigree: ParsedHolstein["pedigree"] = [];
  const sireM = t.match(/Sire:\s*(HOCAN[MF]\d+|HO\d*[MF]\d+)\s*([A-Z0-9'’\-\. ]+?)\s{2,}|Sire:\s*(HOCAN[MF]\d+|HO\d*[MF]\d+)\s*([A-Z0-9'’\-\. ]+)/);
  if (sireM) pedigree.push({ relation: "sire", reg: sireM[1] ?? sireM[3] ?? null, name: (sireM[2] ?? sireM[4] ?? "").trim() || null });
  const damM = t.match(/Dam:\s*(HOCAN[MF]\d+|HO\d*[MF]\d+)\s*([A-Z0-9'’\-\. ]+?)(?:\s{2,}|\s+PB|\s+GP|\s+VG|\s+EX|\n|$)/);
  if (damM) pedigree.push({ relation: "dam", reg: damM[1], name: damM[2].trim() || null });

  if (!regNo) warnings.push("Could not find a registration number — check the pasted text.");
  if (traits.length === 0) warnings.push("No genomic traits parsed — the page layout may differ; paste the full page.");

  return {
    regNo, nationalId, name, sex, birthDate, purity, herdNo, colour, betaCasein, inbreeding, rValue,
    classification, classificationSections, evaluation, traits, pedigree, warnings,
  };
}

// ===========================================================================
// SCRAPER OUTPUT: parse the structured extract from scripts/holstein-extract.js
// ===========================================================================

export interface HolsteinTable { head: string; rows: string[][]; }

export interface HolsteinTabData { text?: string | null; tables?: HolsteinTable[] | null; }

export interface HolsteinRawExtract {
  reg: string | null;
  animalId?: string | null;
  name?: string | null;
  mainText: string;             // full innerText of the Main AIS page
  genText?: string | null;      // full innerText of the Genetics page
  genTables?: HolsteinTable[] | null; // Genetics page tables as raw string[][]
  // Raw content of the remaining tabs (Conformation, Family Tree, Owner History,
  // Progeny, Show & Awards). Captured now; parsed into structured records incrementally.
  extraTabs?: Record<string, HolsteinTabData> | null;
  // Family-tree ancestors with their TRUE generation, computed in the browser
  // from the rowspan grid (cell index alone mis-assigns generations).
  familyTreeNodes?: { side: string; generation: number; text: string }[] | null;
  error?: string | null;
  scrapedAt?: string | null;
}

function tableWithHead(tables: HolsteinTable[], re: RegExp): HolsteinTable | undefined {
  return tables.find((t) => re.test(t.head) || re.test((t.rows[0] ?? []).join(" ")));
}

// Interpret the Genetics-page CONFORMATION table (two-column layout). Rows carry
// a left name/value/rank in cells 0-2 and a right name/value/rank in cells 4-6;
// header rows (…"Rating","Rank"…) are skipped. Composites come from mainText,
// so here we only collect the LINEAR traits (signed value + descriptor letter).
function collectLinear(conf: HolsteinTable, push: (code: string, v: number | null, tx: string | null) => void) {
  for (const r of conf.rows) {
    if (!r.length) continue;
    if (/^rating$/i.test(r[1] ?? "") || /^rating$/i.test(r[5] ?? "")) continue; // header row
    for (const [nameCell, valCell] of [[r[0], r[1]], [r[4], r[5]]] as [string, string][]) {
      const name = (nameCell ?? "").trim();
      const val = (valCell ?? "").trim();
      if (!name || !val) continue;
      const code = LINEAR_MAP.get(name.toLowerCase());
      if (!code) continue; // composites & overall handled elsewhere
      const m = val.match(/(-?\d+)\s*([A-Za-z]?)/);
      if (!m) continue;
      push(code, parseInt(m[1]), m[2] ? m[2].toUpperCase() : null);
    }
  }
}

// ===========================================================================
// RICH PROFILE: owners, breeders, multi-generation family tree, progeny, and
// official classification history — parsed from the scraper's extra tabs.
// Stored as JSON on Animal.holsteinProfileJson for display.
// ===========================================================================

export interface AncestorNode { generation: number; side: "sire" | "dam"; name: string | null; reg: string | null; classification: string | null; birthDate: string | null; extra: string | null; }
export interface OwnerRow { prefix: string | null; name: string | null; address: string | null; phone: string | null; date: string | null; current: boolean; }
export interface ProgenyRow { reg: string | null; name: string | null; birthDate: string | null; sex: string | null; classification: string | null; colour: string | null; }
export interface HolsteinClassification { date: string | null; code: string | null; score: number | null; lactation: number | null; daysFresh: number | null; sections: { code: string; name: string; value: string }[]; }

export interface LactationProjection { dim: number | null; milk: number | null; fat: number | null; prot: number | null; }
export interface Lactation {
  lactationNumber: number; ageAtCalving: string | null; milkingFreq: string | null; calvingDateIso: string | null;
  dim: number | null; milk: number | null; fat: number | null; fatPct: number | null; prot: number | null; protPct: number | null;
  scs: number | null; compSource: string | null;
  bca: { milk: number | null; fat: number | null; prot: number | null; comp: number | null };
  projections: LactationProjection[]; // 365-day and natural extensions
}

export interface HolsteinProfile {
  reg: string | null;
  owners: OwnerRow[];
  breeders: OwnerRow[];
  familyTree: AncestorNode[];
  progeny: ProgenyRow[];
  classifications: HolsteinClassification[];
  lactations: Lactation[];
  awards: string[];
  scrapedAt: string | null;
}

// Safely parse the stored Animal.holsteinProfileJson back into a HolsteinProfile.
export function parseHolsteinProfileJson(json: string | null | undefined): HolsteinProfile | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<HolsteinProfile>;
    return {
      reg: p.reg ?? null, owners: p.owners ?? [], breeders: p.breeders ?? [], familyTree: p.familyTree ?? [],
      progeny: p.progeny ?? [], classifications: p.classifications ?? [], lactations: p.lactations ?? [],
      awards: p.awards ?? [], scrapedAt: p.scrapedAt ?? null,
    };
  } catch {
    return null;
  }
}

function findTable(tables: HolsteinTable[] | null | undefined, re: RegExp): HolsteinTable | undefined {
  return (tables ?? []).find((t) => re.test(t.head) || re.test((t.rows[0] ?? []).join(" ")));
}

// Parse a family-tree cell like:
//   "S-W-D VALIANT PB\nHOUSAM1650414\n[ EX-USA ]\nBorn: 28 Jun 1973\nGM'90 B&W GTSM"
function parseAncestorCell(cell: string, generation: number, side: "sire" | "dam"): AncestorNode | null {
  const raw = (cell ?? "").trim();
  if (!raw) return null;
  const parts = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const reg = (raw.match(/\b(HO[A-Z]{3}[MF]?\d{4,}|HO\d{6,})\b/) ?? [])[1] ?? null;
  const cls = (raw.match(/\[\s*([^\]]+?)\s*\]/) ?? [])[1] ?? null;
  const born = (() => { const m = raw.match(/Born:\s*([0-9]{1,2}\s+[A-Za-z]{3}\s+\d{4})/i); return m ? toIsoFromDMY(m[1]) : null; })();
  // Name = first line, minus a trailing purity token.
  const name = parts[0].replace(/\s+(PB|PC|GP|RC|RP)$/i, "").trim() || null;
  const extra = parts.find((p) => /(B&W|R&W|GTSM|GM'|EX|VG)/.test(p) && !/^\[/.test(p) && p !== parts[0]) ?? null;
  return { generation, side, name, reg, classification: cls, birthDate: born, extra };
}

// Parse one side (Sire/Dam subtree) — column index = generation depth.
function parseTreeSide(table: HolsteinTable | undefined, side: "sire" | "dam"): AncestorNode[] {
  if (!table) return [];
  const out: AncestorNode[] = [];
  for (const row of table.rows) {
    if (row.length === 1 && /^(Sire|Dam)$/i.test(row[0])) continue; // head
    row.forEach((cell, col) => {
      const node = parseAncestorCell(cell, col + 1, side);
      if (node && (node.reg || node.name)) out.push(node);
    });
  }
  return out;
}

// Header-indexed row reader.
function rowByHeader(table: HolsteinTable): (row: string[], header: string) => string {
  const headerRow = table.rows.find((r) => r.length > 1) ?? [];
  const idx = new Map(headerRow.map((h, i) => [h.toLowerCase().replace(/\.$/, "").trim(), i]));
  return (row, header) => {
    const i = idx.get(header.toLowerCase().replace(/\.$/, "").trim());
    return i != null ? (row[i] ?? "") : "";
  };
}

export function parseHolsteinProfile(raw: HolsteinRawExtract): HolsteinProfile {
  const tabs = raw.extraTabs ?? {};
  const profile: HolsteinProfile = {
    reg: raw.reg ?? null, owners: [], breeders: [], familyTree: [], progeny: [], classifications: [], lactations: [], awards: [], scrapedAt: raw.scrapedAt ?? null,
  };

  // --- Lactation / production records (Main page "Production: Records quoted" table) ---
  // Columns are positional (the header misaligns because "DIM" spans milking-freq
  // + days): [0]Age(Yr-Mth) [1]Freq [2]DIM [3]Milk [4]Fat [5]%F [6]Prot [7]%P
  // [8]Comp.Source [9]SCS [10..13]BCA Milk/Fat/Prot/Comp [14..17]Deviations.
  const birthIso = (() => { const m = (raw.mainText || "").match(/Born:\s*([0-9]{1,2}\s+[A-Za-z]{3}\s+\d{4})/i); return m ? toIsoFromDMY(m[1]) : null; })();
  const calvingFromAge = (age: string | null): string | null => {
    if (!birthIso || !age) return null;
    const m = age.match(/(\d+)\s*[-\s]\s*(\d+)/);
    if (!m) return null;
    const d = new Date(birthIso + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() + parseInt(m[1]));
    d.setUTCMonth(d.getUTCMonth() + parseInt(m[2]));
    return d.toISOString().slice(0, 10);
  };
  const prodTable = findTable(tabs.main?.tables, /Records quoted|Production: Records/i);
  if (prodTable) {
    let current: Lactation | null = null;
    for (const row of prodTable.rows) {
      if (row.length < 8) continue;
      const c = (i: number) => (row[i] ?? "").trim();
      if (/Records quoted|BCA|Deviations|Lactation\(s\)/i.test(row.join(" ")) || /^Yr[-\s]?Mth/i.test(c(0)) || c(2) === "DIM") continue;
      const dim = num(c(2));
      if (dim === null || num(c(3)) === null) continue; // not a data row
      const age = c(0) || null;
      if (age) {
        current = {
          lactationNumber: profile.lactations.length + 1, ageAtCalving: age, milkingFreq: c(1) || null, calvingDateIso: calvingFromAge(age),
          dim, milk: num(c(3)), fat: num(c(4)), fatPct: num(c(5)), prot: num(c(6)), protPct: num(c(7)),
          compSource: c(8) || null, scs: num(c(9)),
          bca: { milk: num(c(10)), fat: num(c(11)), prot: num(c(12)), comp: num(c(13)) },
          projections: [],
        };
        profile.lactations.push(current);
      } else if (current) {
        current.projections.push({ dim, milk: num(c(3)), fat: num(c(4)), prot: num(c(6)) });
      }
    }
  }

  // --- Owners (Owner History tab) ---
  const ownerTabs = tabs.ownerHistory?.tables ?? [];
  for (const t of ownerTabs) {
    const current = /current/i.test(t.head) || /current/i.test((t.rows[0] ?? []).join(" "));
    const get = rowByHeader(t);
    for (const row of t.rows) {
      if (row.length < 2 || /^(Prefix|Owners?)$/i.test(row[0]) || /Owner\(s\)/i.test(row[0])) continue;
      const name = get(row, "Owners") || get(row, "Name") || row[1] || null;
      if (!name) continue;
      profile.owners.push({ prefix: row[0] || null, name, address: (get(row, "Address") || "").replace(/\n/g, ", ") || null, phone: get(row, "Phone") || null, date: get(row, "Ownership Date") || null, current });
    }
  }

  // --- Breeders (from Main page text block) ---
  const bm = (raw.mainText || "").match(/Breeder\(s\)[\s\S]{0,200}/i);
  if (bm) {
    const line = bm[0].split("\n").map((s) => s.trim()).filter(Boolean).find((l) => l && !/Breeder\(s\)|Prefix|Name|Address/i.test(l));
    if (line) profile.breeders.push({ prefix: null, name: line, address: null, phone: null, date: null, current: true });
  }

  // --- Family tree ---
  // Preferred: grid-computed nodes from the scraper (correct generation from the
  // real rowspan layout). Fallback: the legacy cell-index parse of the raw tables
  // (kept for older captures, but it mis-assigns generations on rowspan tables).
  if (raw.familyTreeNodes && raw.familyTreeNodes.length) {
    profile.familyTree = raw.familyTreeNodes
      .map((n) => parseAncestorCell(n.text, n.generation, n.side === "dam" ? "dam" : "sire"))
      .filter((n): n is AncestorNode => !!n && !!(n.reg || n.name));
  } else {
    const famTables = tabs.familyTree?.tables ?? [];
    profile.familyTree = [
      ...parseTreeSide(findTable(famTables, /^Sire$/i), "sire"),
      ...parseTreeSide(findTable(famTables, /^Dam$/i), "dam"),
    ];
  }

  // --- Progeny (the header row and data rows can live in sibling tables) ---
  const progRows = (tabs.progeny?.tables ?? []).flatMap((t) => t.rows);
  const pHeader = progRows.find((r) => /Reg\.?\s*No/i.test(r.join(" ")));
  if (pHeader) {
    const idx = new Map(pHeader.map((h, i) => [h.toLowerCase().replace(/\.$/, "").trim(), i]));
    const g = (row: string[], h: string) => { const i = idx.get(h.toLowerCase().replace(/\.$/, "").trim()); return i != null ? (row[i] ?? "") : ""; };
    for (const row of progRows) {
      if (row === pHeader || !/\bHO[A-Z]{3}/i.test(row.join(" "))) continue;
      profile.progeny.push({
        reg: (row.join(" ").match(/\b(HO[A-Z]{3}[MF]?\d{4,}[A-Z]?)\b/) ?? [])[1] ?? null,
        name: g(row, "Name") || null, birthDate: g(row, "Birth Date") || null,
        sex: null, classification: g(row, "Class") || null, colour: g(row, "Colour") || null,
      });
    }
  }

  // --- Classification history (Conformation tab → History table) ---
  const histTable = findTable(tabs.conformation?.tables, /History/i);
  if (histTable) {
    const get = rowByHeader(histTable);
    for (const row of histTable.rows) {
      if (row.length < 2 || /Classification Date/i.test(row.join(" ")) || /^History$/i.test(row[0])) continue;
      const scoreStr = get(row, "Score") || "";
      const cm = scoreStr.match(/(EX|VG|GP|G|F|P)?[-\s]?(\d{2,3})/);
      const date = get(row, "Classification Date");
      if (!date && !cm) continue;
      const sections: HolsteinClassification["sections"] = [];
      for (const [code, name] of [["C_RUMP", "Rump"], ["C_MAMM", "Mammary System"], ["C_DS", "Dairy Strength"], ["C_FL", "Feet & Legs"]] as [string, string][]) {
        const v = get(row, name);
        if (v) sections.push({ code, name, value: v });
      }
      profile.classifications.push({
        date: date ? toIsoFromDMY(date) ?? date : null,
        code: cm?.[1] ?? null, score: cm ? parseInt(cm[2]) : null,
        lactation: parseInt(get(row, "Lact.#") || get(row, "Lact") || "") || null,
        daysFresh: parseInt(get(row, "Days Fresh") || "") || null,
        sections,
      });
    }
  }

  // --- Shows & awards (only from the dedicated Show & Awards tab) ---
  // NB: do NOT scrape awards from the Main page — that text block also contains
  // the owner/breeder listing and would pollute the awards card.
  for (const t of tabs.showAwards?.tables ?? []) {
    for (const row of t.rows) {
      const line = row.map((c) => (c ?? "").trim()).filter(Boolean).join(" — ").trim();
      if (!line || /^(Show|Award|Result|Year|Class|Placing)s?$/i.test(line) || !/[A-Za-z]{3}/.test(line)) continue;
      if (/owner|breeder|prefix\s+name\s+address/i.test(line)) continue; // never owners/breeders
      profile.awards.push(line);
    }
  }

  return profile;
}

export function parseHolsteinExtract(raw: HolsteinRawExtract): ParsedHolstein {
  // Identity, pedigree, colour, A2, inbreeding, classification (for cows) all
  // come from the Main page text via the battle-tested legacy parser.
  const base = parseHolsteinAis(raw.mainText || "");
  const warnings = base.warnings.filter((w) => !/No genomic traits/.test(w));

  const mt = (raw.mainText || "").replace(/\r/g, "");
  const gt = (raw.genText || "").replace(/\r/g, "");
  const both = `${mt}\n${gt}`;
  const traits: HTrait[] = [];
  const push = (code: string, v: number | null, tx: string | null, rel: number | null, pctRank: number | null) => {
    if (v === null && tx === null) return;
    traits.push({ code, numericValue: v, textValue: tx, reliability: rel, percentileRank: pctRank });
  };

  // ---- Evaluation header: run (e.g. "Apr*26"), basis (GEBV/GPA/PA), reliability ----
  let evaluation: ParsedHolstein["evaluation"] = null;
  const runM = both.match(/([A-Za-z]{3})\*(\d{2})/);
  const basisM = both.match(/CAN-(GEBV|GPA|PA)/i);
  // Reliability shows as "Reliability 96%" on the Main page and "96% Reliability"
  // in the Genetics header — accept either order.
  const relM = both.match(/Reliability\s*(\d{1,3})\s*%/i) || both.match(/(\d{1,3})\s*%\s*Reliability/i);
  if (runM) {
    const mon = MONTHS[runM[1].toLowerCase()] ?? 1;
    const year = 2000 + parseInt(runM[2]);
    const monthName = MONTH_NAMES[mon] ?? runM[1];
    evaluation = {
      runLabel: `${monthName} ${year}`,
      runDate: `${year}-${String(mon).padStart(2, "0")}-01`,
      reliability: relM ? parseInt(relM[1]) / 100 : null,
      basis: basisM ? basisM[1].toUpperCase() : null,
    };
  }

  // ---- Indexes (from Main page text; positionally reliable there) ----
  const lpiM = both.match(/(?:GLPI|PA\s*LPI|\bLPI)\s+(-?\d+)(?:\s+(\d+)%)?/i);
  if (lpiM) push("LPI", parseInt(lpiM[1]), null, evaluation?.reliability ?? null, lpiM[2] ? parseInt(lpiM[2]) : null);
  const proM = both.match(/Pro\$\s+(-?\d+)/); if (proM) push("PRO$", parseInt(proM[1]), null, null, null);
  for (const [label, code] of INDEX_GROUPS) {
    const m = mt.match(new RegExp("\\b" + esc(label) + "\\s+(-?\\d+)(?:\\s+(\\d+)%)?"));
    if (m) push(code, parseInt(m[1]), null, null, m[2] ? parseInt(m[2]) : null);
  }

  // ---- Composite conformation (from Main page text; "<Composite> <value>") ----
  // CONF also carries a %rank on the Main page.
  const confM = mt.match(/\bConformation\s+(-?\d+)\s+(\d+)%/);
  if (confM) push("CONF", parseInt(confM[1]), null, null, parseInt(confM[2]));
  for (const [label, code] of [["Rump", "RUMP"], ["Dairy Strength", "DS"], ["Mammary System", "MAMM"], ["Feet & Legs", "FL"]] as [string, string][]) {
    const m = mt.match(new RegExp("\\b" + esc(label) + "\\s+(-?\\d+)\\b"));
    if (m) push(code, parseInt(m[1]), null, null, null);
  }

  const tables = raw.genTables ?? [];

  // ---- Production (Genetics page): rating in col 4, %dev in col 5, rank col 6 ----
  const prod = tableWithHead(tables, /PRODUCTION/i);
  if (prod) {
    for (const r of prod.rows) {
      const label = (r[0] ?? "").trim();
      const rating = num(r[4]);
      const dev = num(r[5]);
      const rank = pct(r[6]);
      if (/^Milk/i.test(label)) push("MILK", rating, null, null, rank);
      else if (/^Fat/i.test(label)) { push("FAT", rating, null, null, rank); if (dev !== null) push("FATPCT", dev, null, null, null); }
      else if (/^Protein/i.test(label)) { push("PROT", rating, null, null, rank); if (dev !== null) push("PROTPCT", dev, null, null, null); }
      else if (/Somatic Cell/i.test(label)) push("SCS", rating, null, null, rank);
    }
  }

  // ---- Functional traits (Genetics page): [name, basis, rating, reliability%] ----
  const func = tableWithHead(tables, /FUNCTIONAL TRAITS/i);
  if (func) {
    for (const r of func.rows) {
      const code = FUNC_MAP.get((r[0] ?? "").trim().toLowerCase());
      if (!code) continue;
      const rating = num(r[2]);
      const rel = pct(r[3]);
      push(code, rating, null, rel !== null ? rel / 100 : null, null);
    }
  }

  // ---- Linear conformation traits (Genetics page CONFORMATION table) ----
  const conf = tables.find((t) => /^CONFORMATION$/i.test((t.rows[0] ?? [])[0] ?? ""));
  if (conf) collectLinear(conf, (code, v, tx) => push(code, v, tx, null, null));

  // ---- Animal's OWN classification ----
  // On the live layout the score sits on its own line ("EX-94-5YR-CAN"), not
  // right after "Registered", so the legacy regex misses it. The animal's own
  // classification is the first EX/VG…-CAN token BEFORE the "Sire:" block; the
  // sire's/dam's scores come after. Bulls have none, so this stays null.
  let classification = base.classification;
  {
    const sireIdx = mt.search(/\bSire:/);
    const head = sireIdx >= 0 ? mt.slice(0, sireIdx) : mt;
    const cm = head.match(/\b(EX|VG|GP|G|F|P)-(\d{2,3})(?:-([0-9A-Z]{1,4}))?-CAN\b/);
    if (cm) classification = { code: cm[1], score: parseInt(cm[2]), age: cm[3] ?? null };
  }

  if (!base.regNo && !raw.reg) warnings.push("No registration number found in the scraped page.");
  if (traits.length === 0) warnings.push("No genomic traits parsed from the scrape — layout may have changed.");

  return {
    ...base,
    regNo: base.regNo ?? raw.reg ?? null,
    classification,
    evaluation,
    traits,
    warnings,
  };
}
