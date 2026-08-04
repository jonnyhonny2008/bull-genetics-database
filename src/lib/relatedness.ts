// ---------------------------------------------------------------------------
// Relatedness engine for the Mating Program report.
//
// Given a cow and a candidate bull, decide whether they share a registered
// ancestor inside D generations — and, just as importantly, decide whether we
// know enough about BOTH pedigrees to be allowed to say "no".
//
// Design rules this file implements literally:
//
//  * Comparison keys are normalised registration STRINGS, never animalIds.
//    Only a small minority of the ancestors named in our pedigree text are
//    Animal rows of their own, so an animalId-keyed comparison would be almost
//    blind. animalId is used for ONE thing: alias expansion. Whenever a reg
//    resolves to an animal we hold, every active identifier of that animal
//    joins the key set, so the same bull under a Canadian reg and under a NAAB
//    code still collides.
//
//  * NAMES ARE NEVER COMPARED. Holstein prefixes collide constantly
//    ("BLONDIN …" is a herd, not an animal). A name is carried for display only.
//
//  * The sire's own parents are NOT in the animal's own pedigree line. Reaching
//    them means looking up the SIRE's own PedigreeReference row, which is why
//    the walk recurses over a preloaded corpus instead of querying per animal.
//
//  * Completeness is generation-weighted (MacCluer) and an ancestor with a name
//    but no registration number counts as EMPTY — it cannot participate in the
//    predicate, so it must not inflate our confidence in a clean result.
//
//  * Pair confidence is the MINIMUM of the two sides, never a product and never
//    a mean. A shared ancestor is detectable only if BOTH sides recorded it, so
//    the screen is exactly as good as its blinder half.
//
// PURE: takes a PrismaClient as an argument (like pedigree.ts) and has no
// module-scope db import, so tsx scripts and unit tests can use it directly.
// It also deliberately does NOT import parent-average.ts at runtime — that
// module is "server-only" and would poison plain `tsx --test`.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import { parsePedigreeNotes, type Relation } from "./pedigree";
import type { PAParent } from "./parent-average";

// --- registration normalisation --------------------------------------------

/**
 * Canonical comparison form of a registration number.
 *
 * Uppercase, drop every non-alphanumeric character, then strip the leading
 * zeros of the FINAL numeric run only. The breed/country prefix is never
 * touched — "HOCANM" and "HOUSAM" are different registries and collapsing them
 * would invent relatives.
 */
export function normalizeReg(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return null;
  return s.replace(/(\d+)$/, (m) => String(BigInt(m)));
}

// --- the corpus -------------------------------------------------------------

export interface PedigreeCorpus {
  /** animalId -> the richest pedigree `notes` line we hold for it. */
  notesByAnimalId: Map<string, string>;
  /**
   * normalized reg -> animalId. UNAMBIGUOUS keys only: a key claimed by more
   * than one Animal row names none of them, and resolving it to whichever row
   * the query happened to return first would send the ancestor walk into a
   * stranger's pedigree.
   */
  regToAnimalId: Map<string, string>;
  /**
   * animalId -> EVERY normalized reg it claims, ambiguous ones included. This
   * is the animal's own identity (selfKeys), never an expansion source. An
   * ambiguous key must stay here: if a duplicate-imported sire lost his own
   * registration from this map, "this bull is her sire" would stop firing and
   * the report would rank a cow's own father first.
   */
  regsByAnimalId: Map<string, string[]>;
  /**
   * animalId -> its UNAMBIGUOUS normalized regs — the only keys alias expansion
   * is allowed to pour into an ancestor set. Expanding an ambiguous key would
   * put it in the ancestor set of one animal and in the selfKeys of every animal
   * that claims it (production carries an active marketing_code "0799" on ~160
   * bulls), turning the whole lineup into one blob of false exclusions.
   */
  aliasRegsByAnimalId: Map<string, string[]>;
  /** Normalized keys claimed by more than one animal. Reported, never expanded. */
  ambiguousKeys: Set<string>;
}

/**
 * Identifier types that name a PRODUCT or a farm-local label rather than an
 * animal: a semen marketing code, a barn ear tag, a tattoo. They are excluded
 * from the comparison corpus entirely — they normalise to short strings that
 * collide across unrelated animals, and no pedigree line ever names an ancestor
 * by one, so keeping them can only ever invent a relationship.
 */
