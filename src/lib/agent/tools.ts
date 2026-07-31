// ---------------------------------------------------------------------------
// Genetics Intelligence Agent — data tools.
//
// Each tool is a typed, PARAMETERIZED wrapper over the existing Prisma data
// layer. No tool ever builds SQL from user text — the model supplies typed
// arguments, and every query is a normal Prisma call. Every tool returns both a
// human summary and the `records` it touched, so the agent can cite its sources
// and never has to invent data.
//
// Add a new capability by appending one entry to AGENT_TOOLS: give it a name,
// a description (the model reads this to decide when to call it), a JSON-schema
// for its input, and a `run` that returns { summary, records }.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { sireRoleWhere } from "@/lib/sire-class";
import { parsePedigreeNotes, resolveAncestors, computePedigreeIndex } from "@/lib/pedigree";
import { unpackTraits, traitDefMap } from "@/lib/eval-traits";
import { parseHolsteinProfileJson } from "@/lib/holstein-parse";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<{ summary: string; records: unknown }>;
}

// Friendly trait name → indexed GeneticEvaluation column.
const TRAIT_COL: Record<string, string> = {
  lpi: "lpi", "pro$": "proDollar", prodollar: "proDollar", conf: "conf", conformation: "conf",
  milk: "milk", fat: "fat", prot: "prot", protein: "prot", mamm: "mamm", mammary: "mamm",
  fl: "fl", "feet & legs": "fl", ds: "ds", "dairy strength": "ds", hl: "hl", scs: "scs",
};
export const traitCol = (t: string | undefined) => TRAIT_COL[(t ?? "lpi").toLowerCase().trim()] ?? "lpi";
export const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = Number(n); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};

const PREF_SELECT = {
  lpi: true, proDollar: true, conf: true, milk: true, fat: true, prot: true, mamm: true, fl: true, ds: true, hl: true, scs: true,
  proofRun: true, reliabilityOverall: true,
} satisfies Prisma.GeneticEvaluationSelect;

const ANIMAL_CARD = {
  id: true, primaryName: true, sireType: true, proofStatus: true,
  proofRoundCount: true, rollbackCount: true, rollbackResistance: true, proofPerformance: true,
  latestProofRun: true, birthDate: true,
  breed: { select: { breedName: true } },
  identifiers: { where: { isPrimary: true, active: true }, take: 1, select: { idValue: true } },
  evaluations: { where: { isPreferred: true }, take: 1, select: PREF_SELECT },
} satisfies Prisma.AnimalSelect;

type Card = Prisma.AnimalGetPayload<{ select: typeof ANIMAL_CARD }>;
const flatten = (a: Card) => ({
  name: a.primaryName, reg: a.identifiers[0]?.idValue ?? null, breed: a.breed?.breedName ?? null,
  sireType: a.sireType, proofStatus: a.proofStatus, proofRounds: a.proofRoundCount, rollbacks: a.rollbackCount,
  rollbackResistance: a.rollbackResistance, proofPerformance: a.proofPerformance, latestProof: a.latestProofRun,
  ...(a.evaluations[0] ?? {}),
});

/** Shared: animal WHERE from optional role + breed filters. */
async function animalFilter(input: Record<string, unknown>): Promise<Prisma.AnimalWhereInput> {
  const AND: Prisma.AnimalWhereInput[] = [{ archived: false }];
  const role = typeof input.role === "string" ? input.role : undefined;
  const rw = sireRoleWhere(role) as Prisma.AnimalWhereInput | null;
  if (rw) AND.push(rw);
  if (typeof input.breed === "string" && input.breed.trim()) {
    AND.push({ breed: { breedName: { contains: input.breed.trim(), mode: "insensitive" } } });
  }
  return { AND };
}

// ---------------------------------------------------------------------------
// Full-profile helpers — shared by get_animal_full_profile and calculate_mating_pa.
// These expose EVERY stored trait (unpacked from GeneticEvaluation.traitsJson),
// not just the ~11 indexed columns the other tools surface.
// ---------------------------------------------------------------------------

