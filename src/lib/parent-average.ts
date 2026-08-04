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
import { parsePedigreeNotes, type Relation } from "./pedigree";
import {
  ancestorSetFromPAParent, assessRelatedness, buildCorpus, darkBranchNote, normalizeReg,
  NON_IDENTITY_ID_TYPES,
  type PedigreeCorpus, type Tier,
} from "./relatedness";

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

// --- the pedigree fallback ---------------------------------------------------
// PedigreeReference.notes is one free-text line holding the sire plus the
// maternal line back three generations. Map each relation onto the same
// generation/side grid the scraped family tree uses:
//
//   sire  -> gen 1, sire side          dam   -> gen 1, dam side
//   mgs   -> gen 2, dam side (dam's sire)    mgd  -> gen 2, dam side
//   gmgs  -> gen 3, dam side (MGD's sire)    gmgd -> gen 3, dam side
//
// The sire's OWN parents are not on this line — reaching them needs the sire's
// own PedigreeReference row, which the PA path deliberately does not query.
const REL_SLOT: Record<Relation, { generation: number; side: "sire" | "dam" }> = {
  sire: { generation: 1, side: "sire" },
  dam: { generation: 1, side: "dam" },
  mgs: { generation: 2, side: "dam" },
  mgd: { generation: 2, side: "dam" },
  gmgs: { generation: 3, side: "dam" },
  gmgd: { generation: 3, side: "dam" },
};

/** Map one stored pedigree line into the PA family-tree shape. */
export function ancestorsFromPedigreeNotes(notes: string | null | undefined): PAAncestor[] {
  return parsePedigreeNotes(notes)
    .filter((a) => a.reg || a.name)
    .map((a) => ({ ...REL_SLOT[a.relation], reg: a.reg, name: a.name }));
}

/** An animal can hold several pedigree rows (different sources). Take the line
 *  that names the most ancestors WITH a registration number — the only ones that
 *  can do any work in the relatedness check. */
function ancestorsFromPedigreeRefs(refs: { notes: string | null }[] | undefined): PAAncestor[] {
  let best: PAAncestor[] = [];
  let bestScore = 0;
  for (const r of refs ?? []) {
    const anc = ancestorsFromPedigreeNotes(r.notes);
    const score = anc.filter((a) => normalizeReg(a.reg)).length;
    if (score > bestScore) { bestScore = score; best = anc; }
  }
  return best;
}

/**
 * Resolve one animal by registration number for a PA: internal database first
 * (with its preferred proof unpacked), else a live Lactanet lookup.
 */
export async function resolveParentForPA(input: string): Promise<PAParent> {
  const raw = (input ?? "").trim();
  const ref = parseReg(raw);
  const R = ref?.reg ?? raw.toUpperCase();
  const empty = (error?: string): PAParent => ({
    found: false, reg: R, name: null, sex: ref?.sex ?? null, source: null,
    inDatabase: false, animalId: null, reliabilityOverall: null, basis: null,
    proofRun: null, traits: new Map(), ancestors: [], error,
  });
  if (!raw) return empty("Enter an animal name or registration number.");

  // --- 1) internal database: by registration number if it looks like one,
  //        otherwise by name (exact, then a starts-with/contains fallback) ---
  const SELECT = {
    id: true, primaryName: true, sex: true, holsteinProfileJson: true,
    // The pedigree fallback for the family tree. holsteinProfileJson is only set
    // for the handful of animals captured by the Holstein.ca scraper; every
    // bulk-imported bull carries its pedigree here instead.
    pedigreeRefs: { select: { notes: true } },
    identifiers: { where: { active: true }, orderBy: [{ isPrimary: "desc" as const }], take: 1, select: { idValue: true } },
    evaluations: {
      orderBy: [{ isPreferred: "desc" as const }, { evaluationDate: "desc" as const }],
      take: 1,
      select: { traitsJson: true, reliabilityOverall: true, proofRun: true, sireType: true },
    },
  };
  let db = await prisma.animal.findFirst({
    where: ref
      ? { archived: false, identifiers: { some: { idValue: R, active: true } } }
      : { archived: false, primaryName: { equals: raw, mode: "insensitive" } },
    select: SELECT,
  });
  if (!db && !ref) {
    // name search: fall back to a partial (contains) match, best-name-first.
    db = await prisma.animal.findFirst({
      where: { archived: false, primaryName: { contains: raw, mode: "insensitive" } },
      orderBy: { primaryName: "asc" },
      select: SELECT,
    });
  }
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
    const fromProfile: PAAncestor[] = (prof?.familyTree ?? []).map((n) => ({ generation: n.generation, side: n.side, reg: n.reg, name: n.name }));
    // Fall back to the stored pedigree line whenever the scraped profile yields
    // no ancestor that carries a registration number: an ancestor without a reg
    // can never take part in the relatedness predicate, so a name-only profile
    // is worth exactly as much as an empty one.
    const ancestors: PAAncestor[] = fromProfile.some((a) => normalizeReg(a.reg))
      ? fromProfile
      : ancestorsFromPedigreeRefs(db.pedigreeRefs);
    return {
      found: true, reg: db.identifiers[0]?.idValue ?? R, name: db.primaryName, sex: (db.sex as "M" | "F") ?? ref?.sex ?? null,
      source: "internal", inDatabase: true, animalId: db.id,
      reliabilityOverall: ev?.reliabilityOverall ?? null, basis: ev?.sireType ?? null,
      proofRun: ev?.proofRun ?? null, traits, ancestors,
    };
  }

  // --- 2) live Lactanet — by registration number only (name search would be
  //        ambiguous). A name not in the database can't go further. ---
  if (!ref) return empty(`No animal named "${raw}" in the database. Enter its registration number to look it up on Lactanet.`);
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
  /** Depth the screen ran at, counted in each PARENT's own generations (2 or 3).
   *  The gens above are calf-relative, so they run one deeper than this. */
  depth: 2 | 3;
  /** The engine's own phrasing, e.g. "her MGS × his sire". */
  label: string;
}

