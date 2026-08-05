import "server-only";

// ---------------------------------------------------------------------------
// Trait Finder — query the lineup for bulls that clear a chosen bar on several
// traits AT ONCE. "Long teats AND positive milk AND milking speed over 100" is
// three conditions AND-ed together; only bulls that pass every one are returned,
// and the list is sortable by any queried trait.
//
// It reads each bull's PREFERRED proof (official where one exists — see
// proof-file-kind / priority) and works off traitsJson, so it can filter on ANY
// trait, including the linear type traits (teat length, bone quality) and the
// 100-scale functional ones (milking speed, daughter fertility) that have no
// indexed column.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import type { Prisma } from "@prisma/client";
import { blondinWhere } from "./sire-class";
import { unpackTraits, traitDefMap } from "./eval-traits";

/**
 * 100-scale functional ratings, where the breed average is 100 and "positive"
 * means ABOVE 100 — not above 0. Everything else (production deviations, the
 * −15…+15 linear traits, the index values) is centred on 0, so "positive" there
 * means above 0. This is why "milking speed over one hundred" is the natural way
 * to ask for a good milking-speed bull.
 */
const RATING_CODES = new Set([
  "SCS", "HL", "DF", "MR", "MDR", "CA", "DCA", "MSPD", "MTMP", "LP", "FE", "METH", "HH", "BMR", "CO", "CH", "BCS", "SEMFERT",
]);

export function traitBaseline(code: string): number {
  return RATING_CODES.has(code) ? 100 : 0;
}

export type Op = "above" | "below";

export interface QueryableTrait {
  code: string;
  name: string;
  group: string; // optgroup label for the dropdown
  order: number;
  isLinear: boolean;
  leftLabel: string | null;
  rightLabel: string | null;
  baseline: number;
  /** Short human note on the scale + what "positive" means. */
  hint: string;
}