export const NON_IDENTITY_ID_TYPES = ["marketing_code", "semen_code", "ear_tag", "tattoo", "rfid"];

/** Two queries, whole-corpus, independent of how many females were pasted. */
export async function loadPedigreeCorpus(client: PrismaClient): Promise<PedigreeCorpus> {
  const [idRows, pedRows] = await Promise.all([
    client.animalIdentifier.findMany({
      where: { active: true, idType: { notIn: NON_IDENTITY_ID_TYPES } },
      select: { animalId: true, idValue: true },
    }),
    client.pedigreeReference.findMany({ select: { animalId: true, notes: true } }),
  ]);
  return buildCorpus(idRows, pedRows);
}

/**
 * The pure half of loadPedigreeCorpus — exported so tests can build a corpus.
 *
 * `keepAmbiguous` exists for ONE caller: the read-only coverage audit, which
 * prints what the raw identifier table would do to the screen if the hygiene
 * below were absent. Never pass it from application code.
 */
export function buildCorpus(
  idRows: { animalId: string; idValue: string | null }[],
  pedRows: { animalId: string; notes: string | null }[],
  opts: { keepAmbiguous?: boolean } = {},
): PedigreeCorpus {
  // An identifier held by more than one Animal row identifies none of them.
  const owners = new Map<string, Set<string>>();
  for (const r of idRows) {
    const key = normalizeReg(r.idValue);
    if (!key) continue;
    let set = owners.get(key);
    if (!set) owners.set(key, (set = new Set<string>()));
    set.add(r.animalId);
  }
  const ambiguousKeys = new Set<string>();
  if (!opts.keepAmbiguous) {
    for (const [key, set] of owners) if (set.size > 1) ambiguousKeys.add(key);
  }

  const regToAnimalId = new Map<string, string>();
  const regsByAnimalId = new Map<string, string[]>();
  const aliasRegsByAnimalId = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, id: string, key: string) => {
    const list = m.get(id);
    if (!list) m.set(id, [key]);
    else if (!list.includes(key)) list.push(key);
  };
  for (const r of idRows) {
    const key = normalizeReg(r.idValue);
    if (!key) continue;
    push(regsByAnimalId, r.animalId, key); // identity — ambiguous keys kept
    if (ambiguousKeys.has(key)) continue; // …but never resolved and never expanded
    if (!regToAnimalId.has(key)) regToAnimalId.set(key, r.animalId);
    push(aliasRegsByAnimalId, r.animalId, key);
  }

  // An animal can carry more than one PedigreeReference row (different sources).
  // Keep the line that names the most ancestors WITH a registration number —
  // that is the one that can actually do work in the predicate.
  const notesByAnimalId = new Map<string, string>();
  const scoreByAnimalId = new Map<string, number>();
  for (const p of pedRows) {
    if (!p.notes) continue;
    const score = parsePedigreeNotes(p.notes).filter((a) => normalizeReg(a.reg)).length;
    if (score === 0) continue;
    if (score > (scoreByAnimalId.get(p.animalId) ?? 0)) {
      scoreByAnimalId.set(p.animalId, score);
      notesByAnimalId.set(p.animalId, p.notes);
    }
  }

  return { notesByAnimalId, regToAnimalId, regsByAnimalId, aliasRegsByAnimalId, ambiguousKeys };
}

// --- the ancestor set -------------------------------------------------------

/** One distinct ancestor entity we managed to place in the tree. */
export interface AncestorSlot {
  /** animalId when the reg resolved to an Animal row, else the normalized reg. */
  entity: string;
  /** Shallowest generation this ancestor was reached at (1 = a parent). */
  gen: number;
  /** Representative normalized reg for display. */
  reg: string;
  name: string | null;
  /** Human path from the subject, e.g. "MGS" or "sire's dam". */
  path: string;
}