/** How complete BOTH pedigrees must be before "no shared ancestor" is allowed to
 *  mean anything. Sits between 0.583 (own notes only, sire unresolved) and 0.833
 *  (own notes plus a resolvable sire) — the same floor the mating report uses. */
export const PA_CONFIDENCE_FLOOR = 0.75;

/** The verdict on one pairing: not just what was found, but whether we knew
 *  enough to be entitled to say "nothing found". */
export interface PARelatedness {
  tier: Tier;
  /** Depth in each parent's own generations. */
  depth: 2 | 3;
  /** min(pedigree completeness) of the two sides — never a product, never a mean. */
  confidence: number;
  sireSlots: number;
  damSlots: number;
  shared: PASharedAncestor[];
  /** Plain-English verdict, safe to show as-is. */
  note: string;
}

const EMPTY_CORPUS: PedigreeCorpus = {
  notesByAnimalId: new Map(), regToAnimalId: new Map(), regsByAnimalId: new Map(),
  aliasRegsByAnimalId: new Map(), ambiguousKeys: new Set(),
};

/**
 * The alias half of the pedigree corpus: one small query over the identifier
 * table. The PA path maps an ALREADY-RESOLVED family tree and never recurses,
 * so it needs no pedigree notes — only the ability to recognise that one animal
 * is held under several registrations.
 *
 * AMBIGUOUS IDENTIFIERS ARE NEVER EXPANDED. AnimalIdentifier holds more than
 * registrations: production carries an active idType="marketing_code" of "0799"
 * on ~160 different bulls. An identifier shared by 160 animals identifies none
 * of them, and expanding it would make every one of those bulls look like the
 * same animal — turning the whole stud into one "excluded" blob of false
 * positives. buildCorpus applies that hygiene itself now (and this query drops
 * the product/barn-label identifier types outright), so this loader and
 * loadPedigreeCorpus in relatedness.ts cannot drift apart again.
 */
export async function loadPAAliasCorpus(): Promise<PedigreeCorpus> {
  const idRows = await prisma.animalIdentifier.findMany({
    where: { active: true, idType: { notIn: NON_IDENTITY_ID_TYPES } },
    select: { animalId: true, idValue: true },
  });
  return buildCorpus(idRows, []);
}

/**
 * Relatedness of a sire × dam, delegated in full to the shared engine in
 * relatedness.ts so this page and the mating report cannot drift apart. In
 * particular the engine unions each side's OWN identifiers into the comparison,
 * which is what catches "the bull IS her sire" — a bull's own registration never
 * appears inside his own ancestor set, so an ancestors-only comparison (what
 * this file used to do) silently reported a father × daughter mating as clean.
 *
 * Passing a `corpus` enables identifier alias expansion, so the same animal
 * written down under a Canadian registration on one side and a NAAB code on the
 * other still collides. Without one the comparison still works, on exact
 * normalised registrations only.
 */