/** Every trait a bull carries that it makes sense to query on, grouped for a menu. */
export async function queryableTraits(): Promise<QueryableTrait[]> {
  const defs = await prisma.traitDefinition.findMany({
    // Dairy only — the beef defs (marbling, ribeye, …) exist in the catalogue but
    // no dairy sire carries them, so they'd only clutter the menu.
    where: { domain: "genetic", active: true, speciesType: "dairy" },
    select: { traitCode: true, traitName: true, category: true, displayOrder: true, isLinear: true, leftLabel: true, rightLabel: true, graphGroup: true },
  });
  // Descriptive/genomic traits (A2, polled, colour) are text, not numeric, so a
  // threshold query makes no sense — drop them by category and by code.
  const TEXT_ONLY = new Set(["A2", "POLLED", "COLOUR"]);
  return defs
    .filter((d) => !TEXT_ONLY.has(d.traitCode) && d.category !== "Genomics" && d.category !== "Descriptive")
    .map((d) => {
      const baseline = traitBaseline(d.traitCode);
      const group = d.isLinear ? `Linear — ${d.graphGroup ?? "Type"}` : d.category ?? "Other";
      const hint = d.isLinear
        ? `${d.leftLabel ?? "−"} ↔ ${d.rightLabel ?? "+"} · 0 = average, + is toward ${d.rightLabel ?? "the right"}`
        : baseline === 100
          ? "100 = breed average · higher is better"
          : "deviation · 0 = average, higher is better";
      return {
        code: d.traitCode, name: d.traitName, group, order: d.displayOrder,
        isLinear: !!d.isLinear, leftLabel: d.leftLabel, rightLabel: d.rightLabel, baseline, hint,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export interface Condition {
  code: string;
  op: Op;
  /** null → use the trait's positive baseline (strictly beyond it). */
  value: number | null;
}

const MAX_CONDITIONS = 6;

/** Read the fixed condition rows (t1/o1/v1 … t6/o6/v6) off the query string. */
export function parseConditions(sp: Record<string, string | undefined>): Condition[] {
  const out: Condition[] = [];
  for (let i = 1; i <= MAX_CONDITIONS; i++) {
    const code = (sp[`t${i}`] ?? "").trim().toUpperCase();
    if (!code) continue;
    const op: Op = sp[`o${i}`] === "below" ? "below" : "above";
    const raw = (sp[`v${i}`] ?? "").trim();
    const value = raw === "" ? null : Number(raw);
    out.push({ code, op, value: value != null && Number.isFinite(value) ? value : null });
  }
  return out;
}

/** Does a value clear one condition? Blank value = strictly beyond the baseline. */
function passes(value: number, c: Condition, baseline: number): boolean {
  if (c.value == null) return c.op === "above" ? value > baseline : value < baseline;
  return c.op === "above" ? value >= c.value : value <= c.value;
}

export interface FinderRow {
  id: string;
  name: string;
  naab: string | null;
  breed: string | null;
  proofRun: string | null;
  official: boolean;
  /** code -> value, for every queried trait plus the reference columns. */
  values: Record<string, number | null>;
}

export interface TraitFinderReport {
  conditions: Condition[];
  /** Reference columns always shown alongside the queried ones. */
  refCodes: string[];
  /** Distinct trait codes shown as columns (queried first, then refs). */
  columns: { code: string; name: string; baseline: number }[];
  rows: FinderRow[];
  scanned: number;
  matched: number;
  sort: string;
  dir: "asc" | "desc";
  breed: string;
  breeds: string[];
  blondin: string;
  includeInactive: boolean;
  q: string;
  catalog: QueryableTrait[];
}

const REF_CODES = ["LPI", "PRO$", "CONF"];

export async function getTraitFinderReport(sp: Record<string, string | undefined>): Promise<TraitFinderReport> {
  const defMap = await traitDefMap();
  const catalog = await queryableTraits();
  const nameOf = (code: string) => catalog.find((c) => c.code === code)?.name ?? defMap.get(code)?.name ?? code;

  const conditions = parseConditions(sp);
  const breed = (sp.breed ?? "").trim();
  const blondin = (sp.blondin ?? "").trim();
  const includeInactive = sp.inactive === "1";
  const q = (sp.q ?? "").trim();

  const where: Prisma.AnimalWhereInput = {
    archived: false,
    sex: "M",
    identifiers: { some: { active: true, idType: "naab" } },
    ...(includeInactive ? {} : { proofStatus: "active" }),
    ...(breed ? { breed: { breedName: breed } } : {}),
    ...(blondinWhere(blondin) ?? {}),
    ...(q
      ? { OR: [
          { primaryName: { contains: q, mode: "insensitive" } },
          { identifiers: { some: { idValue: { contains: q, mode: "insensitive" } } } },
        ] }
      : {}),
  };

  const bulls = await prisma.animal.findMany({
    where,
    select: {
      id: true, primaryName: true,
      breed: { select: { breedName: true } },
      identifiers: { where: { active: true, idType: "naab" }, take: 1, select: { idValue: true } },
      evaluations: { where: { isPreferred: true }, take: 1, select: { traitsJson: true, proofRun: true, runKind: true } },
    },
  });

  const queriedCodes = conditions.map((c) => c.code);
  const columnCodes = [...new Set([...queriedCodes, ...REF_CODES])];

  const rows: FinderRow[] = [];
  for (const b of bulls) {
    const ev = b.evaluations[0];
    if (!ev) continue;
    const vmap = new Map<string, number>();
    for (const t of unpackTraits(ev.traitsJson, defMap)) {
      if (t.numericValue != null) vmap.set(t.traitCode, t.numericValue);
    }
    // Must clear EVERY condition; a bull missing a queried trait cannot qualify.
    let ok = true;
    for (const c of conditions) {
      const v = vmap.get(c.code);
      if (v == null || !passes(v, c, traitBaseline(c.code))) { ok = false; break; }
    }
    if (!ok) continue;
    const values: Record<string, number | null> = {};
    for (const code of columnCodes) values[code] = vmap.get(code) ?? null;
    rows.push({
      id: b.id, name: b.primaryName, naab: b.identifiers[0]?.idValue ?? null,
      breed: b.breed?.breedName ?? null, proofRun: ev.proofRun, official: ev.runKind === "official",
      values,
    });
  }

  // Sort: by a queried/ref trait if asked, else the first condition's trait, else LPI.
  const sortCode = (sp.sort ?? "").trim().toUpperCase();
  const sort = columnCodes.includes(sortCode) ? sortCode : (queriedCodes[0] ?? "LPI");
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  rows.sort((a, b) => {
    const av = a.values[sort], bv = b.values[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last regardless of direction
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });

  const breeds = (await prisma.breed.findMany({ select: { breedName: true }, orderBy: { breedName: "asc" } })).map((b) => b.breedName);

  return {
    conditions, refCodes: REF_CODES,
    columns: columnCodes.map((code) => ({ code, name: nameOf(code), baseline: traitBaseline(code) })),
    rows, scanned: bulls.length, matched: rows.length,
    sort, dir, breed, breeds, blondin, includeInactive, q, catalog,
  };
}
