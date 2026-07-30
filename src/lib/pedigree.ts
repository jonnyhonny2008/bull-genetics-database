// ---------------------------------------------------------------------------
// Pedigree parsing, ancestor resolution, and the Pedigree Index.
//
// The importer stores each bull's pedigree as a single free-text line on
// PedigreeReference.notes, in a fixed shape:
//
//   "Pedigree (from proof): SIRE: NAME (REG) · DAM: NAME (REG) · MGS: … · MGD: …
//    · GMGS: … · GMGD: …"
//
// That is the maternal line back three generations plus the sire:
//   sire  — the bull's sire
//   dam   — the bull's dam
//   mgs   — maternal grandsire  (dam's sire)
//   mgd   — maternal granddam   (dam's dam)
//   gmgs  — great-maternal grandsire (mgd's sire)
//   gmgd  — great-maternal granddam  (mgd's dam)
//
// --- The Pedigree Index -----------------------------------------------------
//
// A Pedigree Index (a.k.a. Parent Average) estimates a bull's genetic merit from
// his ancestors before he has daughters of his own. The textbook parent average
// is  ½·sire + ½·dam.  We hold a bull database, so we never have the dam's own
// evaluation — but her genetic contribution is carried by HER sire (the MGS).
// Expanding the parent average down the maternal line and substituting each
// unknown female by her sire gives the classic male-line weights:
//
//     PI  ≈  ½·Sire  +  ¼·MGS  +  ⅛·GMGS   (+ deeper female terms we can't hold)
//
// So the only ancestors whose evaluations we can ever look up are the sire, the
// maternal grandsire and the great-maternal grandsire. We compute a weighted
// average over whichever of those three we actually hold, RENORMALISED over the
// weights found, and report a confidence = (weight found) / (0.875 obtainable).
// Female ancestors are shown in the tree but never enter the index — their merit
// is already represented by their sires.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";

export type Relation = "sire" | "dam" | "mgs" | "mgd" | "gmgs" | "gmgd";

export const RELATIONS: { code: Relation; label: string; short: string }[] = [
  { code: "sire", label: "Sire", short: "S" },
  { code: "dam", label: "Dam", short: "D" },
  { code: "mgs", label: "Maternal grandsire", short: "MGS" },
  { code: "mgd", label: "Maternal granddam", short: "MGD" },
  { code: "gmgs", label: "Great-maternal grandsire", short: "GMGS" },
  { code: "gmgd", label: "Great-maternal granddam", short: "GMGD" },
];

/** Male-line ancestors that carry the index, and their genome weights. */
export const INDEX_WEIGHTS: Record<string, number> = { sire: 1 / 2, mgs: 1 / 4, gmgs: 1 / 8 };
/** Total weight ever obtainable from a bull database (½ + ¼ + ⅛). */
export const OBTAINABLE_WEIGHT = INDEX_WEIGHTS.sire + INDEX_WEIGHTS.mgs + INDEX_WEIGHTS.gmgs;

/** Traits the index is computed for; the indexed columns on GeneticEvaluation. */
export const PI_TRAITS: { code: string; label: string }[] = [
  { code: "lpi", label: "LPI" },
  { code: "proDollar", label: "Pro$" },
  { code: "conf", label: "Conformation" },
  { code: "milk", label: "Milk" },
  { code: "fat", label: "Fat" },
  { code: "prot", label: "Protein" },
  { code: "mamm", label: "Mammary" },
  { code: "fl", label: "Feet & Legs" },
  { code: "ds", label: "Dairy Strength" },
];

export interface ParsedAncestor {
  relation: Relation;
  name: string | null;
  reg: string | null;
}

// One relation, its name, and an optional (REG), up to the next "·" or the end.
// Name excludes parens and the separator; reg is whatever sits inside the parens.
const PED_RE = /\b(SIRE|DAM|MGS|MGD|GMGS|GMGD):\s*([^()·]*?)\s*(?:\(([^)]*)\))?\s*(?=·|$)/g;

/** Parse a stored pedigree `notes` line into up to six structured ancestors. */
export function parsePedigreeNotes(notes: string | null | undefined): ParsedAncestor[] {
  if (!notes) return [];
  const found = new Map<Relation, ParsedAncestor>();
  let m: RegExpExecArray | null;
  PED_RE.lastIndex = 0;
  while ((m = PED_RE.exec(notes))) {
    const relation = m[1].toLowerCase() as Relation;
    const name = (m[2] ?? "").trim();
    const reg = (m[3] ?? "").trim();
    // "?" is the importer's placeholder for a missing name.
    found.set(relation, {
      relation,
      name: name && name !== "?" ? name : null,
      reg: reg || null,
    });
  }
  // Return in canonical order, only relations actually present.
  return RELATIONS.map((r) => found.get(r.code)).filter((a): a is ParsedAncestor => !!a);
}

export type AncestorEval = Partial<Record<string, number | null>>;

