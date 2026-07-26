// ---------------------------------------------------------------------------
// Compact trait storage.
//
// Instead of one GeneticTraitValue ROW per trait (5.9M rows for 99k bulls),
// each GeneticEvaluation stores:
//   - traitsJson: all trait values packed into one JSON string, and
//   - real numeric columns for the traits people sort / filter by (indexed).
//
// unpack*/attach* rebuild the familiar `traitValues` array shape so the UI
// code that reads `evaluation.traitValues` keeps working unchanged.
// ---------------------------------------------------------------------------

// traitCode -> GeneticEvaluation column (Prisma field). These are the sortable/
// filterable traits; everything else lives only in traitsJson.
export const TRAIT_COLUMNS: Record<string, string> = {
  LPI: "lpi", "PRO$": "proDollar", PI: "pi", LTI: "lti", HWI: "hwi", RI: "ri", MI: "mi", EI: "ei",
  MILK: "milk", FAT: "fat", PROT: "prot", FATPCT: "fatPct", PROTPCT: "protPct", SCS: "scs",
  CONF: "conf", MAMM: "mamm", FL: "fl", DS: "ds", RUMP: "rump", AFS: "afs",
  HL: "hl", DF: "df", MR: "mr", MDR: "mdr", CA: "ca", DCA: "dca",
};

export interface RawTrait {
  traitCode: string;
  numericValue: number | null;
  textValue: string | null;
  reliability: number | null;
  percentileRank: number | null;
}

export interface TraitValueShape {
  traitCode: string;
  traitName: string;
  traitCategory: string | null;
  unit: string | null;
  numericValue: number | null;
  textValue: string | null;
  reliability: number | null;
  percentileRank: number | null;
  displayOrder: number;
}

export interface TraitDefLite { name: string; category: string | null; unit: string | null; order: number }

// Pack a list of traits into the JSON string + the indexed column values.
export function packTraits(traits: RawTrait[]): { traitsJson: string; columns: Record<string, number | null> } {
  const obj: Record<string, { n?: number; t?: string; r?: number; p?: number }> = {};
  const columns: Record<string, number | null> = {};
  for (const t of traits) {
    const e: { n?: number; t?: string; r?: number; p?: number } = {};
    if (t.numericValue != null) e.n = t.numericValue;
    if (t.textValue != null) e.t = t.textValue;
    if (t.reliability != null) e.r = t.reliability;
    if (t.percentileRank != null) e.p = t.percentileRank;
    obj[t.traitCode] = e;
    const col = TRAIT_COLUMNS[t.traitCode];
    if (col && t.numericValue != null) columns[col] = t.numericValue;
  }
  return { traitsJson: JSON.stringify(obj), columns };
}

// Rebuild the traitValue-shaped array from an evaluation's traitsJson.
export function unpackTraits(traitsJson: string | null | undefined, defMap: Map<string, TraitDefLite>): TraitValueShape[] {
  if (!traitsJson) return [];
  let obj: Record<string, { n?: number; t?: string; r?: number; p?: number }>;
  try { obj = JSON.parse(traitsJson); } catch { return []; }
  const out: TraitValueShape[] = [];
  for (const [code, e] of Object.entries(obj)) {
    const d = defMap.get(code);
    out.push({
      traitCode: code, traitName: d?.name ?? code, traitCategory: d?.category ?? null, unit: d?.unit ?? null,
      numericValue: e.n ?? null, textValue: e.t ?? null, reliability: e.r ?? null, percentileRank: e.p ?? null,
      displayOrder: d?.order ?? 0,
    });
  }
  return out.sort((a, b) => a.displayOrder - b.displayOrder);
}

// Attach `traitValues` onto each evaluation so existing UI code works unchanged.
export function attachTraits<T extends { traitsJson?: string | null }>(evals: T[], defMap: Map<string, TraitDefLite>): (T & { traitValues: TraitValueShape[] })[] {
  return evals.map((e) => ({ ...e, traitValues: unpackTraits(e.traitsJson, defMap) }));
}

// Cached trait-definition map (names/categories/units/order) for unpacking.
import { prisma } from "./db";
let _defCache: Map<string, TraitDefLite> | null = null;
export async function traitDefMap(): Promise<Map<string, TraitDefLite>> {
  if (_defCache) return _defCache;
  const defs = await prisma.traitDefinition.findMany({ where: { domain: "genetic" }, select: { traitCode: true, traitName: true, category: true, unit: true, displayOrder: true } });
  _defCache = new Map(defs.map((d) => [d.traitCode, { name: d.traitName, category: d.category, unit: d.unit, order: d.displayOrder }]));
  return _defCache;
}
