// ---------------------------------------------------------------------------
// Parse a CDCB evaluation extract: the infoANIM + infoEVAL pair.
//
// PURE — no prisma, no "server-only", no filesystem. Takes lines, returns data,
// so the unit tests can run it against vendored fixtures with no database.
//
// THE FORMAT (verified against real April-2026 files, and against CDCB's own
// reference implementation transpose_csv.py by Ezequiel Nicolazzi):
//
//   line 1   #TYPE:ANIM|RUN:monthly|DATE:2604|ANIM:1081|FIELDS:57
//   line 2   ID17|INFORMATION|VALUE                       (infoANIM, 3 columns)
//        or  ID17|TRAIT|GPTA|GREL|GSONS|DGV|PA            (infoEVAL, 7 columns)
//   rest     one row per animal per key/trait
//
// Three structural facts that the parser depends on, each verified by counting
// the real files rather than assumed:
//
//   1. FIELDS IS ROWS PER ANIMAL, not a column count. AY 2604 infoANIM declares
//      ANIM:1081 FIELDS:57 and holds exactly 1081 x 57 = 61,617 data rows;
//      infoEVAL declares 52 and holds exactly 56,212. Both matched exactly.
//   2. THE LAYOUT IS DENSE. Every animal carries every key and every trait, so a
//      value that CDCB does not publish appears as an EMPTY FIELD, never as a
//      missing row. Absence therefore cannot be inferred from a row being gone —
//      and empty must never be read as zero (an empty NM$ is "not evaluated",
//      which is a different statement from "$0").
//   3. ANIMAL BLOCKS ARE CONTIGUOUS and both files list the same animals in the
//      same order. We assert this rather than trust it: if the two files ever
//      diverge, we would be welding one bull's evaluation onto another bull's
//      identity, which is the worst failure this importer could have.
//
// Deliberately SEX-AGNOSTIC. The public /bulls/ files are all SEX=M, but CDCB
// publishes female evaluations in the same layout and those files are expected
// later — so nothing here keys off sex. Callers read `SEX` from `info`.
// ---------------------------------------------------------------------------

export interface CdcbMeta {
  /** ANIM or EVAL. */
  type: "ANIM" | "EVAL";
  /** Publication cadence as CDCB stamps it: only ever "weekly" or "monthly".
   *  NOTE this does NOT identify an official round — see file-kind.ts. */
  run: string;
  /** YYMM for triannual/monthly extracts, YYYYMMDD for weekly ones. */
  date: string;
  /** Number of animals in the file. */
  anim: number;
  /** ROWS PER ANIMAL. Not a column count. */
  fields: number;
}

/** The five value columns CDCB publishes per trait. Empty parses to null. */
export interface CdcbTraitValues {
  /** Genomic PTA — the published evaluation. */
  gpta: number | null;
  /** Reliability of the GPTA, 0-99. */
  grel: number | null;
  /** Genomic evaluation for producing SONS, X-chromosome effects excluded.
   *  Per hold.gen_stud.v20.xsd. Stored for computing a son's parent average;
   *  it is not a son count and is never rendered as one. */
  gsons: number | null;
  /** Direct genomic value — the genomic prediction alone, before blending. */
  dgv: number | null;
  /** Parent average. */
  pa: number | null;
}

export interface CdcbAnimal {
  id17: string;
  /** The infoANIM key/value pairs verbatim (ANIM_NAME, SEX, BIRTH, NAAB_CODE,
   *  SIRE17, DAM17, IS_PTA_MILK, haplotypes, inbreeding, ...). */
  info: Record<string, string>;
  /** trait code -> its five values. */
  traits: Record<string, CdcbTraitValues>;
}

export interface CdcbParsed {
  animMeta: CdcbMeta;
  evalMeta: CdcbMeta;
  animals: CdcbAnimal[];
  /** Distinct info keys, in the order the first animal declared them. */
  infoKeys: string[];
  /** Distinct trait codes, in the order the first animal declared them. */
  traitCodes: string[];
}

export class CdcbParseError extends Error {}
const fail = (m: string): never => { throw new CdcbParseError(m); };

/** Strip a UTF-8 BOM. Every real CDCB file we inspected carries one. */
const stripBom = (s: string) => s.replace(/^﻿/, "");

/** Numeric or empty. Anything else means the layout shifted. */
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)$/;

/**
 * Empty string -> null, never 0.
 *
 * CDCB leaves a trait blank when it has no evaluation for it (e.g. Ayrshire
 * publishes no health traits at all). Reading blank as zero would put a bull at
 * exactly breed-average on a trait he has never been measured for, which then
 * flows into rankings and mating scores as if it were real.
 */
function num(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (!NUMERIC.test(v)) fail(`expected a number or empty, found "${v}"`);
  return Number(v);
}

