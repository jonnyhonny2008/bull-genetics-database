// ---------------------------------------------------------------------------
// Parse lactanetgen.ca pages into the EXISTING HolsteinProfile shape.
//
// Deliberately no new types: everything lands in the interfaces already defined
// in holstein-parse.ts, so every profile component (family tree, progeny,
// lactations, classification) renders unchanged. Where Lactanet does not carry
// a field, it stays null/empty rather than being invented.
//
// Not carried by Lactanet, and therefore always empty here:
//   • owners / breeders  — registry data, Holstein Canada only
//   • awards             — show results, Holstein Canada only
// The animal profile drops those two tabs accordingly.
//
// Classification is FEMALES ONLY. A bull is never classified himself; his Type
// page shows DAUGHTER distributions, which are an evaluation of transmitting
// ability, not a score for the animal. Writing that into `classifications`
// would claim the bull was classified, so for males it is left empty.
// ---------------------------------------------------------------------------

import type {
  AncestorNode,
  HolsteinClassification,
  HolsteinProfile,
  Lactation,
  ProgenyRow,
} from "./holstein-parse";

// --- tiny HTML helpers (no DOM, no cheerio — the project has no HTML parser) --

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#160": " ",
  // Lactanet writes the proof-run separator as &ast; ("GEBV 26&ast;APR"). Missing
  // this silently broke run detection, which meant no evaluation was written at
  // all — i.e. every imported animal came back with zero traits.
  ast: "*", ndash: "-", mdash: "-", minus: "-", deg: "°", frac12: "1/2",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    const k = code.toLowerCase();
    if (ENT[k]) return ENT[k];
    if (/^#x/i.test(code)) return String.fromCharCode(parseInt(code.slice(2), 16));
    if (/^#/.test(code)) return String.fromCharCode(parseInt(code.slice(1), 10));
    return m;
  });
}