export interface AncestorSet {
  /** normalized reg -> SHALLOWEST generation. Alias-expanded. */
  keys: Map<string, 1 | 2 | 3>;
  /** This animal's own normalized identifiers. */
  selfKeys: Set<string>;
  /** Distinct known ancestors carrying a reg, capped per generation: 0..14. */
  slots: number;
  n1: number;
  n2: number;
  n3: number;
  pedComplete: number;
  // --- carried for display and for the predicate's bookkeeping --------------
  /** The depth this set was built to; completeness is normalised over it. */
  maxGen: 2 | 3;
  /** normalized reg -> entity id, so aliases of one ancestor dedupe to one hit. */
  entityByKey: Map<string, string>;
  /** entity id -> its slot (generation, display reg, name, relation path). */
  entities: Map<string, AncestorSlot>;
  /** Identity of the subject itself, for self-vs-ancestor hits. */
  selfEntity: string | null;
  selfName: string | null;
  /** Ancestors named in the pedigree with NO reg — cannot be screened. */
  nameOnly: number;
}

/** Depth of each stored relation below its host animal. */
const REL_DEPTH: Record<Relation, 1 | 2 | 3> = {
  sire: 1, dam: 1, mgs: 2, mgd: 2, gmgs: 3, gmgd: 3,
};
const REL_PATH: Record<Relation, string> = {
  sire: "sire", dam: "dam", mgs: "MGS", mgd: "MGD", gmgs: "GMGS", gmgd: "GMGD",
};

interface Builder {
  best: Map<string, AncestorSlot>;
  nameOnly: Set<string>;
}

function record(b: Builder, slot: AncestorSlot): boolean {
  const prev = b.best.get(slot.entity);
  if (prev && prev.gen <= slot.gen) return false;
  b.best.set(slot.entity, slot);
  return true; // new, or newly shallower — worth (re-)expanding
}

/**
 * Build the ancestor set of an animal we hold, walking its own pedigree line and
 * then RECURSING into any ancestor that is itself an Animal row. That recursion
 * is the only way to reach the paternal grandparents: the sire's own parents are
 * not written on the subject's pedigree line.
 *
 * Runs as an in-memory fixpoint over the preloaded corpus — no queries.
 */
export function buildAncestorSet(
  animalId: string,
  corpus: PedigreeCorpus,
  maxGen: 2 | 3 = 3,
): AncestorSet {
  const b: Builder = { best: new Map(), nameOnly: new Set() };
  const selfKeys = new Set(corpus.regsByAnimalId.get(animalId) ?? []);

  // Worklist of hosts to read pedigree lines from: [animalId, generation, path].
  const work: { host: string; gen: number; path: string }[] = [{ host: animalId, gen: 0, path: "" }];
  let guard = 0;
  while (work.length) {
    if (++guard > 500) break; // cyclic/corrupt data must not hang a report
    const { host, gen: baseGen, path: basePath } = work.shift()!;
    const notes = corpus.notesByAnimalId.get(host);
    if (!notes) continue;

    for (const a of parsePedigreeNotes(notes)) {
      const gen = baseGen + REL_DEPTH[a.relation];
      if (gen > maxGen) continue;
      const path = basePath ? `${basePath}'s ${REL_PATH[a.relation]}` : REL_PATH[a.relation];
      const reg = normalizeReg(a.reg);
      if (!reg) {
        // A name with no registration number. It cannot participate in the
        // predicate, so it counts as an EMPTY slot — noted, never scored.
        if (a.name) b.nameOnly.add(`${path}:${a.name}`);
        continue;
      }
      const resolved = corpus.regToAnimalId.get(reg) ?? null;
      if (resolved === animalId) continue; // the subject cannot be its own ancestor
      const entity = resolved ?? reg;
      const improved = record(b, { entity, gen, reg, name: a.name, path });
      if (improved && resolved && gen < maxGen) work.push({ host: resolved, gen, path });
    }
  }

  return finishSet(b, selfKeys, animalId, null, corpus, maxGen);
}

/**
 * The shape of a resolved parent that this module needs. A real `PAParent` from
 * parent-average.ts satisfies it structurally; declaring it here keeps the
 * "server-only" import out of the runtime graph.
 */
export interface PAParentLike {
  reg: string;
  name?: string | null;
  animalId?: string | null;
  ancestors: { generation: number; side: "sire" | "dam"; reg: string | null; name: string | null }[];
}

// Compile-time proof that the real PAParent still fits (type-only, erased).
type _PAParentFits = PAParent extends PAParentLike ? true : never;

const SIDE_PATH = (side: "sire" | "dam", gen: number): string =>
  gen === 1 ? side : gen === 2 ? `${side}'s parent` : gen === 3 ? `${side}'s grandparent` : `${side} gen ${gen}`;