const FULL_ANIMAL_SELECT = {
  id: true, primaryName: true, shortName: true, sex: true, birthDate: true,
  countryOfOrigin: true, currentStatus: true, archived: true,
  sireType: true, proofStatus: true, proofRoundCount: true, rollbackCount: true,
  latestProofRun: true, latestActivityCode: true,
  proofPerformance: true, rollbackResistance: true, rollbackCohortN: true,
  holsteinProfileJson: true,
  breed: { select: { breedName: true, breedCode: true } },
  identifiers: { where: { active: true }, orderBy: [{ isPrimary: "desc" }, { idType: "asc" }], select: { idType: true, idValue: true, isPrimary: true, issuingOrganization: true } },
  evaluations: {
    orderBy: { evaluationDate: "desc" },
    select: {
      proofRun: true, evaluationDate: true, countrySystem: true, reliabilityOverall: true,
      daughters: true, herds: true, genotyped: true, activityCode: true, officialCode: true, sireType: true, isPreferred: true, traitsJson: true, lpi: true,
    },
  },
  classifications: { orderBy: { classificationDate: "desc" }, select: { classificationCode: true, finalScore: true, classificationDate: true, lactationNumber: true, traitValues: { select: { traitCode: true, traitName: true, traitValue: true } } } },
  milkRecords: { orderBy: { recordDate: "desc" }, select: { lactationNumber: true, daysInMilk: true, milkAmount: true, milkUnit: true, fatAmount: true, fatPercent: true, proteinAmount: true, proteinPercent: true, recordType: true, calvingDate: true } },
} satisfies Prisma.AnimalSelect;

type FullAnimal = Prisma.AnimalGetPayload<{ select: typeof FULL_ANIMAL_SELECT }>;
type DefMap = Awaited<ReturnType<typeof traitDefMap>>;

/** Find one animal by exact reg, else exact name, else name-contains. */
async function findAnimalFull(name: string, reg: string): Promise<FullAnimal | null> {
  if (reg) {
    const byReg = await prisma.animal.findFirst({ where: { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }, select: FULL_ANIMAL_SELECT });
    if (byReg) return byReg;
  }
  if (name) {
    const exact = await prisma.animal.findFirst({ where: { archived: false, primaryName: { equals: name, mode: "insensitive" } }, select: FULL_ANIMAL_SELECT });
    if (exact) return exact;
    return prisma.animal.findFirst({ where: { archived: false, primaryName: { contains: name, mode: "insensitive" } }, select: FULL_ANIMAL_SELECT });
  }
  return null;
}

interface TraitOut { code: string; name: string; category: string | null; value: number | null; text: string | null; reliability: number | null; percentileRank: number | null; }

function preferredEval(a: FullAnimal) { return a.evaluations.find((e) => e.isPreferred) ?? a.evaluations[0] ?? null; }

function traitsFromEval(ev: FullAnimal["evaluations"][number] | null, defMap: DefMap): TraitOut[] {
  if (!ev) return [];
  return unpackTraits(ev.traitsJson, defMap).map((t) => ({ code: t.traitCode, name: t.traitName, category: t.traitCategory, value: t.numericValue, text: t.textValue, reliability: t.reliability, percentileRank: t.percentileRank }));
}