/** Strip tags to readable text, turning block ends into newlines. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|td|th|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const numOrNull = (s: string | null | undefined): number | null => {
  const t = clean(s).replace(/[, $%]/g, "").replace(/^\+/, "");
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** "08-OCT-19" → "2019-10-08". Two-digit years: >=40 ⇒ 19xx, else 20xx. */
export function toIsoDate(raw: string | null | undefined): string | null {
  const s = clean(raw).toUpperCase();
  let m = /^(\d{1,2})-([A-Z]{3})-(\d{2,4})$/.exec(s);
  if (m) {
    const mm = MONTHS[m[2]];
    if (!mm) return null;
    let y = m[3];
    if (y.length === 2) y = Number(y) >= 40 ? `19${y}` : `20${y}`;
    return `${y}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? s : null;
}

// --- generic table extraction (header-driven, resilient to layout churn) ------

export interface HtmlTable { headers: string[]; rows: string[][] }

export function extractTables(html: string): HtmlTable[] {
  const out: HtmlTable[] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(html))) {
    const body = t[1];
    const rows: string[][] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(body))) {
      const cells: string[] = [];
      const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(r[1]))) cells.push(clean(stripTags(c[1])));
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) continue;
    out.push({ headers: rows[0], rows: rows.slice(1) });
  }
  return out;
}

/** Index of the first header matching any of `names` (case/space-insensitive). */
function col(headers: string[], ...names: string[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = names.map(norm);
  return headers.findIndex((h) => want.some((w) => norm(h).includes(w)));
}
const at = (row: string[], i: number): string | null => (i >= 0 && i < row.length ? clean(row[i]) || null : null);

// --- identity (summary.php) --------------------------------------------------

export interface LactanetIdentity {
  reg: string | null;
  name: string | null;
  shortName: string | null;
  naab: string | null;
  birthDate: string | null; // ISO
  inbreeding: number | null;
  rValue: number | null;
  markers: string | null;
}

export function parseIdentity(html: string): LactanetIdentity {
  const text = stripTags(html);
  const out: LactanetIdentity = {
    reg: null, name: null, shortName: null, naab: null,
    birthDate: null, inbreeding: null, rValue: null, markers: null,
  };
  out.reg = /\b([A-Z]{2}[A-Z0-9]{3}[MF]\d{5,})\b/.exec(text)?.[1] ?? null;
  out.naab = /\b(\d{2,3}HO\d{3,6})\b/.exec(text)?.[1] ?? null;
  out.birthDate = toIsoDate(/Born\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i.exec(text)?.[1] ?? null);
  out.inbreeding = numOrNull(/INB\s+([\d.]+)\s*%/i.exec(text)?.[1] ?? /([\d.]+)\s*%\s*INB/i.exec(text)?.[1] ?? null);
  out.rValue = numOrNull(/\bR\s+([\d.]+)\s*%/i.exec(text)?.[1] ?? /([\d.]+)\s*%\s*R\b/i.exec(text)?.[1] ?? null);

  // The header block runs: REG / NAME / SHORTNAME / NAAB / markers.
  const lines = text.split("\n").map(clean).filter(Boolean);
  const ri = out.reg ? lines.findIndex((l) => l === out.reg || l.startsWith(out.reg!)) : -1;
  if (ri >= 0) {
    if (lines[ri + 1] && !/^\d/.test(lines[ri + 1])) out.name = lines[ri + 1];
    if (lines[ri + 2] && out.naab !== lines[ri + 2] && !/^\d/.test(lines[ri + 2])) out.shortName = lines[ri + 2];
    const mk = lines.slice(ri + 1, ri + 6).find((l) => /\b(A2A2|A1A2|A1A1|ET|BW|RDC|POC|POS|TL|TV|TY)\b/.test(l));
    out.markers = mk ?? null;
  }
  return out;
}

// --- pedigree (pedigree.php) -------------------------------------------------

// The page renders two <div class="PedigreeTree"> blocks — sire side, then dam
// side — each holding seven <div class="TreeInfo…"> ancestor cards laid out
// column by column. So DOM order within a side is
//   [parent, grandparent, grandparent, ggp, ggp, ggp, ggp]
// and generation follows from the index. Verified against the real fixture:
// the sire side reads COOMBOONA(1) → OCD ERASER(2), CALBRETT KINGBOY(2) →
// KERNDTWAY(3), LANDIS-MRK(3), MORNINGVIEW(3), SNOWBIZ(3).
const GEN_BY_INDEX = [1, 2, 2, 3, 3, 3, 3];

function parseAncestorCard(block: string, side: "sire" | "dam", generation: number): AncestorNode | null {
  const name = clean(stripTags(/<p[^>]*class="[^"]*fw-bold[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? ""));
  // The registration is the anchor text on the link back to that animal.
  const reg =
    clean(stripTags(/<a[^>]*href="[^"]*summary\.php[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "")) || null;
  const text = stripTags(block);
  const birthDate = toIsoDate(/Born:?\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i.exec(text)?.[1] ?? null);
  // Everything that isn't name/reg/born is the marker + haplotype detail.
  const extra =
    clean(
      text
        .replace(name, " ")
        .replace(reg ?? "", " ")
        .replace(/Born:?\s*\d{1,2}-[A-Za-z]{3}-\d{2,4}/i, " "),
    ) || null;
  if (!name && !reg) return null;
  return { generation, side, name: name || null, reg, classification: null, birthDate, extra };
}

export function parsePedigree(html: string): AncestorNode[] {
  const out: AncestorNode[] = [];
  // Split into the two side blocks without a DOM: cut at each PedigreeTree open.
  const parts = html.split(/<div[^>]*class="[^"]*PedigreeTree[^"]*"[^>]*>/i).slice(1);
  parts.slice(0, 2).forEach((part, sideIdx) => {
    const side: "sire" | "dam" = sideIdx === 0 ? "sire" : "dam";
    const cards = part.match(/<div[^>]*class="[^"]*TreeInfo[^"]*"[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*(?:TreeInfo|DisplayTable|PedigreeTree)|<\/div>\s*<\/div>\s*<\/div>)/gi) ?? [];
    cards.forEach((block, i) => {
      const node = parseAncestorCard(block, side, GEN_BY_INDEX[i] ?? 3);
      if (node) out.push(node);
    });
  });
  return out;
}

// --- progeny (progeny.php) ---------------------------------------------------

export interface ProgenyResult { rows: ProgenyRow[]; total: number | null; capped: boolean }

export function parseProgeny(html: string): ProgenyResult {
  const text = stripTags(html);
  const total = numOrNull(/has\s+([\d,]+)\s+progeny/i.exec(text)?.[1] ?? null);
  const capped = /maximum of\s*\d+\s*will be displayed/i.test(text);

  // Pick the widest table that actually looks like the progeny grid.
  const tables = extractTables(html).filter((t) => col(t.headers, "registration", "regno") >= 0);
  const t = tables.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!t) return { rows: [], total, capped };

  const cReg = col(t.headers, "registration", "regno");
  const cName = col(t.headers, "animalname", "name");
  const cSex = col(t.headers, "sex");
  const cBirth = col(t.headers, "birthdate", "born");
  const cClass = col(t.headers, "classification", "class");
  const cColour = col(t.headers, "coatcolour", "coatcolor", "colour", "color");

  const rows: ProgenyRow[] = [];
  for (const r of t.rows) {
    const reg = at(r, cReg);
    const name = at(r, cName);
    if (!reg && !name) continue;
    rows.push({
      reg,
      name,
      birthDate: toIsoDate(at(r, cBirth)),
      sex: at(r, cSex),
      classification: cClass >= 0 ? at(r, cClass) : null,
      colour: at(r, cColour),
    });
  }
  return { rows, total, capped };
}

// --- classification (classification.php) — FEMALES ONLY ----------------------

/** Find, within a table's rows, the header row that names a column matching any
 *  of `names`. classification/lactation pages use a title row + a real header
 *  row, so the header is not always row 0. Returns {headers, dataRows}. */
function headerRow(t: HtmlTable, ...names: string[]): { headers: string[]; dataRows: string[][] } | null {
  const all = [t.headers, ...t.rows];
  const hi = all.findIndex((r) => col(r, ...names) >= 0);
  if (hi < 0) return null;
  return { headers: all[hi], dataRows: all.slice(hi + 1) };
}

/**
 * A cow's OWN classification, from classification.php: one row per classification
 * event (Date, Final Class, Final Score, composites), newest first, plus the
 * current linear-trait descriptor grid. Bulls are never classified — their
 * Type page is a daughter distribution — so males return [].
 */
export function parseClassifications(html: string, sex: "M" | "F"): HolsteinClassification[] {
  if (sex !== "F") return [];
  const tables = extractTables(html);

  // The descriptor grid is a header-less table of name/value pairs (Udder Floor 5,
  // Foot Angle 6, …). Detect it as the table whose even cells are mostly known
  // linear-trait names paired with a number, and keep it for the newest class'n.
  const linearSections: { code: string; name: string; value: string }[] = [];
  for (const t of tables) {
    const secs: { code: string; name: string; value: string }[] = [];
    let pairs = 0;
    for (const r of [t.headers, ...t.rows]) {
      for (let i = 0; i + 1 < r.length; i += 2) {
        pairs++;
        const code = TRAIT_LABELS[normLabel(r[i])];
        const v = clean(r[i + 1]);
        if (code && /^-?\d/.test(v)) secs.push({ code, name: clean(r[i]), value: v });
      }
    }
    if (secs.length >= 6 && secs.length >= pairs * 0.4) { linearSections.push(...secs); break; }
  }

  const out: HolsteinClassification[] = [];
  for (const t of tables) {
    const h = headerRow(t, "finalscore");
    if (!h) continue;
    const cScore = col(h.headers, "finalscore");
    const cClass = col(h.headers, "finalclass");
    const cDate = col(h.headers, "date");
    const cLact = col(h.headers, "lactation");
    const cDim = col(h.headers, "dim");
    const comps: [number, string, string][] = [
      [col(h.headers, "mammary"), "MAMM", "Mammary System"],
      [col(h.headers, "feetlegs", "feet"), "FL", "Feet & Legs"],
      [col(h.headers, "dairystrength"), "DS", "Dairy Strength"],
      [col(h.headers, "rump"), "RUMP", "Rump"],
    ];
    for (const r of h.dataRows) {
      const score = numOrNull(at(r, cScore));
      const code = at(r, cClass);
      if (!code && score == null) continue;
      if (code && !/^(EX|VG|GP|G|F|P)$/i.test(code)) continue; // skip stray rows
      const sections = comps
        .filter(([ci]) => ci >= 0)
        .map(([ci, cd, nm]) => ({ code: cd, name: nm, value: at(r, ci) ?? "" }))
        .filter((s) => s.value);
      out.push({
        date: toIsoDate(at(r, cDate)),
        code: code ? code.toUpperCase() : null,
        score,
        lactation: numOrNull(at(r, cLact)),
        daysFresh: numOrNull(at(r, cDim)),
        sections,
      });
    }
  }

  // Attach the linear descriptors to the newest (first) classification.
  if (linearSections.length && out.length) out[0] = { ...out[0], sections: [...out[0].sections, ...linearSections] };
  return out;
}

// --- lactations (lactation.php) — FEMALES ONLY -------------------------------

/**
 * A cow's lactation records from lactation.php. Each calving row (a real date in
 * col 0) is a lactation to 305 DIM; the blank-date rows beneath it are its longer
 * projections (365-day, natural). Parsed positionally — the header carries long
 * tooltip text that makes name-matching unreliable — against the observed layout:
 *   Date | Age | flag | freq | DIM | Milk | Fat | %F | Prot | %P | CompSrc |
 *   EndReason | SCC | BCA(Milk Fat Prot Comp) | BCA-Deviations(…)
 * Bulls have no lactations of their own, so males return [].
 */
export function parseLactations(html: string, sex: "M" | "F"): Lactation[] {
  if (sex !== "F") return [];
  const DATE = /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/;
  // The lactation table is the one that has a real calving-date row.
  const t = extractTables(html).find((x) => [x.headers, ...x.rows].some((r) => DATE.test(clean(r[0]))));
  if (!t) return [];

  const out: Lactation[] = [];
  let cur: Lactation | null = null;
  for (const r of [t.headers, ...t.rows]) {
    const c0 = clean(r[0]);
    if (/lactation\(s\)/i.test(c0)) { cur = null; continue; } // per-lactation summary line
    const dim = numOrNull(at(r, 4));
    if (DATE.test(c0)) {
      cur = {
        lactationNumber: out.length + 1,
        ageAtCalving: clean(r[1]) || null,
        milkingFreq: clean(r[3]) || null,
        calvingDateIso: toIsoDate(c0),
        dim,
        milk: numOrNull(at(r, 5)),
        fat: numOrNull(at(r, 6)),
        fatPct: numOrNull(at(r, 7)),
        prot: numOrNull(at(r, 8)),
        protPct: numOrNull(at(r, 9)),
        scs: numOrNull(at(r, 12)),
        compSource: clean(r[10]) || null,
        bca: { milk: numOrNull(at(r, 13)), fat: numOrNull(at(r, 14)), prot: numOrNull(at(r, 15)), comp: numOrNull(at(r, 16)) },
        projections: [],
      };
      out.push(cur);
    } else if (cur && !c0 && dim != null) {
      // A continuation row (blank calving date) is a longer projection of `cur`.
      cur.projections.push({ dim, milk: numOrNull(at(r, 5)), fat: numOrNull(at(r, 6)), prot: numOrNull(at(r, 8)) });
    }
  }
  return out;
}

// --- genetic traits (summary.php + type.php) ---------------------------------

/**
 * Lactanet's on-page label -> our TraitDefinition.traitCode.
 *
 * Most labels equal traitName exactly, so this only has to carry the ones that
 * differ plus the index names (Lactanet calls them "LPI Subindexes" and prints
 * the short label). Keys are normalised (lowercase, alphanumerics only).
 */
const TRAIT_LABELS: Record<string, string> = {
  // headline
  lpi: "LPI", pro$: "PRO$", prodollar: "PRO$",
  // production
  milk: "MILK", fat: "FAT", protein: "PROT",
  somaticcellscore: "SCS", scs: "SCS",
  // LPI subindexes — page prints the short name
  production: "PI", longevitytype: "LTI", healthwelfare: "HWI",
  reproduction: "RI", milkability: "MI", environmentalimpact: "EI",
  // conformation composites
  conformation: "CONF", mammarysystem: "MAMM", feetlegs: "FL",
  dairystrength: "DS", rump: "RUMP", averagedaughterfinalscore: "AFS",
  // functional / health
  methaneefficiency: "METH", feedefficiency: "FE",
  bodymaintenancerequirements: "BMR", herdlife: "HL",
  mastitisresistance: "MR", metabolicdiseaseresistance: "MDR",
  hoofhealth: "HH", calfhealth: "CH", lactationpersistency: "LP",
  daughterfertility: "DF", milkingspeed: "MSPD", milkingtemperament: "MTMP",
  calvingability: "CA", daughtercalvingability: "DCA",
  bodyconditionscore: "BCS", semenfertility: "SEMFERT",
  gestationlength: "GL", calvingease: "CE",
  // linear (type.php descriptive traits)
  udderfloor: "UFLOOR", udderdepth: "UDEP", uddertexture: "UTEX",
  mediansuspensory: "MSUS", foreattachment: "FUA",
  frontteatplacement: "FTP", foreteatplacement: "FTP",
  rearattachmentheight: "RAH", rearattachmentwidth: "RAW",
  rearteatplacement: "RTP", teatlength: "TL",
  footangle: "FA", heeldepth: "HD", bonequality: "BQ",
  rearlegssideview: "RLSV", rearlegsrearview: "RLRV",
  frontlegview: "FLV", frontlegsview: "FLV", locomotion: "LOCO",
  stature: "STA", heightatfrontend: "HFE", chestwidth: "CHW",
  bodydepth: "BODY", ribstructure: "RIB", ribstructureangularity: "RIB",
  loinstrength: "LOIN", rumpangle: "RA", pinwidth: "PW",
  thurlplacement: "THURL",
};

const normLabel = (s: string) => s.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9$]/g, "");

export interface LactanetTrait {
  code: string;
  numericValue: number | null;
  textValue: string | null;
  reliability: number | null;   // 0-1
  percentileRank: number | null;
}

export interface LactanetEvaluation {
  runLabel: string | null;  // "April 2026"
  runDate: string | null;   // ISO
  basis: string | null;     // GEBV | EBV | PA | GPA
  reliability: number | null; // 0-1
  traits: LactanetTrait[];
}

const RUN_MONTHS: Record<string, [string, string]> = {
  APR: ["04", "April"], AUG: ["08", "August"], DEC: ["12", "December"],
  JAN: ["01", "January"], FEB: ["02", "February"], MAR: ["03", "March"],
  MAY: ["05", "May"], JUN: ["06", "June"], JUL: ["07", "July"],
  SEP: ["09", "September"], OCT: ["10", "October"], NOV: ["11", "November"],
};

/**
 * Pull every trait Lactanet publishes for the animal.
 *
 * Table-driven and label-keyed rather than positional, so a column being added
 * or reordered upstream degrades to "that trait is missing" instead of silently
 * importing the wrong number into the wrong trait.
 */
export function parseTraits(summaryHtml?: string, typeHtml?: string): LactanetEvaluation {
  const out: LactanetEvaluation = { runLabel: null, runDate: null, basis: null, reliability: null, traits: [] };
  const seen = new Set<string>();

  const push = (code: string, numericValue: number | null, reliability: number | null, percentileRank: number | null) => {
    if (!code || seen.has(code)) return;
    if (numericValue == null) return;
    seen.add(code);
    out.traits.push({ code, numericValue, textValue: null, reliability, percentileRank });
  };

  const text = summaryHtml ? stripTags(summaryHtml) : "";

  // Proof run: "GEBV 26*APR" / "EBV 26*APR" / "GPA 25*DEC"
  const run = /\b(GEBV|GPA|EBV|PA)\s+(\d{2})\s*\*\s*([A-Z]{3})\b/i.exec(text);
  if (run) {
    out.basis = run[1].toUpperCase();
    const mm = RUN_MONTHS[run[3].toUpperCase()];
    if (mm) {
      const year = `20${run[2]}`;
      out.runDate = `${year}-${mm[0]}-01`;
      out.runLabel = `${mm[1]} ${year}`;
    }
  }
  // Headline reliability, e.g. "Rel: 95%"
  const relPct = numOrNull(/Rel:?\s*(\d{1,3})\s*%/i.exec(text)?.[1] ?? null);
  if (relPct != null) out.reliability = Math.min(1, relPct / 100);

  // LPI + Pro$ read off the text; they're rendered as headline blocks, not rows.
  const lpi = numOrNull(/\bLPI\s*\n?\s*(-?[\d,]+)/i.exec(text)?.[1] ?? null);
  if (lpi != null) push("LPI", lpi, out.reliability, numOrNull(/%RK:?\s*(\d{1,3})/i.exec(text)?.[1] ?? null));
  const prod = numOrNull((/Pro\$\s*\n?\s*(-?\$?[\d,]+)/i.exec(text)?.[1] ?? "").replace("$", ""));
  if (prod != null) push("PRO$", prod, out.reliability, null);

  // Every table on both pages: row label in cell 0, first numeric cell is the value.
  for (const html of [summaryHtml, typeHtml]) {
    if (!html) continue;
    for (const t of extractTables(html)) {
      for (const row of [t.headers, ...t.rows]) {
        if (row.length < 2) continue;
        // The label is NOT always cell 0 — the production table packs two
        // logical columns per row, e.g.
        //   ["Herds","294","Milk","-223","23",""]
        //   ["Daughters/Lactations","603/938","Fat","-43","2","-0.29"]
        // so scan every cell for a known trait name.
        for (let li = 0; li < row.length - 1; li++) {
          const code = TRAIT_LABELS[normLabel(row[li])];
          if (!code) continue;

          // First cell after the label that parses as a number is the rating.
          // Strip a trailing basis marker ("102 G", "97 GPA").
          let value: number | null = null;
          let vi = -1;
          for (let i = li + 1; i < row.length; i++) {
            const n = numOrNull(row[i].replace(/\s*(GEBV|GPA|EBV|PA|G)\s*$/i, ""));
            if (n != null) { value = n; vi = i; break; }
          }
          if (value == null) continue;

          // Then: a "%"-suffixed cell is reliability; a bare 0-100 integer is
          // %RK; a further decimal is the %Dev column (fat/protein percent).
          let rel: number | null = null;
          let rk: number | null = null;
          let dev: number | null = null;
          for (let i = vi + 1; i < Math.min(row.length, vi + 4); i++) {
            const c = row[i].trim();
            if (!c) continue;
            const n = numOrNull(c);
            if (n == null) continue;
            if (/%$/.test(c)) { if (rel == null) rel = Math.min(1, n / 100); }
            else if (rk == null && Number.isInteger(n) && n >= 0 && n <= 100) rk = n;
            else if (dev == null) dev = n;
          }

          push(code, value, rel ?? out.reliability, rk);
          // Fat/Protein carry their percent deviation in the same row.
          if (dev != null && (code === "FAT" || code === "PROT")) {
            push(code === "FAT" ? "FATPCT" : "PROTPCT", dev, rel ?? out.reliability, null);
          }
        }
      }
    }
  }

  // Fat % / Protein % live in the production table's "%Dev" column, which the
  // generic pass above skips (the row label is "Fat"/"Protein", already taken).
  const dev = (label: string) => {
    const re = new RegExp(`${label}\\s+(-?[\\d.]+)\\s+(\\d{1,3})\\s+(-?[\\d.]+)`, "i");
    return numOrNull(re.exec(text)?.[3] ?? null);
  };
  const fatDev = dev("Fat");
  if (fatDev != null) push("FATPCT", fatDev, out.reliability, null);
  const protDev = dev("Protein");
  if (protDev != null) push("PROTPCT", protDev, out.reliability, null);

  return out;
}

// --- assembly ----------------------------------------------------------------

export interface LactanetParsed {
  identity: LactanetIdentity;
  profile: HolsteinProfile;
  evaluation: LactanetEvaluation;
  progenyTotal: number | null;
  progenyCapped: boolean;
  warnings: string[];
}

export function parseLactanetAnimal(
  reg: string,
  sex: "M" | "F",
  tabs: Partial<Record<string, string>>,
  fetchedAt: string | null = null,
): LactanetParsed {
  const warnings: string[] = [];
  const identity = tabs.summary ? parseIdentity(tabs.summary) : {
    reg: null, name: null, shortName: null, naab: null, birthDate: null, inbreeding: null, rValue: null, markers: null,
  };
  if (!tabs.summary) warnings.push("summary page missing — identity fields unavailable");

  const familyTree = tabs.pedigree ? parsePedigree(tabs.pedigree) : [];
  if (tabs.pedigree && familyTree.length === 0) warnings.push("pedigree page returned no ancestors");

  const prog = tabs.progeny ? parseProgeny(tabs.progeny) : { rows: [], total: null, capped: false };
  if (prog.capped && prog.total) {
    warnings.push(`progeny list truncated by Lactanet: showing ${prog.rows.length} of ${prog.total}`);
  }

  // Females carry their own classification.php + lactation.php; bulls don't.
  const classifications = tabs.classification ? parseClassifications(tabs.classification, sex) : [];
  const lactations = tabs.lactation ? parseLactations(tabs.lactation, sex) : [];

  // Extra linear traits live on type.php for bulls, detail-genomics.php for cows.
  const evaluation = parseTraits(tabs.summary, sex === "F" ? tabs["detail-genomics"] : tabs.type);
  if (!evaluation.traits.length) warnings.push("no genetic traits found on the summary/type pages");
  else if (!evaluation.runDate) warnings.push("traits found but the proof run could not be read — evaluation not dated");

  const profile: HolsteinProfile = {
    reg: identity.reg ?? reg,
    owners: [],   // not published by Lactanet
    breeders: [], // not published by Lactanet
    familyTree,
    progeny: prog.rows,
    classifications,
    lactations,
    awards: [],   // not published by Lactanet
    scrapedAt: fetchedAt,
  };

  return { identity, profile, evaluation, progenyTotal: prog.total, progenyCapped: prog.capped, warnings };
}
