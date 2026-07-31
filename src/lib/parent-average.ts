import "server-only";

// ---------------------------------------------------------------------------
// Parent-Average engine — shared by the /parent-average page (dam × sire and
// dam × up-to-5-sires) and available to the agent's calculate_mating_pa.
//
// A parent is resolved from the internal database first, and only if it isn't
// there, looked up live from Lactanet. A live lookup is SESSION-ONLY: it is
// never written to the database unless the caller explicitly imports it (the
// UI's per-animal "save" checkbox).
//
// PA of a trait = the simple mean of the two parents' values, computed ONLY for
// traits BOTH parents have. Nothing is guessed or defaulted to zero.
// ---------------------------------------------------------------------------

import { prisma } from "./db";
import { unpackTraits, traitDefMap } from "./eval-traits";
import { fetchLactanetAnimal, parseReg } from "./lactanet-web";
import { parseLactanetAnimal } from "./lactanet-parse";
import { parseHolsteinProfileJson } from "./holstein-parse";

export interface PATrait {
  value: number | null;
  text: string | null;
  name: string;
  category: string | null;
  reliability: number | null;
}

export interface PAAncestor {
  generation: number; // within THIS parent's own pedigree (1 = its parents)
  side: "sire" | "dam";
  reg: string | null;
  name: string | null;
}

export interface PAParent {
  found: boolean;
  reg: string;
  name: string | null;
  sex: "M" | "F" | null;
  source: "internal" | "lactanet" | null;
  inDatabase: boolean; // already a non-archived DB animal
  animalId: string | null;
  reliabilityOverall: number | null;
  basis: string | null; // proven | genomic | GEBV | GPA | PA …
  proofRun: string | null;
  traits: Map<string, PATrait>;
  ancestors: PAAncestor[]; // this parent's own family tree (their sire/dam/grandparents)
  error?: string;
}

/** Lightweight, serialisable view of a parent for the client. */
export interface PAParentMeta {
  found: boolean;
  reg: string;
  name: string | null;
  sex: "M" | "F" | null;
  source: "internal" | "lactanet" | null;
  inDatabase: boolean;
  reliabilityOverall: number | null;
  basis: string | null;
  proofRun: string | null;
  traitCount: number;
  error?: string;
}

export function parentMeta(p: PAParent): PAParentMeta {
  return {
    found: p.found, reg: p.reg, name: p.name, sex: p.sex, source: p.source,
    inDatabase: p.inDatabase, reliabilityOverall: p.reliabilityOverall,
    basis: p.basis, proofRun: p.proofRun, traitCount: p.traits.size, error: p.error,
  };
}

/**
 * Resolve one animal by registration number for a PA: internal database first
 * (with its preferred proof unpacked), else a live Lactanet lookup.
 */