/** Parse the "#TYPE:..." metadata line. */
export function parseCdcbMeta(line: string, expect?: "ANIM" | "EVAL"): CdcbMeta {
  const s = stripBom(line ?? "").trim();
  if (!s.startsWith("#TYPE:")) {
    fail(`bad header: expected '#TYPE:ANIM|RUN:...|DATE:...|ANIM:...|FIELDS:...', found "${s.slice(0, 100)}"`);
  }
  const kv: Record<string, string> = {};
  for (const part of s.split("|")) {
    const i = part.indexOf(":");
    if (i > 0) kv[part.slice(0, i).replace("#", "").toUpperCase()] = part.slice(i + 1);
  }
  const type = kv.TYPE as "ANIM" | "EVAL";
  if (type !== "ANIM" && type !== "EVAL") fail(`bad header: unknown #TYPE "${kv.TYPE}"`);
  if (expect && type !== expect) fail(`expected a #TYPE:${expect} file, found #TYPE:${type}`);
  for (const k of ["DATE", "ANIM", "FIELDS"]) {
    if (!/^\d+$/.test(kv[k] ?? "")) fail(`bad header: ${k} must be numeric, found "${kv[k]}"`);
  }
  return { type, run: kv.RUN ?? "", date: kv.DATE, anim: Number(kv.ANIM), fields: Number(kv.FIELDS) };
}

/** Split a data line and require an exact column count. */
function cells(line: string, width: number, where: string): string[] {
  const f = line.split("|");
  if (f.length !== width) {
    fail(`${where}: expected ${width} columns, found ${f.length} in "${line.slice(0, 120)}"`);
  }
  return f;
}

/**
 * Parse a CDCB pair into per-animal records.
 *
 * Both arguments are the FULL line lists of their file (metadata line included).
 * Blank trailing lines are ignored.
 */
export function parseCdcbPair(animLines: string[], evalLines: string[]): CdcbParsed {
  const aLines = animLines.map(stripBom).filter((l, i) => i < 2 || l.trim() !== "");
  const eLines = evalLines.map(stripBom).filter((l, i) => i < 2 || l.trim() !== "");

  const animMeta = parseCdcbMeta(aLines[0], "ANIM");
  const evalMeta = parseCdcbMeta(eLines[0], "EVAL");

  // The pair must describe the same extract, or we are merging two runs.
  if (animMeta.date !== evalMeta.date) fail(`mismatched pair: infoANIM DATE=${animMeta.date} but infoEVAL DATE=${evalMeta.date}`);
  if (animMeta.run !== evalMeta.run) fail(`mismatched pair: infoANIM RUN=${animMeta.run} but infoEVAL RUN=${evalMeta.run}`);
  if (animMeta.anim !== evalMeta.anim) fail(`mismatched pair: infoANIM ANIM=${animMeta.anim} but infoEVAL ANIM=${evalMeta.anim}`);

  // Column-header lines.
  const aHead = cells(aLines[1] ?? "", 3, "infoANIM header");
  const eHead = cells(eLines[1] ?? "", 7, "infoEVAL header");
  if (aHead[0] !== "ID17") fail(`infoANIM header must start with ID17, found "${aHead.join("|")}"`);
  if (eHead[0] !== "ID17") fail(`infoEVAL header must start with ID17, found "${eHead.join("|")}"`);

  const aBody = aLines.slice(2);
  const eBody = eLines.slice(2);

  // Row counts must equal ANIM x FIELDS exactly. A short file that still parsed
  // row-by-row would otherwise import silently as a partial round.
  const expectedA = animMeta.anim * animMeta.fields;
  const expectedE = evalMeta.anim * evalMeta.fields;
  if (aBody.length !== expectedA) {
    fail(`infoANIM: header declares ${animMeta.anim} animals x ${animMeta.fields} rows = ${expectedA}, found ${aBody.length} rows`);
  }
  if (eBody.length !== expectedE) {
    fail(`infoEVAL: header declares ${evalMeta.anim} animals x ${evalMeta.fields} rows = ${expectedE}, found ${eBody.length} rows`);
  }

  const animals: CdcbAnimal[] = [];
  let infoKeys: string[] = [];
  let traitCodes: string[] = [];

  for (let i = 0; i < animMeta.anim; i++) {
    const info: Record<string, string> = {};
    const traits: Record<string, CdcbTraitValues> = {};
    let id17 = "";

    for (let r = 0; r < animMeta.fields; r++) {
      const f = cells(aBody[i * animMeta.fields + r], 3, `infoANIM animal #${i + 1}`);
      if (r === 0) id17 = f[0];
      else if (f[0] !== id17) fail(`infoANIM: animal block #${i + 1} is not contiguous — ${id17} then ${f[0]} (FIELDS=${animMeta.fields} does not match the real rows per animal)`);
      info[f[1]] = f[2] ?? "";
      if (i === 0) infoKeys.push(f[1]);
    }

    for (let r = 0; r < evalMeta.fields; r++) {
      const f = cells(eBody[i * evalMeta.fields + r], 7, `infoEVAL animal #${i + 1}`);
      if (f[0] !== id17) {
        fail(`animal #${i + 1} differs between files: infoANIM has ${id17}, infoEVAL has ${f[0]}. Refusing to merge mismatched records.`);
      }
      const code = f[1];
      try {
        traits[code] = { gpta: num(f[2]), grel: num(f[3]), gsons: num(f[4]), dgv: num(f[5]), pa: num(f[6]) };
      } catch (e) {
        fail(`infoEVAL ${id17} trait ${code}: ${(e as Error).message}`);
      }
      if (i === 0) traitCodes.push(code);
    }

    animals.push({ id17, info, traits });
  }

  return { animMeta, evalMeta, animals, infoKeys, traitCodes };
}

/** Convenience: parse from raw file text rather than pre-split lines. */
export function parseCdcbPairText(animText: string, evalText: string): CdcbParsed {
  return parseCdcbPair(animText.split(/\r?\n/), evalText.split(/\r?\n/));
}