async function buildFullProfile(a: FullAnimal) {
  const defMap = await traitDefMap();
  const ev = preferredEval(a);
  const traits = traitsFromEval(ev, defMap);
  const prof = parseHolsteinProfileJson(a.holsteinProfileJson);
  return {
    found: true,
    animal: {
      name: a.primaryName, shortName: a.shortName, sex: a.sex, breed: a.breed?.breedName ?? null,
      birthDate: a.birthDate ? a.birthDate.toISOString().slice(0, 10) : null,
      country: a.countryOfOrigin, status: a.currentStatus, archived: a.archived,
      sireType: a.sireType, proofStatus: a.proofStatus, proofRoundCount: a.proofRoundCount, rollbackCount: a.rollbackCount,
      latestProofRun: a.latestProofRun, latestActivityCode: a.latestActivityCode,
      proofPerformance: a.proofPerformance, rollbackResistance: a.rollbackResistance, rollbackCohortN: a.rollbackCohortN,
    },
    identifiers: a.identifiers.map((i) => ({ idType: i.idType, idValue: i.idValue, isPrimary: i.isPrimary, issuingOrganization: i.issuingOrganization })),
    preferredEvaluation: ev ? {
      proofRun: ev.proofRun, evaluationDate: ev.evaluationDate.toISOString().slice(0, 10), countrySystem: ev.countrySystem,
      reliabilityOverall: ev.reliabilityOverall, daughters: ev.daughters, herds: ev.herds, genotyped: ev.genotyped,
      activityCode: ev.activityCode, officialCode: ev.officialCode, basis: ev.sireType,
      traitCount: traits.length, traits,
    } : null,
    proofRoundHistory: a.evaluations.map((e) => ({ run: e.proofRun ?? e.evaluationDate.toISOString().slice(0, 7), date: e.evaluationDate.toISOString().slice(0, 10), lpi: e.lpi, preferred: e.isPreferred })),
    classifications: a.classifications.map((c) => ({ code: c.classificationCode, score: c.finalScore, date: c.classificationDate ? c.classificationDate.toISOString().slice(0, 10) : null, lactation: c.lactationNumber, sections: c.traitValues.map((t) => ({ code: t.traitCode, name: t.traitName, value: t.traitValue })) })),
    milkRecords: a.milkRecords.map((m) => ({ lactation: m.lactationNumber, dim: m.daysInMilk, milk: m.milkAmount, milkUnit: m.milkUnit, fat: m.fatAmount, fatPct: m.fatPercent, protein: m.proteinAmount, proteinPct: m.proteinPercent, type: m.recordType, calvingDate: m.calvingDate ? m.calvingDate.toISOString().slice(0, 10) : null })),
    holsteinProfile: prof ? { owners: prof.owners, breeders: prof.breeders, awards: prof.awards, lactationCount: prof.lactations.length, familyTreeCount: prof.familyTree.length, progenyCount: prof.progeny.length } : null,
  };
}

// --- Parent-average helpers -------------------------------------------------