export async function resolveParentForPA(regRaw: string): Promise<PAParent> {
  const ref = parseReg(regRaw);
  const R = ref?.reg ?? regRaw.trim().toUpperCase();
  const empty = (error?: string): PAParent => ({
    found: false, reg: R, name: null, sex: ref?.sex ?? null, source: null,
    inDatabase: false, animalId: null, reliabilityOverall: null, basis: null,
    proofRun: null, traits: new Map(), ancestors: [], error,
  });
  if (!ref) return empty(`"${regRaw}" is not a registration number (expected e.g. HOCANM13486161).`);

  // --- 1) internal database ---
  const db = await prisma.animal.findFirst({
    where: { archived: false, identifiers: { some: { idValue: R, active: true } } },
    select: {
      id: true, primaryName: true, sex: true, holsteinProfileJson: true,
      evaluations: {
        orderBy: [{ isPreferred: "desc" }, { evaluationDate: "desc" }],
        take: 1,
        select: { traitsJson: true, reliabilityOverall: true, proofRun: true, sireType: true },
      },
    },
  });
  if (db) {
    const defMap = await traitDefMap();
    const ev = db.evaluations[0] ?? null;
    const traits = new Map<string, PATrait>();
    if (ev) {
      for (const t of unpackTraits(ev.traitsJson, defMap)) {
        traits.set(t.traitCode, { value: t.numericValue, text: t.textValue, name: t.traitName, category: t.traitCategory, reliability: t.reliability });
      }
    }
    const prof = parseHolsteinProfileJson(db.holsteinProfileJson);
    const ancestors: PAAncestor[] = (prof?.familyTree ?? []).map((n) => ({ generation: n.generation, side: n.side, reg: n.reg, name: n.name }));
    return {
      found: true, reg: R, name: db.primaryName, sex: (db.sex as "M" | "F") ?? ref.sex,
      source: "internal", inDatabase: true, animalId: db.id,
      reliabilityOverall: ev?.reliabilityOverall ?? null, basis: ev?.sireType ?? null,
      proofRun: ev?.proofRun ?? null, traits, ancestors,
    };
  }

  // --- 2) live Lactanet ---
  const fetched = await fetchLactanetAnimal(R);
  if (fetched.error) return empty(fetched.error);
  const parsed = parseLactanetAnimal(R, ref.sex, fetched.tabs, fetched.fetchedAt);
  const traits = new Map<string, PATrait>();
  for (const t of parsed.evaluation.traits) {
    traits.set(t.code, { value: t.numericValue, text: t.textValue, name: t.code, category: null, reliability: t.reliability });
  }
  const ancestors: PAAncestor[] = parsed.profile.familyTree.map((n) => ({ generation: n.generation, side: n.side, reg: n.reg, name: n.name }));
  return {
    found: true, reg: R, name: parsed.identity.name, sex: ref.sex, source: "lactanet",
    inDatabase: false, animalId: null, reliabilityOverall: parsed.evaluation.reliability,
    basis: parsed.evaluation.basis, proofRun: parsed.evaluation.runLabel, traits, ancestors,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PARow { code: string; name: string; category: string | null; sire: number; dam: number; pa: number; }
export interface PADescriptive { code: string; name: string; sire: string; dam: string; }
export interface PAUnavailable { code: string; name: string; availableFor: "sire only" | "dam only" | "neither" }

export interface PASharedAncestor {
  reg: string;
  name: string | null;
  sirePath: string; // e.g. "sire's dam" / "sire" — offspring-relative description
  damPath: string;
  sireGen: number; // offspring-relative generation on the sire side (1=parent)
  damGen: number;
}

/** Ancestors shared between the two parents' pedigrees → inbreeding in the calf.
 *  Compares each parent's own family tree (their gen 1-3, i.e. the calf's gen
 *  2-4) plus the parent itself, and reports anything appearing on both sides. */
export function sharedAncestors(sire: PAParent, dam: PAParent, maxGen = 3): PASharedAncestor[] {
  // Map reg → shallowest offspring-generation it appears at, per side.
  const side = (parent: PAParent): Map<string, { gen: number; name: string | null }> => {
    const m = new Map<string, { gen: number; name: string | null }>();
    // The parent itself is the calf's generation 1.
    if (parent.reg) m.set(parent.reg.toUpperCase(), { gen: 1, name: parent.name });
    for (const a of parent.ancestors) {
      if (!a.reg) continue;
      const gen = a.generation + 1; // parent's gen-1 ancestor = calf's gen-2
      if (gen > maxGen) continue;
      const key = a.reg.toUpperCase();
      const prev = m.get(key);
      if (!prev || gen < prev.gen) m.set(key, { gen, name: a.name });
    }
    return m;
  };
  const s = side(sire), d = side(dam);
  const out: PASharedAncestor[] = [];
  for (const [reg, sInfo] of s) {
    const dInfo = d.get(reg);
    if (!dInfo) continue;
    out.push({
      reg, name: sInfo.name ?? dInfo.name,
      sireGen: sInfo.gen, damGen: dInfo.gen,
      sirePath: genLabel(sInfo.gen, "sire"), damPath: genLabel(dInfo.gen, "dam"),
    });
  }
  return out.sort((a, b) => a.sireGen + a.damGen - (b.sireGen + b.damGen));
}

function genLabel(gen: number, root: "sire" | "dam"): string {
  if (gen === 1) return root;
  if (gen === 2) return `${root}'s parent`;
  if (gen === 3) return `${root}'s grandparent`;
  return `${root} gen ${gen}`;
}

export interface PAResult {
  ok: boolean;
  reason?: string;
  sire: PAParentMeta;
  dam: PAParentMeta;
  pa: PARow[];
  descriptive: PADescriptive[];
  unavailable: PAUnavailable[];
  shared: PASharedAncestor[];
  notes: string[];
}

/** Compute the parent average of a sire × dam, plus shared-ancestor / caveat notes. */
export function computeParentAverage(sire: PAParent, dam: PAParent): PAResult {
  const base = { sire: parentMeta(sire), dam: parentMeta(dam), pa: [], descriptive: [], unavailable: [], shared: [], notes: [] };
  if (!sire.found || !dam.found) {
    const missing = [!sire.found ? sire : null, !dam.found ? dam : null].filter(Boolean) as PAParent[];
    return { ...base, ok: false, reason: missing.map((p) => p.error ?? `${p.reg} not found`).join("; ") };
  }
  const noData = [sire, dam].filter((p) => p.traits.size === 0);
  if (noData.length) {
    return { ...base, ok: false, reason: `${noData.map((p) => `${p.name ?? p.reg} has no genetic trait data`).join("; ")}.` };
  }

  const pa: PARow[] = [];
  const descriptive: PADescriptive[] = [];
  const unavailable: PAUnavailable[] = [];
  const codes = new Set<string>([...sire.traits.keys(), ...dam.traits.keys()]);
  for (const code of [...codes].sort()) {
    const s = sire.traits.get(code), d = dam.traits.get(code);
    const name = s?.name ?? d?.name ?? code;
    if (s && d && s.value != null && d.value != null) {
      pa.push({ code, name, category: s.category ?? d.category ?? null, sire: s.value, dam: d.value, pa: round2((s.value + d.value) / 2) });
    } else if (s?.text != null && d?.text != null) {
      descriptive.push({ code, name, sire: s.text, dam: d.text });
    } else {
      const has = (x?: PATrait) => !!x && (x.value != null || x.text != null);
      unavailable.push({ code, name, availableFor: has(s) ? "sire only" : has(d) ? "dam only" : "neither" });
    }
  }

  const notes: string[] = [];
  if (sire.source === "lactanet" || dam.source === "lactanet") notes.push("One or both parents were looked up live from Lactanet and are not yet saved — tick the box to keep them.");
  for (const p of [sire, dam]) if (p.reliabilityOverall != null && p.reliabilityOverall < 0.7) notes.push(`${p.name} has low overall reliability (${Math.round(p.reliabilityOverall * 100)}%) — treat the projection as indicative.`);
  for (const p of [sire, dam]) if (p.basis && /genomic|pa|gpa/i.test(p.basis)) notes.push(`${p.name} is on a genomic/parent-average basis.`);
  if (sire.sex === "F") notes.push(`The animal entered as the sire (${sire.name}) is recorded as female.`);
  if (dam.sex === "M") notes.push(`The animal entered as the dam (${dam.name}) is recorded as male.`);

  const shared = sharedAncestors(sire, dam);
  if (shared.length) notes.push(`${shared.length} shared ancestor${shared.length === 1 ? "" : "s"} within 3 generations — the mating carries some inbreeding.`);

  return { ok: true, sire: parentMeta(sire), dam: parentMeta(dam), pa, descriptive, unavailable, shared, notes };
}