/** A parsed ancestor plus whatever we resolved about it from our own database. */
export interface ResolvedAncestor extends ParsedAncestor {
  animalId: string | null;      // set when the reg matches an Animal we hold
  sireType: string | null;      // proven | genomic
  proofStatus: string | null;   // active | inactive
  evalValues: AncestorEval | null; // preferred-eval trait columns, when held
}

export interface PedigreeIndexTrait {
  code: string;
  label: string;
  value: number | null;
  /** Sum of the weights of ancestors that contributed a value for this trait. */
  weight: number;
}

export interface PedigreeIndex {
  traits: PedigreeIndexTrait[];
  /** Headline LPI pedigree index, or null when no male-line ancestor resolved. */
  lpi: number | null;
  /** 0–1: fraction of the ½+¼+⅛ obtainable male-line weight we resolved. */
  confidence: number;
  /** Which male-line ancestors contributed, with their weights. */
  contributors: { relation: Relation; name: string | null; weight: number }[];
}

/**
 * Weighted-average pedigree index over the resolved male-line ancestors
 * (sire ½, MGS ¼, GMGS ⅛), renormalised per trait over the ancestors that
 * actually carry that trait. Pure — takes already-resolved ancestors.
 */
export function computePedigreeIndex(resolved: ResolvedAncestor[]): PedigreeIndex {
  const male = resolved.filter((a) => INDEX_WEIGHTS[a.relation] != null && a.evalValues);

  const traits: PedigreeIndexTrait[] = PI_TRAITS.map(({ code, label }) => {
    let num = 0, wsum = 0;
    for (const a of male) {
      const v = a.evalValues?.[code];
      if (v == null) continue;
      const w = INDEX_WEIGHTS[a.relation];
      num += w * v;
      wsum += w;
    }
    return { code, label, value: wsum > 0 ? Math.round(num / wsum) : null, weight: wsum };
  });

  // Confidence is anchored on the headline (LPI): the weight of male-line
  // ancestors that gave us an LPI, over the 0.875 ever obtainable.
  const lpiTrait = traits.find((t) => t.code === "lpi");
  const confidence = lpiTrait && OBTAINABLE_WEIGHT > 0
    ? Math.min(1, lpiTrait.weight / OBTAINABLE_WEIGHT)
    : 0;

  const contributors = male
    .filter((a) => a.evalValues?.lpi != null)
    .map((a) => ({ relation: a.relation, name: a.name, weight: INDEX_WEIGHTS[a.relation] }))
    .sort((a, b) => b.weight - a.weight);

  return { traits, lpi: lpiTrait?.value ?? null, confidence, contributors };
}

// --- Resolution against our own database ------------------------------------
// Kept here (rather than in a page) so the profile and the bulk compute script
// resolve ancestors identically. The PrismaClient type is imported type-only, so
// this module still carries no runtime dependency on the db singleton — the tsx
// scripts pass their own client and the app passes the shared one.

/** The preferred-eval columns the pedigree index reads. Keys match PI_TRAITS. */
const PREF_EVAL_SELECT = {
  lpi: true, proDollar: true, conf: true, milk: true, fat: true, prot: true, mamm: true, fl: true, ds: true,
} as const;

/**
 * Resolve each parsed ancestor's registration number to an Animal we hold,
 * attaching its preferred-evaluation trait columns when present. Two batched
 * queries regardless of ancestor count.
 */
export async function resolveAncestors(
  client: PrismaClient,
  ancestors: ParsedAncestor[],
): Promise<ResolvedAncestor[]> {
  const regs = [...new Set(ancestors.map((a) => a.reg).filter((r): r is string => !!r))];
  if (regs.length === 0) {
    return ancestors.map((a) => ({ ...a, animalId: null, sireType: null, proofStatus: null, evalValues: null }));
  }

  const idRows = await client.animalIdentifier.findMany({
    where: { idValue: { in: regs }, animal: { archived: false } },
    select: { idValue: true, animalId: true },
  });
  const regToAnimalId = new Map(idRows.map((r) => [r.idValue, r.animalId]));
  const animalIds = [...new Set(idRows.map((r) => r.animalId))];

  const animals = animalIds.length
    ? await client.animal.findMany({
        where: { id: { in: animalIds } },
        select: {
          id: true,
          sireType: true,
          proofStatus: true,
          evaluations: { where: { isPreferred: true }, take: 1, select: PREF_EVAL_SELECT },
        },
      })
    : [];
  const byAnimalId = new Map(animals.map((a) => [a.id, a]));

  return ancestors.map((a) => {
    const animalId = a.reg ? regToAnimalId.get(a.reg) ?? null : null;
    const animal = animalId ? byAnimalId.get(animalId) : null;
    return {
      ...a,
      animalId: animalId ?? null,
      sireType: animal?.sireType ?? null,
      proofStatus: animal?.proofStatus ?? null,
      evalValues: (animal?.evaluations[0] ?? null) as AncestorEval | null,
    };
  });
}