/**
 * Map an already-resolved parent (internal or live Lactanet) into an
 * AncestorSet. Its `ancestors` array is ALREADY a generation+side tree of up to
 * 14 slots, so this does NOT recurse — recursion would double-count and would
 * need queries the PA path deliberately avoids.
 */
export function ancestorSetFromPAParent(
  p: PAParentLike,
  corpus: PedigreeCorpus,
  maxGen: 2 | 3 = 3,
): AncestorSet {
  const b: Builder = { best: new Map(), nameOnly: new Set() };

  const selfReg = normalizeReg(p.reg);
  const selfAnimalId = p.animalId ?? (selfReg ? corpus.regToAnimalId.get(selfReg) ?? null : null);
  const selfKeys = new Set<string>(selfAnimalId ? corpus.regsByAnimalId.get(selfAnimalId) ?? [] : []);
  if (selfReg) selfKeys.add(selfReg);

  for (const a of p.ancestors) {
    const gen = a.generation;
    if (!Number.isFinite(gen) || gen < 1 || gen > maxGen) continue;
    const path = SIDE_PATH(a.side, gen);
    const reg = normalizeReg(a.reg);
    if (!reg) {
      if (a.name) b.nameOnly.add(`${path}:${a.name}`);
      continue;
    }
    if (selfKeys.has(reg)) continue; // an animal is not its own ancestor
    const resolved = corpus.regToAnimalId.get(reg) ?? null;
    if (resolved && resolved === selfAnimalId) continue;
    record(b, { entity: resolved ?? reg, gen, reg, name: a.name, path });
  }

  return finishSet(b, selfKeys, selfAnimalId, p.name ?? null, corpus, maxGen);
}

function finishSet(
  b: Builder,
  selfKeys: Set<string>,
  selfAnimalId: string | null,
  selfName: string | null,
  corpus: PedigreeCorpus,
  maxGen: 2 | 3,
): AncestorSet {
  const keys = new Map<string, 1 | 2 | 3>();
  const entityByKey = new Map<string, string>();
  let n1 = 0, n2 = 0, n3 = 0;

  for (const slot of b.best.values()) {
    if (slot.gen === 1) n1++;
    else if (slot.gen === 2) n2++;
    else if (slot.gen === 3) n3++;

    // ALIAS EXPANSION: when the reg resolved to an animal we hold, every one of
    // that animal's active identifiers becomes a comparison key at this
    // generation. This is the only use of animalId in the comparison.
    // UNAMBIGUOUS aliases only — see PedigreeCorpus.aliasRegsByAnimalId.
    const aliases = corpus.aliasRegsByAnimalId.get(slot.entity) ?? [];
    const all = aliases.length ? [...new Set([slot.reg, ...aliases])] : [slot.reg];
    for (const k of all) {
      const prev = keys.get(k);
      if (prev == null || slot.gen < prev) {
        keys.set(k, slot.gen as 1 | 2 | 3);
        entityByKey.set(k, slot.entity);
      }
    }
  }

  const nAt = [0, n1, n2, n3];
  const caps = [0, 2, 4, 8];
  let slots = 0;
  for (let g = 1; g <= maxGen; g++) slots += Math.min(nAt[g], caps[g]);

  const set: AncestorSet = {
    keys, selfKeys, slots, n1, n2, n3,
    pedComplete: 0,
    maxGen,
    entityByKey,
    entities: b.best,
    selfEntity: selfAnimalId ?? (selfKeys.size ? [...selfKeys][0] : null),
    selfName,
    nameOnly: b.nameOnly.size,
  };
  set.pedComplete = pedCompleteness(set);
  return set;
}

/**
 * MacCluer generation-weighted pedigree completeness, in [0,1].
 *
 *   ( min(n1,2)/2 + min(n2,4)/4 + min(n3,8)/8 ) / 3
 *
 * Reference points at maxGen 3:
 *   own notes only, sire unresolved (the ~47% cohort) = 2/2/2 -> 0.583
 *   own notes + sire resolves                         = 2/4/4 -> 0.833
 *   full 14-slot live-fetched cow                     = 2/4/8 -> 1.000
 *
 * At maxGen 2 the sum is normalised over the two generations actually screened,
 * so a 2/2 pedigree scores 0.75. That renormalisation multiplies every score by
 * 3/d, so the certification floor MUST be scaled by the same factor — see
 * floorForDepth below, without which choosing the shallower screen would quietly
 * certify the paternally blind cohort it exists to withhold.
 */