interface TraitVal { value: number | null; text: string | null; name: string; category: string | null; reliability: number | null; }
interface ParentSource {
  found: boolean;
  source: "internal" | "lactanet" | null;
  name: string | null;
  reg: string | null;
  sex: string | null;
  reliabilityOverall: number | null;
  basis: string | null;          // "proven" | "genomic" | GEBV/PA etc.
  genotyped: boolean | null;
  daughters: number | null;
  proofRun: string | null;
  traits: Map<string, TraitVal>;
  externallySourced: boolean;
  error?: string;
  // Kept ONLY within this call for an optional explicit save; never cached globally.
  _externalReg?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The agent-facing summary of a parent (never includes the raw scrape). */
function parentMeta(p: ParentSource) {
  return {
    found: p.found, name: p.name, reg: p.reg, sex: p.sex, source: p.source,
    externallySourced: p.externallySourced, reliabilityOverall: p.reliabilityOverall,
    basis: p.basis, genotyped: p.genotyped, daughters: p.daughters, proofRun: p.proofRun,
    traitCount: p.traits.size, error: p.error,
  };
}

// Explicit, opt-in persistence of an externally-pulled record (saveToDatabase=true).
// Reuses the same Lactanet ingest the lookup UI uses, so a saved external parent
// is written identically to any other imported animal (evaluation + rich profile
// + preferred recompute). It re-fetches, which is fine: saving is a rare, explicit
// action, and it keeps a single source of truth for how a Lactanet animal is stored.
async function persistExternal(p: ParentSource): Promise<void> {
  if (!p._externalReg) throw new Error("no external registration to save");
  const { ingestLactanetReg } = await import("@/lib/lactanet-ingest");
  const out = await ingestLactanetReg(p._externalReg);
  if (!out.ok) throw new Error(out.error ?? "Lactanet import failed");
}

function internalParent(a: FullAnimal, defMap: DefMap): ParentSource {
  const ev = preferredEval(a);
  const traits = new Map<string, TraitVal>();
  for (const t of traitsFromEval(ev, defMap)) traits.set(t.code, { value: t.value, text: t.text, name: t.name, category: t.category, reliability: t.reliability });
  return {
    found: true, source: "internal", name: a.primaryName,
    reg: a.identifiers.find((i) => i.isPrimary)?.idValue ?? a.identifiers[0]?.idValue ?? null,
    sex: a.sex, reliabilityOverall: ev?.reliabilityOverall ?? null, basis: ev?.sireType ?? null,
    genotyped: ev?.genotyped ?? null, daughters: ev?.daughters ?? null, proofRun: ev?.proofRun ?? null,
    traits, externallySourced: false,
  };
}

// Live Lactanet lookup — SESSION-ONLY. The fetched pages live only in this
// function's locals; nothing is written to any module-level cache or the DB
// unless the caller explicitly opts in via saveToDatabase (persistExternal).
async function externalParent(reg: string): Promise<ParentSource> {
  const empty = (error: string): ParentSource => ({ found: false, source: null, name: null, reg, sex: null, reliabilityOverall: null, basis: null, genotyped: null, daughters: null, proofRun: null, traits: new Map(), externallySourced: true, error });
  const { parseReg, fetchLactanetAnimal } = await import("@/lib/lactanet-web");
  const ref = parseReg(reg);
  if (!ref) return empty(`"${reg}" is not a registration number (expected e.g. HOCANM13486161).`);
  let fetched;
  try {
    fetched = await fetchLactanetAnimal(reg);
  } catch (e) {
    return empty(`Lactanet lookup failed: ${(e as Error)?.message ?? e}`);
  }
  if (fetched.error) return empty(`Lactanet: ${fetched.error}`);
  const { parseLactanetAnimal } = await import("@/lib/lactanet-parse");
  const parsed = parseLactanetAnimal(reg, ref.sex, fetched.tabs, fetched.fetchedAt);
  if (!parsed.evaluation.traits.length) return empty("Lactanet returned no usable proof data for that registration number.");
  const traits = new Map<string, TraitVal>();
  for (const t of parsed.evaluation.traits) traits.set(t.code, { value: t.numericValue, text: t.textValue, name: t.code, category: null, reliability: t.reliability });
  return {
    found: true, source: "lactanet", name: parsed.identity.name, reg,
    sex: ref.sex, reliabilityOverall: parsed.evaluation.reliability, basis: parsed.evaluation.basis,
    genotyped: null, daughters: null, proofRun: parsed.evaluation.runLabel,
    traits, externallySourced: true, _externalReg: reg,
  };
}

/** Resolve a parent: internal first; Lactanet only if missing and a reg is given. */
async function resolveParent(name: string, reg: string, defMap: DefMap): Promise<ParentSource> {
  const internal = await findAnimalFull(name, reg);
  if (internal) return internalParent(internal, defMap);
  if (reg) return externalParent(reg);
  return { found: false, source: null, name: name || null, reg: reg || null, sex: null, reliabilityOverall: null, basis: null, genotyped: null, daughters: null, proofRun: null, traits: new Map(), externallySourced: false, error: `Not in the database, and no registration number was given to look up externally.` };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "search_animals",
    description: "Find sires by name or registration number, optionally filtered by role (proven/genomic/active/inactive) and breed. Use for 'find', 'look up', 'is there a bull named…'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name fragment or registration number" },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        breed: { type: "string", description: "Breed name fragment, e.g. Holstein" },
        limit: { type: "integer", description: "Max results (default 15, max 50)" },
      },
    },
    run: async (input) => {
      const base = await animalFilter(input);
      const q = typeof input.query === "string" ? input.query.trim() : "";
      const AND = [...(base.AND as Prisma.AnimalWhereInput[])];
      if (q) AND.push({ OR: [
        { primaryName: { contains: q, mode: "insensitive" } },
        { identifiers: { some: { idValue: { contains: q, mode: "insensitive" } } } },
      ] });
      const rows = await prisma.animal.findMany({ where: { AND }, take: clamp(input.limit, 1, 50, 15), orderBy: { primaryName: "asc" }, select: ANIMAL_CARD });
      const records = rows.map(flatten);
      return { summary: `${records.length} sire(s) matched${q ? ` "${q}"` : ""}.`, records };
    },
  },
  {
    name: "get_animal",
    description: "Full detail for one sire by exact name or registration number: preferred evaluation traits, proven/genomic status, proof performance, rollback resistance, and proof-round count.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, reg: { type: "string" } },
    },
    run: async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      if (!name && !reg) return { summary: "Provide a name or registration number.", records: null };
      const where: Prisma.AnimalWhereInput = reg
        ? { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }
        : { archived: false, primaryName: { equals: name, mode: "insensitive" } };
      let a = await prisma.animal.findFirst({ where, select: ANIMAL_CARD });
      if (!a && name) a = await prisma.animal.findFirst({ where: { archived: false, primaryName: { contains: name, mode: "insensitive" } }, select: ANIMAL_CARD });
      if (!a) return { summary: `No sire found for ${reg || name}.`, records: null };
      return { summary: `Detail for ${a.primaryName}.`, records: flatten(a) };
    },
  },
  {
    name: "rank_animals",
    description: "Top or bottom N sires by a trait (lpi, pro$, conf, milk, fat, prot, mamm, fl, ds) among optional role/breed filters. Use for 'highest LPI', 'best conformation active bulls', 'lowest…'.",
    input_schema: {
      type: "object",
      properties: {
        trait: { type: "string", description: "lpi | pro$ | conf | milk | fat | prot | mamm | fl | ds" },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        breed: { type: "string" },
        order: { type: "string", enum: ["top", "bottom"], description: "top = highest (default)" },
        limit: { type: "integer", description: "default 10, max 30" },
      },
      required: ["trait"],
    },
    run: async (input) => {
      const col = traitCol(input.trait as string);
      const dir = input.order === "bottom" ? "asc" : "desc";
      const base = await animalFilter(input);
      const evals = await prisma.geneticEvaluation.findMany({
        where: { isPreferred: true, [col]: { not: null }, animal: base },
        orderBy: { [col]: dir }, take: clamp(input.limit, 1, 30, 10),
        select: { [col]: true, animal: { select: ANIMAL_CARD } } as Prisma.GeneticEvaluationSelect,
      });
      const records = evals.map((e) => ({ value: (e as Record<string, unknown>)[col], ...flatten((e as unknown as { animal: Card }).animal) }));
      return { summary: `${input.order === "bottom" ? "Lowest" : "Highest"} ${records.length} by ${col}.`, records };
    },
  },
  {
    name: "lineup_stats",
    description: "Aggregate counts and averages for the lineup: how many proven/genomic/active/inactive, total sires and proof rounds, and average LPI/Pro$/Conformation. Use for 'how many…', 'lineup overview', 'average LPI'.",
    input_schema: { type: "object", properties: { role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] }, breed: { type: "string" } } },
    run: async (input) => {
      const base = await animalFilter(input);
      const [total, byClass, avg, rounds] = await Promise.all([
        prisma.animal.count({ where: base }),
        prisma.animal.groupBy({ by: ["sireType", "proofStatus"], where: base, _count: { _all: true } }),
        prisma.geneticEvaluation.aggregate({ where: { isPreferred: true, animal: base }, _avg: { lpi: true, proDollar: true, conf: true, milk: true, fat: true, prot: true } }),
        prisma.geneticEvaluation.count({ where: { animal: base } }),
      ]);
      const counts: Record<string, number> = { proven: 0, genomic: 0, active: 0, inactive: 0 };
      for (const g of byClass) { if (g.sireType && g.sireType in counts) counts[g.sireType] += g._count._all; if (g.proofStatus && g.proofStatus in counts) counts[g.proofStatus] += g._count._all; }
      const round1 = (v: number | null) => (v == null ? null : Math.round(v));
      const averages = { lpi: round1(avg._avg.lpi), proDollar: round1(avg._avg.proDollar), conf: round1(avg._avg.conf), milk: round1(avg._avg.milk), fat: round1(avg._avg.fat), prot: round1(avg._avg.prot) };
      return { summary: `${total} sires, ${rounds} proof rounds. Averages computed.`, records: { total, proofRounds: rounds, counts, averages } };
    },
  },
  {
    name: "rollback_leaders",
    description: "Best or worst sires by Rollback Resistance (April base-change retention, base 100) or Proof Performance (0–100, every round). Use for 'most rollback resistant', 'which bulls hold up best', 'proof stability leaders'.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["rollbackResistance", "proofPerformance"], description: "default rollbackResistance" },
        order: { type: "string", enum: ["top", "bottom"] },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        limit: { type: "integer", description: "default 10, max 30" },
      },
    },
    run: async (input) => {
      const metric = input.metric === "proofPerformance" ? "proofPerformance" : "rollbackResistance";
      const dir = input.order === "bottom" ? "asc" : "desc";
      const base = await animalFilter(input);
      const rows = await prisma.animal.findMany({
        where: { AND: [base, { [metric]: { not: null } }] },
        orderBy: { [metric]: dir }, take: clamp(input.limit, 1, 30, 10), select: ANIMAL_CARD,
      });
      return { summary: `${input.order === "bottom" ? "Lowest" : "Highest"} ${rows.length} by ${metric}.`, records: rows.map(flatten) };
    },
  },
  {
    name: "proof_history",
    description: "A single sire's proof rounds over time for one trait (default LPI) — the value at each round, oldest to newest. Use for 'how has X's LPI changed', 'proof trend', 'over time'.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, reg: { type: "string" }, trait: { type: "string", description: "default lpi" } },
    },
    run: async (input) => {
      const col = traitCol(input.trait as string);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      const where: Prisma.AnimalWhereInput = reg
        ? { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }
        : { archived: false, primaryName: { contains: name, mode: "insensitive" } };
      const a = await prisma.animal.findFirst({ where, select: { primaryName: true, evaluations: { orderBy: { evaluationDate: "asc" }, select: { proofRun: true, evaluationDate: true, [col]: true } } } });
      if (!a) return { summary: `No sire found for ${reg || name}.`, records: null };
      const series = a.evaluations.map((ev) => {
        const e = ev as unknown as { proofRun: string | null; evaluationDate: Date; [k: string]: unknown };
        return { round: e.proofRun ?? e.evaluationDate.toISOString().slice(0, 7), value: e[col] as number | null };
      });
      return { summary: `${a.primaryName}: ${series.length} rounds of ${col}.`, records: { name: a.primaryName, trait: col, series } };
    },
  },
  {
    name: "pedigree_index",
    description: "A sire's 3-generation pedigree (sire/dam/MGS/MGD/GMGS/GMGD) plus the estimated Pedigree Index (parent average LPI from held male-line ancestors) and its confidence. Use for 'pedigree', 'what does his pedigree suggest', 'ancestors'.",
    input_schema: { type: "object", properties: { name: { type: "string" }, reg: { type: "string" } } },
    run: async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      const where: Prisma.AnimalWhereInput = reg
        ? { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }
        : { archived: false, primaryName: { contains: name, mode: "insensitive" } };
      const a = await prisma.animal.findFirst({ where, select: { primaryName: true, pedigreeRefs: { select: { notes: true } } } });
      if (!a) return { summary: `No sire found for ${reg || name}.`, records: null };
      const notes = a.pedigreeRefs.map((p) => p.notes).find((nn) => nn && /\bSIRE:/i.test(nn)) ?? null;
      const ancestors = await resolveAncestors(prisma, parsePedigreeNotes(notes));
      const pi = computePedigreeIndex(ancestors);
      return {
        summary: `${a.primaryName}: pedigree index LPI ${pi.lpi ?? "n/a"} at ${Math.round(pi.confidence * 100)}% confidence.`,
        records: {
          name: a.primaryName,
          pedigreeIndex: { lpi: pi.lpi, confidence: Math.round(pi.confidence * 100) / 100, contributors: pi.contributors, traits: pi.traits.filter((t) => t.value != null) },
          ancestors: ancestors.map((x) => ({ relation: x.relation, name: x.name, reg: x.reg, inDatabase: !!x.animalId, lpi: x.evalValues?.lpi ?? null, sireType: x.sireType })),
        },
      };
    },
  },
  {
    name: "get_animal_full_profile",
    description:
      "EXHAUSTIVE record for ONE animal by exact name or registration number — EVERY field held, not the curated subset the other tools return. Returns: identity/status fields; ALL genetic traits on the preferred evaluation, UNPACKED from storage (up to ~60 when present) — indexes (LPI, Pro$, PI, LTI, HWI, RI, MI, EI), production (MILK, FAT, PROT, %F, %P, SCS), functional & health/fertility (HL, LP, DF=Daughter Fertility, CA/DCA=Calving Ability, MDR, MR, HH, BCS, MSPD, MTMP, FE, BMR, METH, CH), conformation composites (CONF, MAMM, FL, DS, RUMP, AFS), and EVERY linear conformation trait (STA, HFE, CHW, BODY, RIB, RA=Rump Angle, PW=Pin Width, LOIN, THURL, FA=Foot Angle, HD, BQ, RLSV, RLRV=Rear Legs Rear View, FLV, LOCO, FUA=Fore Udder Attachment, RAH, RAW, UDEP=Udder Depth, UTEX, MSUS=Median Suspensory/cleft, FTP/RTP=Teat Placement, TL=Teat Length) — each with value, per-trait reliability and percentile rank WHERE PRESENT; plus proof-round history, classification history with section scores, lactation/milk records, and any stored owners/awards where present (breed-association data, not populated from Lactanet). Trait availability VARIES by animal and round — ONLY traits actually stored are returned; anything absent is simply not in the list (do not infer a missing trait is zero). Use this for detailed conformation/linear/health-trait questions or 'everything about' an animal. NOTE: beef traits, non-return-rate, and udder-cleft-as-a-separate-score are NOT tracked in this system.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Exact or partial animal name" }, reg: { type: "string", description: "Registration number (exact)" } } },
    run: async (input) => {
      const name = str(input.name), reg = str(input.reg);
      if (!name && !reg) return { summary: "Provide a name or registration number.", records: null };
      const a = await findAnimalFull(name, reg);
      if (!a) return { summary: `No animal found for ${reg || name}.`, records: null };
      const profile = await buildFullProfile(a);
      return { summary: `Full profile for ${a.primaryName}: ${profile.preferredEvaluation?.traitCount ?? 0} traits on the preferred evaluation (${a.evaluations.length} rounds on file).`, records: profile };
    },
  },
  {
    name: "calculate_mating_pa",
    description:
      "Project a MATING between a sire (male) and dam (female) as the Parent Average (PA = simple mean of the two parents) across every trait BOTH animals have. Answers 'what would a mating of X and Y produce', 'PA of X × Y'. For each shared numeric trait it returns the sire value, the dam value, and the computed PA; categorical descriptors (A2/colour/polled) are returned side-by-side without a mean; traits held by only one parent are listed under unavailableForPA and are NEVER guessed or defaulted to zero. Each parent's overall reliability, evaluation basis (proven vs genomic/parent-average), genotyped flag and daughter count are included so you can caveat how trustworthy the projection is. FLOW: internal database first; if a parent is NOT in the database AND a registration number was supplied, it does a LIVE Lactanet lookup for that reg and clearly labels those values as externally sourced (possibly on a different evaluation basis than internal proofs). Externally-pulled data is SESSION-ONLY and is NOT saved unless saveToDatabase=true — always confirm with the user before setting that. If a parent is missing and cannot be looked up (no reg, or Lactanet has nothing / the lookup fails), it reports that plainly and does NOT return a partial PA.",
    input_schema: {
      type: "object",
      properties: {
        sireName: { type: "string", description: "Sire name (exact or partial)" },
        sireReg: { type: "string", description: "Sire registration number — also enables Lactanet fallback if not found internally" },
        damName: { type: "string", description: "Dam name (exact or partial)" },
        damReg: { type: "string", description: "Dam registration number — also enables Lactanet fallback if not found internally" },
        saveToDatabase: { type: "boolean", description: "Default false. Only set true if the user explicitly asked to permanently save any externally-pulled Lactanet record. When false, external data is used for this calculation only and then discarded." },
      },
    },
    run: async (input) => {
      const sireName = str(input.sireName), sireReg = str(input.sireReg);
      const damName = str(input.damName), damReg = str(input.damReg);
      const save = input.saveToDatabase === true;
      if (!(sireName || sireReg) || !(damName || damReg)) {
        return { summary: "Provide both a sire (name or reg) and a dam (name or reg).", records: null };
      }
      const defMap = await traitDefMap();
      const sire = await resolveParent(sireName, sireReg, defMap);
      const dam = await resolveParent(damName, damReg, defMap);

      // Either parent unresolved → report plainly, no partial/guessed PA.
      if (!sire.found || !dam.found) {
        const bits = [!sire.found ? `sire not found — ${sire.error}` : null, !dam.found ? `dam not found — ${dam.error}` : null].filter(Boolean).join(" ; ");
        return { summary: `Cannot compute a parent average: ${bits}`, records: { computed: false, sire: parentMeta(sire), dam: parentMeta(dam) } };
      }

      // A parent that exists but carries NO trait data (e.g. an old animal with
      // no proof, or a Lactanet page without an evaluation) can't contribute
      // to a PA — say so plainly rather than returning an empty/partial result.
      const noData = [sire, dam].filter((p) => p.traits.size === 0);
      if (noData.length) {
        return {
          summary: `Cannot compute a parent average: ${noData.map((p) => `${p.name ?? p.reg} has no genetic trait data available${p.externallySourced ? " on Lactanet" : ""}`).join("; ")}.`,
          records: { computed: false, reason: "one or both parents have no trait data", sire: parentMeta(sire), dam: parentMeta(dam) },
        };
      }

      // PA over traits present in BOTH parents.
      const pa: { code: string; name: string; category: string | null; sire: number; dam: number; parentAverage: number }[] = [];
      const descriptive: { code: string; name: string; sire: string; dam: string }[] = [];
      const unavailable: { code: string; name: string; availableFor: string }[] = [];
      const codes = new Set<string>([...sire.traits.keys(), ...dam.traits.keys()]);
      for (const code of [...codes].sort()) {
        const s = sire.traits.get(code), d = dam.traits.get(code);
        const name = s?.name ?? d?.name ?? code;
        const sNum = s && s.value != null, dNum = d && d.value != null;
        if (sNum && dNum) {
          pa.push({ code, name, category: s?.category ?? d?.category ?? null, sire: s!.value!, dam: d!.value!, parentAverage: Math.round(((s!.value! + d!.value!) / 2) * 100) / 100 });
        } else if (s?.text != null && d?.text != null) {
          descriptive.push({ code, name, sire: s.text, dam: d.text });
        } else {
          const has = (x?: TraitVal) => !!x && (x.value != null || x.text != null);
          unavailable.push({ code, name, availableFor: has(s) ? "sire only" : has(d) ? "dam only" : "neither" });
        }
      }

      const notes: string[] = [];
      if (sire.externallySourced || dam.externallySourced) notes.push("Some values came from Lactanet (externally sourced) and may be on a different evaluation basis than internal proof rounds.");
      for (const p of [sire, dam]) if (p.reliabilityOverall != null && p.reliabilityOverall < 0.7) notes.push(`${p.name} has low overall reliability (${Math.round(p.reliabilityOverall * 100)}%) — treat the projection as indicative.`);
      for (const p of [sire, dam]) if (p.basis && /genomic|pa|gpa/i.test(p.basis)) notes.push(`${p.name} is on a genomic/parent-average basis.`);
      if (sire.sex === "F") notes.push(`The animal supplied as sire (${sire.name}) is recorded as female.`);
      if (dam.sex === "M") notes.push(`The animal supplied as dam (${dam.name}) is recorded as male.`);

      // Optional, explicit persistence of externally-pulled records.
      let saved: unknown = "External data (if any) was used for this calculation only and NOT saved. Set saveToDatabase=true to persist an externally-pulled Lactanet record permanently.";
      if (save) {
        const done: string[] = [];
        for (const p of [sire, dam]) {
          if (p.externallySourced && p._externalReg) {
            try { await persistExternal(p); done.push(`${p.name ?? p._externalReg} (${p._externalReg})`); }
            catch (e) { done.push(`FAILED to save ${p._externalReg}: ${(e as Error).message}`); }
          }
        }
        saved = done.length ? { savedPermanently: done } : "Nothing external to save — both parents were already in the database.";
      }

      return {
        summary: `Parent average of ${sire.name} × ${dam.name}: ${pa.length} shared traits computed, ${unavailable.length} unavailable${sire.externallySourced || dam.externallySourced ? " (includes Lactanet-sourced data)" : ""}.`,
        records: { computed: true, sire: parentMeta(sire), dam: parentMeta(dam), parentAverage: pa, descriptive, unavailableForPA: unavailable, reliabilityNotes: notes, saved },
      };
    },
  },
];

export const AGENT_TOOL_MAP = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
