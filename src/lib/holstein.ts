import "server-only";

// ---------------------------------------------------------------------------
// Compliant Holstein.ca capture support.
//
// We do NOT auto-fetch Holstein.ca (their robots.txt disallows /en/AIS/ for all
// agents and blocks AI bots). The user — signed into their own session — opens
// the animal page and pastes it; this module parses the pasted page content.
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
  evaluation: { runLabel: string; runDate: string; reliability: number | null } | null;
  traits: HTrait[];
  pedigree: { relation: string; reg: string | null; name: string | null }[];
  warnings: string[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

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
  ["Fore Attachment", "FUA"], ["Front Teat Placement", "FTP"], ["Rear Attachment Height", "RAH"],
  ["Rear Attachment Width", "RAW"], ["Rear Teat Placement", "RTP"], ["Teat Length", "TL"],
  ["Foot Angle", "FA"], ["Heel Depth", "HD"], ["Bone Quality", "BQ"],
  ["Rear Legs Side View", "RLSV"], ["Rear Legs Rear View", "RLRV"], ["Front Legs View", "FLV"], ["Locomotion", "LOCO"],
];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&");
}

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
    const monthName = runM[1][0].toUpperCase() + runM[1].slice(1).toLowerCase();
    const relM = t.match(/(\d+)%\s*Reliability/i);
    evaluation = { runLabel: `${monthName} ${year}`, runDate: `${year}-${String(mon).padStart(2, "0")}-01`, reliability: relM ? parseInt(relM[1]) / 100 : null };
  }

  const push = (code: string, v: number | null, text: string | null, rel: number | null, pct: number | null) => {
    if (v === null && text === null) return;
    traits.push({ code, numericValue: v, textValue: text, reliability: rel, percentileRank: pct });
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
    // avoid "Rump Angle" when matching "Rump": require the value not be followed by a descriptor label
    const m = t.match(new RegExp(esc(labelR) + "\\s+(-?\\d+)(?:\\s+(\\d+))?"));
    if (m) push(code, parseInt(m[1]), null, null, m[2] ? parseInt(m[2]) : null);
  }

  // Linear traits (signed value + optional descriptor letter attached to the number,
  // e.g. "1T", "3H", "2C"). The descriptor must be immediately adjacent — no
  // whitespace — otherwise it's the next column's label, not a descriptor.
  for (const [labelR, code] of LINEAR) {
    const m = t.match(new RegExp(esc(labelR) + "\\s+(-?\\d+)([A-Za-z]?)"));
    if (m) push(code, parseInt(m[1]), m[2] ? m[2].toUpperCase() : null, null, null);
  }

  // Pedigree (sire + dam).
  const pedigree: ParsedHolstein["pedigree"] = [];
  const sireM = t.match(/Sire:\s*(HOCAN[MF]\d+)\s*([A-Z0-9'’\-\. ]+?)\s{2,}|Sire:\s*(HOCAN[MF]\d+)\s*([A-Z0-9'’\-\. ]+)/);
  if (sireM) pedigree.push({ relation: "sire", reg: sireM[1] ?? sireM[3] ?? null, name: (sireM[2] ?? sireM[4] ?? "").trim() || null });
  const damM = t.match(/Dam:\s*(HOCAN[MF]\d+)\s*([A-Z0-9'’\-\. ]+?)(?:\s{2,}|\s+PB|\s+GP|\s+VG|\s+EX|\n|$)/);
  if (damM) pedigree.push({ relation: "dam", reg: damM[1], name: damM[2].trim() || null });

  if (!regNo) warnings.push("Could not find a registration number — check the pasted text.");
  if (traits.length === 0) warnings.push("No genomic traits parsed — the page layout may differ; paste the full page.");

  return {
    regNo, nationalId, name, sex, birthDate, purity, herdNo, colour, betaCasein, inbreeding, rValue,
    classification, classificationSections, evaluation, traits, pedigree, warnings,
  };
}