export function pedCompleteness(set: AncestorSet): number {
  return completenessAt(set, set.maxGen);
}

/**
 * The completeness bar at a given screening depth.
 *
 * The floor (0.75 by default) is calibrated against the FULL three-generation
 * MacCluer denominator, where 0.833 (own pedigree line plus a sire whose own
 * parents we hold) is the weakest pedigree worth certifying and 0.583 (own line
 * only — the sire's parents unknown) is not.
 *
 * completenessAt() divides by the number of generations actually screened, so at
 * depth 2 every score is multiplied by 3/2. Left alone, that same paternally
 * blind pedigree would score 0.75 at depth 2 and clear the floor: picking the
 * WEAKER screen would upgrade a pair from withheld to recommended with no new
 * pedigree knowledge, and the branch it is blind to (the sire's parents) is
 * generation 2 — precisely what a depth-2 screen advertises that it checks.
 *
 * Scaling the floor by the same 3/d undoes the renormalisation, so the floor
 * keeps meaning one fixed quantity of evidence at either depth. The practical
 * effect: the cohort that can be certified is the same at depth 2 and depth 3
 * (an animal whose sire resolves scores 0.833 at depth 3 and 1.000 at depth 2).
 * The depth menu changes how far the search looks, never how much it demands.
 */
export function floorForDepth(floor: number, maxGen: 2 | 3): number {
  return Math.min(1, (floor * 3) / maxGen);
}

function completenessAt(set: AncestorSet, maxGen: 2 | 3): number {
  const d = Math.min(maxGen, set.maxGen);
  const nAt = [0, set.n1, set.n2, set.n3];
  const caps = [0, 2, 4, 8];
  let sum = 0;
  for (let g = 1; g <= d; g++) sum += Math.min(nAt[g], caps[g]) / caps[g];
  return sum / d;
}

function slotsAt(set: AncestorSet, maxGen: 2 | 3): number {
  const d = Math.min(maxGen, set.maxGen);
  const nAt = [0, set.n1, set.n2, set.n3];
  const caps = [0, 2, 4, 8];
  let s = 0;
  for (let g = 1; g <= d; g++) s += Math.min(nAt[g], caps[g]);
  return s;
}

// --- the predicate ----------------------------------------------------------

export type Tier = "excluded" | "clear" | "unknown" | "no-pedigree";

export interface SharedAncestor {
  reg: string;
  name: string | null;
  /** 0 means "is the cow herself". */
  cowGen: number;
  /** 0 means "is the bull himself". */
  bullGen: number;
  label: string;
}

export interface RelatednessVerdict {
  tier: Tier;
  shared: SharedAncestor[];
  confidence: number;
  cowSlots: number;
  bullSlots: number;
  /** min(cowGen + bullGen) over the shared ancestors — a shared sire (2) is a
   *  very different animal from a shared great-grandsire (6). null when clear. */
  closestSum: number | null;
}

interface Ref { entity: string; gen: number; reg: string; name: string | null; path: string }

/** Every comparison key of one side at depth D, self included at generation 0. */
function viewOf(set: AncestorSet, maxGen: 2 | 3): Map<string, Ref> {
  const out = new Map<string, Ref>();
  for (const [key, gen] of set.keys) {
    if (gen > maxGen) continue;
    const entity = set.entityByKey.get(key) ?? key;
    const slot = set.entities.get(entity);
    out.set(key, { entity, gen, reg: slot?.reg ?? key, name: slot?.name ?? null, path: slot?.path ?? `generation ${gen}` });
  }
  // Self overrides: the animal itself always wins at generation 0.
  const selfEntity = set.selfEntity ?? "__self__";
  for (const key of set.selfKeys) {
    out.set(key, { entity: selfEntity, gen: 0, reg: key, name: set.selfName, path: "self" });
  }
  return out;
}