export function assessPAPair(
  sire: PAParent,
  dam: PAParent,
  maxGen: 2 | 3 = 3,
  corpus: PedigreeCorpus = EMPTY_CORPUS,
): PARelatedness {
  const bullSet = ancestorSetFromPAParent(sire, corpus, maxGen);
  const cowSet = ancestorSetFromPAParent(dam, corpus, maxGen);
  const v = assessRelatedness(cowSet, bullSet, { maxGen, floor: PA_CONFIDENCE_FLOOR });

  const shared: PASharedAncestor[] = v.shared.map((s) => {
    // The engine counts generations from the animal itself (0 = the animal,
    // 1 = its parent). This page has always numbered them from the CALF, where
    // the parent is generation 1 — so add one on each side.
    const sireGen = s.bullGen + 1, damGen = s.cowGen + 1;
    return {
      reg: s.reg, name: s.name, sireGen, damGen,
      sirePath: genLabel(sireGen, "sire"), damPath: genLabel(damGen, "dam"),
      depth: maxGen, label: s.label,
    };
  });

  const pct = `${Math.round(v.confidence * 100)}%`;
  // The confidence is the blinder half's; name that half when explaining a
  // verdict we are not entitled to trust.
  const damIsBlinder = cowSet.pedComplete <= bullSet.pedComplete;
  const blind = damIsBlinder ? dam : sire;
  const blindSet = damIsBlinder ? cowSet : bullSet;
  let note: string;
  switch (v.tier) {
    case "excluded": {
      // A direct hit (one parent IS an ancestor of the other) is not "some
      // inbreeding" — it is a mating that must not happen. Say so first.
      const direct = v.shared.find((s) => s.cowGen === 0 || s.bullGen === 0);
      note = direct
        ? `DIRECT RELATIVES — ${direct.label}${shared.length > 1 ? `, plus ${shared.length - 1} more shared ancestor${shared.length === 2 ? "" : "s"}` : ""}. Do not breed this pairing.`
        : `${shared.length} shared ancestor${shared.length === 1 ? "" : "s"} within ${maxGen} generations of each parent — the mating carries some inbreeding.`;
      break;
    }
    case "clear":
      note = `No common ancestor within ${maxGen} generations of either parent, on pedigrees complete enough to say so (${pct} pedigree completeness).`;
      break;
    case "unknown":
      note = `Not enough pedigree to certify an outcross (${pct} complete, ${Math.round(PA_CONFIDENCE_FLOOR * 100)}% needed): ${darkBranchNote(blindSet) ?? "part of the tree is unrecorded"}. No shared ancestor was found, but this is NOT a clean bill of health.`;
      break;
    default:
      note = `${blind.name ?? blind.reg} has no usable pedigree on file — the pairing could not be screened for shared ancestors at all.`;
  }

  return {
    tier: v.tier, depth: maxGen, confidence: v.confidence,
    sireSlots: v.bullSlots, damSlots: v.cowSlots, shared, note,
  };
}

/** Ancestors shared between the two parents' pedigrees → inbreeding in the calf.
 *  Thin wrapper over assessPAPair, kept for existing callers. Prefer
 *  assessPAPair: an EMPTY result here does not mean "outcross", it can also mean
 *  "we could not see far enough to tell" — read `tier` to know which. */
export function sharedAncestors(
  sire: PAParent,
  dam: PAParent,
  maxGen: 2 | 3 = 3,
  corpus: PedigreeCorpus = EMPTY_CORPUS,
): PASharedAncestor[] {
  return assessPAPair(sire, dam, maxGen, corpus).shared;
}

function genLabel(gen: number, root: "sire" | "dam"): string {
  if (gen === 1) return root;
  if (gen === 2) return `${root}'s parent`;
  if (gen === 3) return `${root}'s grandparent`;
  if (gen === 4) return `${root}'s great-grandparent`;
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
  /** The full relatedness verdict. Absent only when the PA itself failed.
   *  `shared: []` alone must NEVER be read as "outcross" — check `tier`. */
  relatedness?: PARelatedness;
  notes: string[];
}

/** Compute the parent average of a sire × dam, plus shared-ancestor / caveat notes.
 *  Pass a `corpus` (see loadPedigreeCorpus in relatedness.ts) to enable
 *  identifier alias expansion in the relatedness screen. */
export function computeParentAverage(
  sire: PAParent,
  dam: PAParent,
  corpus?: PedigreeCorpus,
): PAResult {
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

  // One definition of "related", shared with the mating report. The note is
  // pushed for every tier except a genuinely certified outcross — "nothing
  // found" and "we could not look" must never read the same.
  const relatedness = assessPAPair(sire, dam, 3, corpus);
  if (relatedness.tier !== "clear") notes.push(relatedness.note);

  return { ok: true, sire: parentMeta(sire), dam: parentMeta(dam), pa, descriptive, unavailable, shared: relatedness.shared, relatedness, notes };
}