function shareLabel(cowGen: number, bullGen: number, cowPath: string, bullPath: string): string {
  if (cowGen === 0 && bullGen === 0) return "she is this bull";
  if (bullGen === 0) return `this bull is her ${cowPath}`;
  if (cowGen === 0) return `she is his ${bullPath}`;
  return `her ${cowPath} × his ${bullPath}`;
}

/**
 * RELATED_D(cow,bull) <=> ( A_D(cow) ∪ Self(cow) ) ∩ ( A_D(bull) ∪ Self(bull) ) ≠ ∅
 *
 * The `∪ Self` on both sides is not decoration. A bull's own registration never
 * appears in his own ancestor set, so an ancestors-only intersection would fail
 * to notice that the bull IS the cow's sire — and the report would rank her own
 * father first. That case, and its mirror, are the whole point of the union.
 */
export function assessRelatedness(
  cow: AncestorSet,
  bull: AncestorSet,
  opts: { maxGen: 2 | 3; floor: number },
): RelatednessVerdict {
  const D = opts.maxGen;
  const cowView = viewOf(cow, D);
  const bullView = viewOf(bull, D);

  // Walk the smaller side; dedupe hits by ancestor ENTITY so that one animal
  // seen under two identifiers is reported once.
  const [small, large] = cowView.size <= bullView.size ? [cowView, bullView] : [bullView, cowView];
  const smallIsCow = small === cowView;
  const byEntity = new Map<string, SharedAncestor>();
  for (const [key, a] of small) {
    const bMatch = large.get(key);
    if (!bMatch) continue;
    const cRef = smallIsCow ? a : bMatch;
    const bRef = smallIsCow ? bMatch : a;
    const entity = cRef.entity;
    const hit: SharedAncestor = {
      reg: cRef.gen === 0 ? bRef.reg : cRef.reg,
      name: cRef.name ?? bRef.name,
      cowGen: cRef.gen,
      bullGen: bRef.gen,
      label: shareLabel(cRef.gen, bRef.gen, cRef.path, bRef.path),
    };
    const prev = byEntity.get(entity);
    if (!prev || hit.cowGen + hit.bullGen < prev.cowGen + prev.bullGen) byEntity.set(entity, hit);
  }
  const shared = [...byEntity.values()].sort(
    (x, y) => x.cowGen + x.bullGen - (y.cowGen + y.bullGen) || x.reg.localeCompare(y.reg),
  );

  // MINIMUM, never a product and never a mean: the screen is exactly as good as
  // its blinder half. A product would let a fully documented cow certify a
  // paternally blind bull.
  const confidence = Math.min(completenessAt(cow, D), completenessAt(bull, D));
  const cowSlots = slotsAt(cow, D);
  const bullSlots = slotsAt(bull, D);

  const cowHasKeys = [...cow.keys.values()].some((g) => g <= D);
  const bullHasKeys = [...bull.keys.values()].some((g) => g <= D);

  // The floor travels with the depth: completenessAt() normalises over D, so a
  // floor quoted against the 3-generation grid has to be scaled by 3/D or a
  // shallower screen would silently become a lower evidence bar.
  const floor = floorForDepth(opts.floor, D);

  let tier: Tier;
  if (shared.length) tier = "excluded";
  else if (!cowHasKeys || !bullHasKeys || confidence === 0) tier = "no-pedigree";
  else if (confidence >= floor) tier = "clear";
  else tier = "unknown";

  return {
    tier,
    shared,
    confidence,
    cowSlots,
    bullSlots,
    closestSum: shared.length ? shared[0].cowGen + shared[0].bullGen : null,
  };
}

/**
 * Why a set is too thin to certify — for the "Not enough pedigree to check"
 * panel. Names the dark branch instead of shrugging.
 */
export function darkBranchNote(set: AncestorSet): string | null {
  if (set.keys.size === 0) return "no pedigree on record — nothing could be screened";
  const bits: string[] = [];
  if (set.n1 < 2) bits.push("a parent is unrecorded");
  if (set.maxGen >= 2 && set.n2 < 4) bits.push("sire's parents unknown — paternal generation 2 not screened");
  if (set.maxGen >= 3 && set.n3 < 8) bits.push("generation 3 only partly recorded");
  if (set.nameOnly > 0) bits.push(`${set.nameOnly} ancestor${set.nameOnly === 1 ? "" : "s"} named without a registration number`);
  return bits.length ? bits.join("; ") : null;
}
