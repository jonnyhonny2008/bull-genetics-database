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
import { unpackTraits, traitDefMap, packTraits, type RawTrait } from "@/lib/eval-traits";
import { parseHolsteinProfileJson } from "@/lib/holstein-parse";
import { can, ROLES, isBatchImportType, LARGE_ANIMAL_IMPORT } from "@/lib/constants";
import { maskKey } from "./config";
// Type-only imports of server-only modules — erased at compile time, so they do
// not pull those modules into the static graph (the write tools import them at
// runtime with a dynamic import()).
import type { SessionUser } from "@/lib/auth";
import type { ImportManifest, ImportAnimalRef } from "@/lib/import-staging";

// NOTE ON SERVER-ONLY LIBS: db/eval-traits/pedigree/constants are plain modules
// (safe to import statically — the agent unit test imports this file under plain
// tsx). The write tools also need `server-only` libraries (audit, priority,
// lactanet, import-staging, proof-import, auth). Those are pulled in with a
// dynamic `await import(...)` INSIDE each run() — matching the existing external-
// lookup helpers — so the static import graph stays clean for the test runner.

// The signed-in user on whose behalf the agent acts. Every write goes through
// this actor — the agent can do ONLY what this person's role can do, and every
// change is attributed to them in the audit log. Read tools ignore it.
export interface AgentActor {
  uid: string;
  name: string;
  role: string; // a ROLES key: admin | staff | sales | consultant
}
export interface AgentContext {
  actor: AgentActor | null;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * `ctx` carries the acting user. Read tools may ignore it; write tools MUST
   * gate on `ctx.actor` via requireCap() so the agent never exceeds the
   * signed-in user's own permissions.
   */
  run: (input: Record<string, unknown>, ctx: AgentContext) => Promise<{ summary: string; records: unknown }>;
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

// ===========================================================================
// WRITE TOOLS — shared machinery
// ===========================================================================
//
// The tools above answer questions. The tools further down let the agent DO the
// things a signed-in user can do: create/update animals and records, manage
// reference data and users, run imports, and work the review queue. Three rules
// hold for every one of them:
//   1. PERMISSION PARITY — each write calls requireCap() with the SAME
//      capability the matching server action checks (src/lib/constants.ts), so
//      the agent can never exceed the signed-in user's own role.
//   2. ATTRIBUTION — every change is written to the audit log as the actor.
//   3. CONFIRMATION — destructive / irreversible actions refuse until called a
//      second time with confirm:true, so a single stray call can't lose data.

/** A ROLES key → its human label, for clear "your role can't…" messages. */
function roleLabel(role: string | undefined): string {
  return (ROLES as Record<string, string>)[role ?? ""] ?? role ?? "no role";
}

/**
 * Assert the acting user exists and holds `cap`; return the actor for
 * attribution. Throws a clear, user-facing message otherwise — the loop relays
 * it to the model as a tool error, so the agent explains it rather than
 * pretending the change happened. This is the HARD security boundary: it runs
 * server-side from the signed session's role and cannot be argued around by the
 * model or by anything embedded in retrieved data.
 */
export function requireCap(ctx: AgentContext, cap: string, action: string): AgentActor {
  const actor = ctx.actor;
  if (!actor || !actor.uid) throw new Error("No signed-in user — the assistant can't make changes without a session.");
  if (!can(actor.role, cap)) {
    throw new Error(`Your account (${roleLabel(actor.role)}) isn't allowed to ${action}. That needs the "${cap}" permission — ask an administrator.`);
  }
  return actor;
}

/** Audit a change as the acting user (mirrors src/lib/audit.ts; kept dependency-free). */
async function logAction(actor: AgentActor, entityType: string, action: string, entityId?: string, changes?: unknown, notes?: string): Promise<void> {
  await prisma.auditLog.create({
    data: {
      entityType, entityId, action,
      userId: actor.uid, userName: actor.name,
      changesJson: changes ? JSON.stringify(changes) : null,
      notes: notes ?? null,
    },
  });
}

/**
 * Two-step confirmation for a destructive / irreversible action. When the model
 * has NOT set confirm:true, returns a tool result that spells out exactly what
 * WILL happen and changes nothing; the model is instructed to show that to the
 * user and only re-call with confirm:true after a clear yes. Returns null when
 * confirm:true — the caller then proceeds.
 */
export function confirmGate(input: Record<string, unknown>, message: string, preview?: unknown): { summary: string; records: unknown } | null {
  if (input.confirm === true) return null;
  return {
    summary: `CONFIRM NEEDED — ${message} Nothing has been changed yet. Tell the user exactly what will happen and, only if they clearly agree, call this tool again with confirm:true.`,
    records: { confirmRequired: true, willDo: message, ...(preview !== undefined ? { preview } : {}) },
  };
}

/** Parse a yyyy-mm-dd (or full ISO) string into a Date, or null. */
function toDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s.length <= 10 ? s + "T00:00:00.000Z" : s);
  return isNaN(d.getTime()) ? null : d;
}
/** Parse a numeric field: "" / non-number → null. */
function toNum(v: unknown): number | null {
  const s = str(v);
  if (s === "") return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/**
 * Resolve a target animal to { id, name } from an explicit animalId, else exact
 * reg, else name (exact then contains) — the same precedence the read tools use,
 * so the agent addresses exactly one animal before writing to it.
 */
async function resolveAnimalId(input: Record<string, unknown>): Promise<{ id: string; name: string } | null> {
  const id = str(input.animalId);
  if (id) {
    const a = await prisma.animal.findUnique({ where: { id }, select: { id: true, primaryName: true } });
    return a ? { id: a.id, name: a.primaryName } : null;
  }
  const a = await findAnimalFull(str(input.name), str(input.reg));
  return a ? { id: a.id, name: a.primaryName } : null;
}

/** After any record change, recompute which evaluation is the animal's preferred one. */
async function recomputePreferred(animalId: string): Promise<void> {
  const { recomputePreferredForAnimal } = await import("@/lib/priority");
  await recomputePreferredForAnimal(animalId);
}

/**
 * Look one animal up LIVE on Lactanet by registration number (read-only,
 * session-only — nothing is saved). Used as the fallback when an animal the user
 * asks about isn't in the database. To persist an external animal, use the
 * import_animals tool. Reuses the same fetch/parse the mating calculator uses.
 */
async function externalAnimalProfile(reg: string): Promise<{ summary: string; records: unknown }> {
  const { parseReg, fetchLactanetAnimal } = await import("@/lib/lactanet-web");
  const ref = parseReg(reg);
  if (!ref) return { summary: `"${reg}" is not a registration number (expected e.g. HOCANM13486161), so I can't look it up on Lactanet.`, records: null };
  let fetched;
  try {
    fetched = await fetchLactanetAnimal(ref.reg);
  } catch (e) {
    return { summary: `Lactanet lookup failed: ${(e as Error)?.message ?? e}`, records: null };
  }
  if (fetched.error) return { summary: `Lactanet: ${fetched.error}`, records: null };
  const { parseLactanetAnimal } = await import("@/lib/lactanet-parse");
  const parsed = parseLactanetAnimal(ref.reg, ref.sex, fetched.tabs, fetched.fetchedAt);
  const traits = parsed.evaluation.traits.map((t) => ({ code: t.code, value: t.numericValue, text: t.textValue, reliability: t.reliability }));
  return {
    summary: `${parsed.identity.name ?? ref.reg} is NOT in your database — this profile came live from Lactanet (${traits.length} traits) and was NOT saved. To keep it, use import_animals with this registration number.`,
    records: {
      found: true, source: "lactanet", externallySourced: true, savedToDatabase: false,
      animal: { name: parsed.identity.name ?? null, reg: ref.reg, sex: ref.sex, birthDate: parsed.identity.birthDate ?? null },
      evaluation: { basis: parsed.evaluation.basis, reliabilityOverall: parsed.evaluation.reliability, proofRun: parsed.evaluation.runLabel, traitCount: traits.length, traits },
      note: "Externally sourced from Lactanet; session-only, not saved. Use import_animals to save it permanently.",
    },
  };
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
      "EXHAUSTIVE record for ONE animal by exact name or registration number — EVERY field held, not the curated subset the other tools return. Returns: identity/status fields; ALL genetic traits on the preferred evaluation, UNPACKED from storage (up to ~60 when present) — indexes (LPI, Pro$, PI, LTI, HWI, RI, MI, EI), production (MILK, FAT, PROT, %F, %P, SCS), functional & health/fertility (HL, LP, DF=Daughter Fertility, CA/DCA=Calving Ability, MDR, MR, HH, BCS, MSPD, MTMP, FE, BMR, METH, CH), conformation composites (CONF, MAMM, FL, DS, RUMP, AFS), and EVERY linear conformation trait (STA, HFE, CHW, BODY, RIB, RA=Rump Angle, PW=Pin Width, LOIN, THURL, FA=Foot Angle, HD, BQ, RLSV, RLRV=Rear Legs Rear View, FLV, LOCO, FUA=Fore Udder Attachment, RAH, RAW, UDEP=Udder Depth, UTEX, MSUS=Median Suspensory/cleft, FTP/RTP=Teat Placement, TL=Teat Length) — each with value, per-trait reliability and percentile rank WHERE PRESENT; plus proof-round history, classification history with section scores, lactation/milk records, and any stored owners/awards where present (breed-association data, not populated from Lactanet). Trait availability VARIES by animal and round — ONLY traits actually stored are returned; anything absent is simply not in the list (do not infer a missing trait is zero). Use this for detailed conformation/linear/health-trait questions or 'everything about' an animal. NOTE: beef traits, non-return-rate, and udder-cleft-as-a-separate-score are NOT tracked in this system. LOOKUP FALLBACK: if the animal is NOT in the database and you were given a registration number, this pulls its profile LIVE from Lactanet (read-only, not saved) so you can still answer 'tell me about <reg>'. By name alone there is no external lookup — ask for the registration number. To SAVE an external animal, use import_animals.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Exact or partial animal name" }, reg: { type: "string", description: "Registration number (exact)" } } },
    run: async (input, ctx) => {
      const name = str(input.name), reg = str(input.reg);
      if (!name && !reg) return { summary: "Provide a name or registration number.", records: null };
      const a = await findAnimalFull(name, reg);
      if (a) {
        const profile = await buildFullProfile(a);
        return { summary: `Full profile for ${a.primaryName}: ${profile.preferredEvaluation?.traitCount ?? 0} traits on the preferred evaluation (${a.evaluations.length} rounds on file).`, records: profile };
      }
      // Not in the database. If we have a registration number, look it up LIVE on
      // Lactanet (read-only, not saved). A read-capable actor is required before
      // the external fetch. By name alone there's nothing to look up externally.
      if (reg) {
        requireCap(ctx, "animal:read", "look an animal up on Lactanet");
        return externalAnimalProfile(reg);
      }
      return { summary: `No animal named "${name}" is in your database. If you have its registration number (e.g. HOCANM13486161), give me that and I'll look it up on Lactanet.`, records: null };
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
    run: async (input, ctx) => {
      // A read-capable actor is required before any work: this tool can trigger a
      // live Lactanet fetch and (with saveToDatabase) a database write. Every real
      // role holds animal:read, so this only refuses a missing/blank-role caller.
      const actor = requireCap(ctx, "animal:read", "use the mating calculator");
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
        // Persisting an externally-pulled Lactanet animal creates an Animal + an
        // approved GeneticEvaluation — the same authority a proof import needs.
        // Gate it exactly like the import path (record:write) so a read-only role
        // can compute the PA but never write, and attribute the write to the actor.
        requireCap(ctx, "record:write", "save an externally looked-up animal to the database");
        const done: string[] = [];
        for (const p of [sire, dam]) {
          if (p.externallySourced && p._externalReg) {
            try {
              await persistExternal(p);
              await logAction(actor, "animal", "import_external", p._externalReg, { source: "lactanet", via: "calculate_mating_pa" });
              done.push(`${p.name ?? p._externalReg} (${p._externalReg})`);
            } catch (e) { done.push(`FAILED to save ${p._externalReg}: ${(e as Error).message}`); }
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

  // =========================================================================
  // WRITE TOOLS — everything a signed-in user can DO, gated by their role.
  // =========================================================================

  {
    name: "list_reference_data",
    description:
      "List the platform's setup/config data so you can find the exact id or code to pass to a write tool, or answer 'what X do we have'. kind: breeds | traits | sources | priority_rules | proof_files (Lactanet files available to import from) | users (needs the user:write permission) | pending_reviews (the import/record review queue; needs review:write). breeds/traits/sources/priority_rules/proof_files are readable by anyone. This is READ-ONLY.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["breeds", "traits", "sources", "priority_rules", "proof_files", "users", "pending_reviews"] },
        limit: { type: "integer", description: "max rows (default 100, max 200)" },
      },
      required: ["kind"],
    },
    run: async (input, ctx) => {
      const kind = str(input.kind);
      const take = clamp(input.limit, 1, 200, 100);
      switch (kind) {
        case "breeds": {
          const rows = await prisma.breed.findMany({ orderBy: { breedCode: "asc" }, select: { breedId: true, breedCode: true, breedName: true, speciesType: true, active: true } });
          return { summary: `${rows.length} breed(s).`, records: rows };
        }
        case "traits": {
          const rows = await prisma.traitDefinition.findMany({ orderBy: [{ displayOrder: "asc" }, { traitCode: "asc" }], take, select: { traitId: true, traitCode: true, traitName: true, domain: true, category: true, unit: true, higherIsBetter: true, active: true } });
          return { summary: `${rows.length} trait definition(s).`, records: rows };
        }
        case "sources": {
          const rows = await prisma.source.findMany({ orderBy: { defaultPriorityRank: "asc" }, select: { sourceId: true, sourceName: true, sourceType: true, defaultPriorityRank: true, active: true } });
          return { summary: `${rows.length} source(s).`, records: rows };
        }
        case "priority_rules": {
          const rows = await prisma.sourcePriorityRule.findMany({ orderBy: { priorityRank: "asc" }, select: { ruleId: true, dataDomain: true, priorityRank: true, countrySystem: true, active: true, source: { select: { sourceName: true } } } });
          return { summary: `${rows.length} priority rule(s).`, records: rows.map((r) => ({ ruleId: r.ruleId, dataDomain: r.dataDomain, source: r.source?.sourceName ?? null, priorityRank: r.priorityRank, countrySystem: r.countrySystem, active: r.active })) };
        }
        case "proof_files": {
          const { listProofFiles } = await import("@/lib/lactanet");
          const files = listProofFiles();
          return { summary: `${files.length} Lactanet proof file(s) available to import from.`, records: files };
        }
        case "users": {
          requireCap(ctx, "user:write", "list user accounts");
          const rows = await prisma.user.findMany({ orderBy: { email: "asc" }, select: { id: true, email: true, name: true, role: true, active: true } });
          return { summary: `${rows.length} user(s).`, records: rows };
        }
        case "pending_reviews": {
          requireCap(ctx, "review:write", "view the review queue");
          const rows = await prisma.importReviewQueue.findMany({ where: { status: "pending" }, orderBy: { createdAt: "desc" }, take, select: { reviewId: true, proposedRecordType: true, matchedAnimalId: true, status: true, createdAt: true } });
          return { summary: `${rows.length} pending review item(s).`, records: rows };
        }
        default:
          return { summary: `Unknown kind "${kind}".`, records: null };
      }
    },
  },

  {
    name: "create_or_update_animal",
    description:
      "CREATE a new animal or UPDATE an existing one's identity fields. To UPDATE, give animalId (or a name/reg that resolves to exactly one animal); to CREATE, omit all three and give primaryName. Fields: primaryName, shortName, sex ('M'|'F'), breedCode (e.g. HO/JE/AY/BS) or breedId, birthDate (yyyy-mm-dd), countryOfOrigin ('CA'|'US'|'INT'), currentStatus (active|proven|genomic|retired|reference), notes. Optional `identifiers`: array of { idType, idValue, isPrimary?, country?, org? }. IMPORTANT: on an UPDATE, supplying identifiers REPLACES the whole identifier list — include every one you want to keep. Mirrors the New/Edit Animal screens. Requires the animal:write permission. Does NOT touch proofs/classifications/milk — use the record tools for those.",
    input_schema: {
      type: "object",
      properties: {
        animalId: { type: "string", description: "Edit this animal (database id). Omit to create." },
        name: { type: "string", description: "Instead of animalId, resolve the animal to edit by name…" },
        reg: { type: "string", description: "…or by registration number." },
        primaryName: { type: "string" },
        shortName: { type: "string" },
        sex: { type: "string", enum: ["M", "F"] },
        breedCode: { type: "string" },
        breedId: { type: "string" },
        birthDate: { type: "string", description: "yyyy-mm-dd" },
        countryOfOrigin: { type: "string", enum: ["CA", "US", "INT"] },
        currentStatus: { type: "string" },
        notes: { type: "string" },
        identifiers: {
          type: "array",
          description: "REPLACES existing identifiers on update.",
          items: { type: "object", properties: { idType: { type: "string" }, idValue: { type: "string" }, isPrimary: { type: "boolean" }, country: { type: "string" }, org: { type: "string" } }, required: ["idValue"] },
        },
      },
    },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "animal:write", "add or edit animals");
      const editing = !!(str(input.animalId) || str(input.name) || str(input.reg));

      let breedId = str(input.breedId) || null;
      const breedCode = str(input.breedCode).toUpperCase();
      if (!breedId && breedCode) {
        const b = await prisma.breed.findUnique({ where: { breedCode }, select: { breedId: true } });
        if (!b) return { summary: `No breed with code "${breedCode}". Use list_reference_data (kind: breeds) to see valid codes.`, records: null };
        breedId = b.breedId;
      }

      const rawIds = Array.isArray(input.identifiers) ? (input.identifiers as Record<string, unknown>[]) : null;
      const identifiers = rawIds
        ? rawIds.map((r) => ({ idType: str(r.idType) || "internal_stud", idValue: str(r.idValue), issuingCountry: str(r.country) || null, issuingOrganization: str(r.org) || null, isPrimary: r.isPrimary === true, sourceId: null as string | null })).filter((r) => r.idValue)
        : null;
      if (identifiers && identifiers.length && !identifiers.some((r) => r.isPrimary)) identifiers[0].isPrimary = true;

      if (editing) {
        const target = await resolveAnimalId(input);
        if (!target) return { summary: `No animal found to edit for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
        const data: Record<string, unknown> = { updatedById: actor.uid };
        if (str(input.primaryName)) data.primaryName = str(input.primaryName);
        if (input.shortName !== undefined) data.shortName = str(input.shortName) || null;
        if (str(input.sex)) data.sex = str(input.sex);
        if (breedId) data.breedId = breedId;
        if (input.birthDate !== undefined) data.birthDate = toDate(input.birthDate);
        if (input.countryOfOrigin !== undefined) data.countryOfOrigin = str(input.countryOfOrigin) || null;
        if (str(input.currentStatus)) data.currentStatus = str(input.currentStatus);
        if (input.notes !== undefined) data.notes = str(input.notes) || null;
        await prisma.animal.update({ where: { id: target.id }, data: data as Prisma.AnimalUncheckedUpdateInput });
        if (identifiers) {
          await prisma.animalIdentifier.deleteMany({ where: { animalId: target.id } });
          for (const idf of identifiers) await prisma.animalIdentifier.create({ data: { animalId: target.id, ...idf } });
        }
        await logAction(actor, "animal", "update", target.id, { fields: Object.keys(data), identifiersReplaced: !!identifiers });
        return { summary: `Updated ${str(input.primaryName) || target.name}${identifiers ? ` and replaced its ${identifiers.length} identifier(s)` : ""}.`, records: { animalId: target.id, name: str(input.primaryName) || target.name } };
      }

      const primaryName = str(input.primaryName);
      if (!primaryName) return { summary: "primaryName is required to create a new animal.", records: null };
      const created = await prisma.animal.create({
        data: {
          primaryName, shortName: str(input.shortName) || null, sex: str(input.sex) || "F", breedId,
          birthDate: toDate(input.birthDate), countryOfOrigin: str(input.countryOfOrigin) || null,
          currentStatus: str(input.currentStatus) || "active", notes: str(input.notes) || null, createdById: actor.uid,
        },
      });
      for (const idf of identifiers ?? []) await prisma.animalIdentifier.create({ data: { animalId: created.id, ...idf } });
      await logAction(actor, "animal", "create", created.id, { primaryName });
      return { summary: `Created ${primaryName}${identifiers?.length ? ` with ${identifiers.length} identifier(s)` : ""}.`, records: { animalId: created.id, name: primaryName } };
    },
  },

  {
    name: "archive_animal",
    description: "ARCHIVE an animal: set its status to archived and remove it from the working lineup lists. This is a soft delete — its proofs and records are kept and an admin can restore it. DESTRUCTIVE: refuses unless confirm:true. Resolve by animalId, or name/reg. Requires animal:write.",
    input_schema: { type: "object", properties: { animalId: { type: "string" }, name: { type: "string" }, reg: { type: "string" }, confirm: { type: "boolean", description: "Set true ONLY after the user has agreed to archive this specific animal." } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "animal:write", "archive animals");
      const target = await resolveAnimalId(input);
      if (!target) return { summary: `No animal found to archive for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
      const gate = confirmGate(input, `Archive ${target.name} — it will be hidden from the lineup lists (its proofs and records are kept).`, { animalId: target.id, name: target.name });
      if (gate) return gate;
      await prisma.animal.update({ where: { id: target.id }, data: { archived: true, currentStatus: "archived", updatedById: actor.uid } });
      await logAction(actor, "animal", "archive", target.id);
      return { summary: `Archived ${target.name}.`, records: { animalId: target.id, name: target.name, archived: true } };
    },
  },

  {
    name: "add_animal_note",
    description: "Attach a free-text note to an animal (mating advice, a reminder, an observation). Resolve by animalId/name/reg. noteType optional (default general). Requires animal:write.",
    input_schema: { type: "object", properties: { animalId: { type: "string" }, name: { type: "string" }, reg: { type: "string" }, body: { type: "string" }, noteType: { type: "string" } }, required: ["body"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "animal:write", "add notes");
      const target = await resolveAnimalId(input);
      if (!target) return { summary: `No animal found for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
      const body = str(input.body);
      if (!body) return { summary: "The note body is empty.", records: null };
      await prisma.animalNote.create({ data: { animalId: target.id, body, noteType: str(input.noteType) || "general", createdById: actor.uid } });
      await logAction(actor, "animal_note", "create", target.id);
      return { summary: `Added a note to ${target.name}.`, records: { animalId: target.id, name: target.name } };
    },
  },

  {
    name: "add_proof",
    description:
      "Record a genetic evaluation (proof) for ONE animal by manual entry. Resolve the animal by animalId/name/reg. Give `traits` as an object of trait code → value, e.g. {\"LPI\":3200,\"CONF\":12,\"MILK\":900,\"FAT\":40}. Optional: evaluationDate (yyyy-mm-dd, default today), proofRun label (e.g. 'April 2026'), countrySystem, reliability, approvalStatus (approved|pending, default approved), notes. Requires record:write; recomputes the animal's preferred evaluation. NOTE: to pull OFFICIAL Lactanet proofs use import_bulls instead of typing them in.",
    input_schema: {
      type: "object",
      properties: {
        animalId: { type: "string" }, name: { type: "string" }, reg: { type: "string" },
        traits: { type: "object", description: "trait code → numeric (or text) value", additionalProperties: true },
        evaluationDate: { type: "string" }, proofRun: { type: "string" }, countrySystem: { type: "string" },
        reliability: { type: "number" }, approvalStatus: { type: "string", enum: ["approved", "pending"] }, notes: { type: "string" },
      },
      required: ["traits"],
    },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:write", "add proof records");
      const target = await resolveAnimalId(input);
      if (!target) return { summary: `No animal found for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
      const traitsIn = input.traits && typeof input.traits === "object" && !Array.isArray(input.traits) ? (input.traits as Record<string, unknown>) : {};
      const raw: RawTrait[] = Object.entries(traitsIn)
        .map(([code, value]) => {
          const asNum = Number(value);
          const isNum = value !== "" && value != null && !isNaN(asNum);
          return { traitCode: code.toUpperCase(), numericValue: isNum ? asNum : null, textValue: !isNum && value != null && value !== "" ? String(value) : null, reliability: null, percentileRank: null };
        })
        .filter((t) => t.numericValue != null || t.textValue != null);
      if (!raw.length) return { summary: "No usable trait values were given.", records: null };
      const packed = packTraits(raw);
      const approvalStatus = str(input.approvalStatus) === "pending" ? "pending" : "approved";
      const rec = await prisma.geneticEvaluation.create({
        data: {
          animalId: target.id, evaluationDate: toDate(input.evaluationDate) ?? new Date(),
          proofRun: str(input.proofRun) || null, countrySystem: str(input.countrySystem) || null,
          reliabilityOverall: toNum(input.reliability), approvalStatus,
          approvedById: approvalStatus === "approved" ? actor.uid : null, approvedAt: approvalStatus === "approved" ? new Date() : null,
          createdById: actor.uid, notes: str(input.notes) || null, traitsJson: packed.traitsJson, ...packed.columns,
        },
      });
      await recomputePreferred(target.id);
      await logAction(actor, "genetic_evaluation", "create", rec.evaluationId, { animalId: target.id, traits: raw.length });
      return { summary: `Recorded a proof for ${target.name} with ${raw.length} trait(s).`, records: { evaluationId: rec.evaluationId, animalId: target.id, name: target.name, traits: raw.length } };
    },
  },

  {
    name: "add_milk_record",
    description: "Record a lactation / milk record for a cow. Resolve by animalId/name/reg. Fields: recordDate (yyyy-mm-dd, default today), lactationNumber, calvingDate, daysInMilk, milkAmount, milkUnit (default kg), fatAmount, fatPercent, proteinAmount, proteinPercent, recordType, completionStatus, approvalStatus (approved|pending). Requires record:write.",
    input_schema: {
      type: "object",
      properties: {
        animalId: { type: "string" }, name: { type: "string" }, reg: { type: "string" },
        recordDate: { type: "string" }, lactationNumber: { type: "number" }, calvingDate: { type: "string" },
        daysInMilk: { type: "number" }, milkAmount: { type: "number" }, milkUnit: { type: "string" },
        fatAmount: { type: "number" }, fatPercent: { type: "number" }, proteinAmount: { type: "number" }, proteinPercent: { type: "number" },
        recordType: { type: "string" }, completionStatus: { type: "string" }, approvalStatus: { type: "string", enum: ["approved", "pending"] }, notes: { type: "string" },
      },
    },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:write", "add milk records");
      const target = await resolveAnimalId(input);
      if (!target) return { summary: `No animal found for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
      const approvalStatus = str(input.approvalStatus) === "pending" ? "pending" : "approved";
      const rec = await prisma.milkRecord.create({
        data: {
          animalId: target.id, recordDate: toDate(input.recordDate) ?? new Date(), lactationNumber: toNum(input.lactationNumber),
          calvingDate: toDate(input.calvingDate), daysInMilk: toNum(input.daysInMilk), milkAmount: toNum(input.milkAmount),
          milkUnit: str(input.milkUnit) || "kg", fatAmount: toNum(input.fatAmount), fatPercent: toNum(input.fatPercent),
          proteinAmount: toNum(input.proteinAmount), proteinPercent: toNum(input.proteinPercent),
          recordType: str(input.recordType) || null, completionStatus: str(input.completionStatus) || null,
          approvalStatus, approvedById: approvalStatus === "approved" ? actor.uid : null, approvedAt: approvalStatus === "approved" ? new Date() : null,
          createdById: actor.uid, notes: str(input.notes) || null,
        },
      });
      await recomputePreferred(target.id);
      await logAction(actor, "milk_record", "create", rec.milkRecordId, { animalId: target.id });
      return { summary: `Recorded a milk record for ${target.name}.`, records: { milkRecordId: rec.milkRecordId, animalId: target.id, name: target.name } };
    },
  },

  {
    name: "add_classification",
    description: "Record a classification for a cow. Resolve by animalId/name/reg. Fields: classificationDate (yyyy-mm-dd, default today), finalScore, classificationCode (EX|VG|GP|G...), lactationNumber, ageAtClassification, approvalStatus (approved|pending). Optional `traits`: object of classification trait code → value (linear/section scores). Requires record:write.",
    input_schema: {
      type: "object",
      properties: {
        animalId: { type: "string" }, name: { type: "string" }, reg: { type: "string" },
        classificationDate: { type: "string" }, finalScore: { type: "number" }, classificationCode: { type: "string" },
        lactationNumber: { type: "number" }, ageAtClassification: { type: "string" }, approvalStatus: { type: "string", enum: ["approved", "pending"] },
        traits: { type: "object", description: "classification trait code → value", additionalProperties: true }, notes: { type: "string" },
      },
    },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:write", "add classifications");
      const target = await resolveAnimalId(input);
      if (!target) return { summary: `No animal found for ${str(input.animalId) || str(input.reg) || str(input.name)}.`, records: null };
      const approvalStatus = str(input.approvalStatus) === "pending" ? "pending" : "approved";
      const rec = await prisma.classificationRecord.create({
        data: {
          animalId: target.id, classificationDate: toDate(input.classificationDate) ?? new Date(),
          lactationNumber: toNum(input.lactationNumber), ageAtClassification: str(input.ageAtClassification) || null,
          finalScore: toNum(input.finalScore), classificationCode: str(input.classificationCode) || null,
          approvalStatus, approvedById: approvalStatus === "approved" ? actor.uid : null, approvedAt: approvalStatus === "approved" ? new Date() : null,
          createdById: actor.uid, notes: str(input.notes) || null,
        },
      });
      const traitsIn = input.traits && typeof input.traits === "object" && !Array.isArray(input.traits) ? (input.traits as Record<string, unknown>) : {};
      if (Object.keys(traitsIn).length) {
        const defs = new Map((await prisma.traitDefinition.findMany({ where: { domain: "classification" } })).map((t) => [t.traitCode, t]));
        for (const [code, value] of Object.entries(traitsIn)) {
          if (value == null || value === "") continue;
          const def = defs.get(code);
          await prisma.classificationTraitValue.create({ data: { classificationId: rec.classificationId, traitCode: code, traitName: def?.traitName ?? code, traitValue: String(value), displayOrder: def?.displayOrder ?? 0 } });
        }
      }
      await recomputePreferred(target.id);
      await logAction(actor, "classification", "create", rec.classificationId, { animalId: target.id });
      return { summary: `Recorded a classification for ${target.name}.`, records: { classificationId: rec.classificationId, animalId: target.id, name: target.name } };
    },
  },

  {
    name: "manage_breed",
    description: "Create or update a breed. Give breedId to update, omit to create. Fields: breedCode (required, e.g. HO), breedName (required), speciesType (dairy|beef, default dairy), breedCategory, registryOrganization, active, notes. Requires the config:write permission (admin).",
    input_schema: { type: "object", properties: { breedId: { type: "string" }, breedCode: { type: "string" }, breedName: { type: "string" }, speciesType: { type: "string" }, breedCategory: { type: "string" }, registryOrganization: { type: "string" }, active: { type: "boolean" }, notes: { type: "string" } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "config:write", "manage breeds");
      const breedId = str(input.breedId);
      const data = {
        breedCode: str(input.breedCode).toUpperCase(), breedName: str(input.breedName), speciesType: str(input.speciesType) || "dairy",
        breedCategory: str(input.breedCategory) || null, registryOrganization: str(input.registryOrganization) || null,
        active: input.active === undefined ? true : input.active === true, notes: str(input.notes) || null,
      };
      if (!data.breedCode || !data.breedName) return { summary: "Breed code and name are required.", records: null };
      const rec = breedId ? await prisma.breed.update({ where: { breedId }, data }) : await prisma.breed.create({ data });
      await logAction(actor, "breed", breedId ? "update" : "create", rec.breedId, data);
      return { summary: `${breedId ? "Updated" : "Created"} breed ${data.breedCode} (${data.breedName}).`, records: { breedId: rec.breedId, breedCode: data.breedCode } };
    },
  },

  {
    name: "manage_trait",
    description: "Create or update a trait definition. Give traitId to update, omit to create. Fields: traitCode (required), traitName (required), speciesType (default dairy), domain (genetic|classification, default genetic), category, unit, higherIsBetter (bool), description, displayOrder, active. Requires config:write (admin).",
    input_schema: { type: "object", properties: { traitId: { type: "string" }, traitCode: { type: "string" }, traitName: { type: "string" }, speciesType: { type: "string" }, domain: { type: "string" }, category: { type: "string" }, unit: { type: "string" }, higherIsBetter: { type: "boolean" }, description: { type: "string" }, displayOrder: { type: "number" }, active: { type: "boolean" } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "config:write", "manage traits");
      const traitId = str(input.traitId);
      const data = {
        traitCode: str(input.traitCode).toUpperCase(), traitName: str(input.traitName), speciesType: str(input.speciesType) || "dairy",
        domain: str(input.domain) || "genetic", category: str(input.category) || null, unit: str(input.unit) || null,
        higherIsBetter: input.higherIsBetter === undefined ? true : input.higherIsBetter === true, description: str(input.description) || null,
        displayOrder: toNum(input.displayOrder) ?? 0, active: input.active === undefined ? true : input.active === true,
      };
      if (!data.traitCode || !data.traitName) return { summary: "Trait code and name are required.", records: null };
      const rec = traitId ? await prisma.traitDefinition.update({ where: { traitId }, data }) : await prisma.traitDefinition.create({ data });
      await logAction(actor, "trait_definition", traitId ? "update" : "create", rec.traitId, data);
      return { summary: `${traitId ? "Updated" : "Created"} trait ${data.traitCode} (${data.traitName}).`, records: { traitId: rec.traitId, traitCode: data.traitCode } };
    },
  },

  {
    name: "manage_source",
    description: "Create or update a data source. Give sourceId to update, omit to create. Fields: sourceName (required), sourceType (default manual), baseUrl, defaultPriorityRank (default 50), active, notes. Requires config:write (admin).",
    input_schema: { type: "object", properties: { sourceId: { type: "string" }, sourceName: { type: "string" }, sourceType: { type: "string" }, baseUrl: { type: "string" }, defaultPriorityRank: { type: "number" }, active: { type: "boolean" }, notes: { type: "string" } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "config:write", "manage sources");
      const sourceId = str(input.sourceId);
      const data = {
        sourceName: str(input.sourceName), sourceType: str(input.sourceType) || "manual", baseUrl: str(input.baseUrl) || null,
        defaultPriorityRank: toNum(input.defaultPriorityRank) ?? 50, active: input.active === undefined ? true : input.active === true, notes: str(input.notes) || null,
      };
      if (!data.sourceName) return { summary: "Source name is required.", records: null };
      const rec = sourceId ? await prisma.source.update({ where: { sourceId }, data }) : await prisma.source.create({ data });
      await logAction(actor, "source", sourceId ? "update" : "create", rec.sourceId, data);
      return { summary: `${sourceId ? "Updated" : "Created"} source ${data.sourceName}.`, records: { sourceId: rec.sourceId, sourceName: data.sourceName } };
    },
  },

  {
    name: "manage_priority_rule",
    description: "Create, update, or delete a source-priority rule (which source wins for a data domain). action: save (default) or delete. For save: sourceId (required), dataDomain (default genetic_evaluation), priorityRank (1 = most preferred), breedId, countrySystem, active; give ruleId to update. For delete: ruleId + confirm:true (DESTRUCTIVE). Requires config:write (admin).",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["save", "delete"] }, ruleId: { type: "string" }, sourceId: { type: "string" }, dataDomain: { type: "string" }, priorityRank: { type: "number" }, breedId: { type: "string" }, countrySystem: { type: "string" }, active: { type: "boolean" }, confirm: { type: "boolean" } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "config:write", "manage priority rules");
      if (str(input.action) === "delete") {
        const ruleId = str(input.ruleId);
        if (!ruleId) return { summary: "ruleId is required to delete a rule.", records: null };
        const gate = confirmGate(input, `Delete source-priority rule ${ruleId}.`, { ruleId });
        if (gate) return gate;
        await prisma.sourcePriorityRule.delete({ where: { ruleId } });
        await logAction(actor, "priority_rule", "delete", ruleId);
        return { summary: `Deleted priority rule ${ruleId}.`, records: { ruleId, deleted: true } };
      }
      const ruleId = str(input.ruleId);
      const sourceId = str(input.sourceId);
      if (!sourceId) return { summary: "sourceId is required. Use list_reference_data (kind: sources) to find it.", records: null };
      const data = { dataDomain: str(input.dataDomain) || "genetic_evaluation", sourceId, priorityRank: toNum(input.priorityRank) ?? 99, breedId: str(input.breedId) || null, countrySystem: str(input.countrySystem) || null, active: input.active === undefined ? true : input.active === true };
      const rec = ruleId ? await prisma.sourcePriorityRule.update({ where: { ruleId }, data }) : await prisma.sourcePriorityRule.create({ data });
      await logAction(actor, "priority_rule", ruleId ? "update" : "create", rec.ruleId, data);
      return { summary: `${ruleId ? "Updated" : "Created"} a priority rule.`, records: { ruleId: rec.ruleId } };
    },
  },

  {
    name: "manage_user",
    description:
      "Create or update a user account. Give id to update, omit to create. Fields: email (required for create), name, role (admin|staff|sales|consultant), active, password. SECURITY: any password typed here appears in the chat transcript — prefer the Admin > Users screen for setting passwords, and use this mainly to change a user's role or active flag, or to create an account you'll have them reset. Requires the user:write permission (admin).",
    input_schema: { type: "object", properties: { id: { type: "string" }, email: { type: "string" }, name: { type: "string" }, role: { type: "string", enum: ["admin", "staff", "sales", "consultant"] }, active: { type: "boolean" }, password: { type: "string" } } },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "user:write", "manage user accounts");
      const id = str(input.id);
      const role = str(input.role) || "sales";
      if (!(role in ROLES)) return { summary: `Invalid role "${role}". Valid: ${Object.keys(ROLES).join(", ")}.`, records: null };
      const active = input.active === undefined ? true : input.active === true;
      const password = str(input.password);
      if (password && password.length < 8) return { summary: "Password must be at least 8 characters.", records: null };
      const { hashPassword } = await import("@/lib/auth");
      if (id) {
        const data: Record<string, unknown> = { name: str(input.name) || undefined, role, active };
        if (str(input.name)) data.name = str(input.name);
        if (password) data.passwordHash = hashPassword(password);
        await prisma.user.update({ where: { id }, data: data as Prisma.UserUncheckedUpdateInput });
        await logAction(actor, "user", "update", id, { role, active, passwordChanged: !!password });
        return { summary: `Updated user ${id} (role ${role}, ${active ? "active" : "inactive"}${password ? ", password changed" : ""}).`, records: { id, role, active } };
      }
      const email = str(input.email).toLowerCase();
      const name = str(input.name);
      if (!email || !name || !password) return { summary: "Email, name, and password are all required to create a new user.", records: null };
      const created = await prisma.user.create({ data: { email, name, role, active, passwordHash: hashPassword(password) } });
      await logAction(actor, "user", "create", created.id, { email, name, role, active });
      return { summary: `Created user ${name} <${email}> as ${role}.`, records: { id: created.id, email, role } };
    },
  },

  {
    name: "delete_user",
    description: "Permanently delete a user account. DESTRUCTIVE and irreversible: refuses unless confirm:true. You cannot delete the account you are signed in as, and a user who owns records can't be deleted (set them inactive with manage_user instead). Requires user:write (admin).",
    input_schema: { type: "object", properties: { id: { type: "string" }, confirm: { type: "boolean" } }, required: ["id"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "user:write", "delete user accounts");
      const id = str(input.id);
      if (!id) return { summary: "No user id given.", records: null };
      if (actor.uid === id) return { summary: "You can't delete the account you're signed in as.", records: null };
      const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true } });
      if (!target) return { summary: `No user with id ${id}.`, records: null };
      const gate = confirmGate(input, `Permanently delete user ${target.name} <${target.email}>.`, { id: target.id, email: target.email });
      if (gate) return gate;
      try {
        await prisma.user.delete({ where: { id } });
      } catch {
        return { summary: `${target.name} has linked records and can't be deleted. Set them inactive instead (manage_user with active:false).`, records: { id, deleted: false } };
      }
      await logAction(actor, "user", "delete", id, { email: target.email, name: target.name });
      return { summary: `Deleted user ${target.name} <${target.email}>.`, records: { id, deleted: true } };
    },
  },

  {
    name: "manage_agent_settings",
    description:
      "View or change the Genetics Agent's own settings. action: status (show whether a key is set — masked — and the model), set_model (change the model id), or clear_key (turn the assistant off; DESTRUCTIVE, needs confirm:true). You CANNOT set a new API key here — a key must never be pasted into chat; direct the admin to Admin > Settings to paste it. Requires config:write (admin).",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["status", "set_model", "clear_key"] }, model: { type: "string" }, confirm: { type: "boolean" } }, required: ["action"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "config:write", "manage agent settings");
      const action = str(input.action);
      if (action === "status") {
        const rows = await prisma.environmentConfig.findMany({ where: { key: { in: ["agent.anthropicApiKey", "agent.model"] } } });
        const map = new Map(rows.map((r) => [r.key, r.value]));
        const envKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
        const key = (map.get("agent.anthropicApiKey") ?? "").trim() || envKey;
        return { summary: `Agent ${key ? "is configured" : "is NOT configured"}. Model: ${map.get("agent.model") || "claude-sonnet-5"}.`, records: { configured: !!key, keyHint: maskKey(key), model: map.get("agent.model") || "claude-sonnet-5", keySource: (map.get("agent.anthropicApiKey") ?? "").trim() ? "settings" : envKey ? "env" : null } };
      }
      if (action === "set_model") {
        const model = str(input.model);
        if (!model) return { summary: "Provide a model id to set.", records: null };
        await prisma.environmentConfig.upsert({ where: { key: "agent.model" }, update: { value: model }, create: { key: "agent.model", value: model, notes: "Model id for the Genetics Intelligence Agent" } });
        await logAction(actor, "config", "update", "agent.model", { model });
        return { summary: `Agent model set to ${model}.`, records: { model } };
      }
      if (action === "clear_key") {
        const gate = confirmGate(input, "Clear the Anthropic API key — this turns the Genetics Assistant OFF for everyone until an admin pastes a new key in Admin > Settings.");
        if (gate) return gate;
        await prisma.environmentConfig.deleteMany({ where: { key: "agent.anthropicApiKey" } });
        await logAction(actor, "config", "update", "agent.anthropicApiKey", { cleared: true });
        return { summary: "Cleared the stored API key. The assistant is now off until a new key is saved in Admin > Settings.", records: { cleared: true } };
      }
      return { summary: `Unknown action "${action}".`, records: null };
    },
  },

  {
    name: "import_bulls",
    description:
      "Import official proofs from a Lactanet proof file into the platform. mode: reg (one bull by registration or NAAB code — needs `query`), topN (the top `limit` bulls by a column such as LPI — needs `sortCol` and `limit`), or mass (EVERY bull in the file, ~99,000 — heavy; needs confirm:true). All modes need `fileName` (use list_reference_data kind: proof_files to see valid names). IMPORTANT: imports are written as PENDING and go to the review queue — an ADMIN must approve them with resolve_import before they become authoritative (nothing is silently added to the live lineup). Requires the record:write permission.",
    input_schema: { type: "object", properties: { mode: { type: "string", enum: ["reg", "topN", "mass"] }, fileName: { type: "string" }, query: { type: "string", description: "reg mode: a registration or NAAB code" }, sortCol: { type: "string", description: "topN mode: column to rank by, e.g. LPI" }, limit: { type: "integer", description: "topN mode: how many (max 200)" }, confirm: { type: "boolean", description: "required for mass mode" } }, required: ["mode", "fileName"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:write", "import proofs");
      const su: SessionUser = { uid: actor.uid, email: "", name: actor.name, role: actor.role };
      const mode = str(input.mode);
      const { safeProofFileName, resolveProofFile, findBull, topBulls } = await import("@/lib/lactanet");
      const { persistBull } = await import("@/lib/proof-import");
      const { createImportReview } = await import("@/lib/import-staging");
      const fileName = safeProofFileName(str(input.fileName));
      if (!fileName || !resolveProofFile(str(input.fileName))) return { summary: "Choose a valid proof file from list_reference_data (kind: proof_files).", records: null };
      const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });

      if (mode === "mass") {
        const gate = confirmGate(input, `Stage a MASS import of ALL bulls (~99,000) in ${fileName}. It will be queued and an admin must approve it in the review queue.`, { fileName });
        if (gate) return gate;
        const manifest: ImportManifest = { kind: "proof", mode: "all", label: `Mass import — ALL bulls in ${fileName} (~99,000)`, fileName, animals: [] };
        const reviewId = await createImportReview({ userId: su.uid, kind: "proof", captureType: "csv", sourceName: "LactanetGen", notes: `Mass proof import request: ALL bulls in ${fileName}`, manifest });
        await logAction(actor, "import_batch", "stage", reviewId, { mass: fileName });
        return { summary: `Queued a mass import of ${fileName}. An admin approves it in the review queue.`, records: { reviewId, mode: "mass", fileName } };
      }

      if (mode === "reg") {
        const query = str(input.query);
        if (!query) return { summary: "reg mode needs a registration or NAAB code in `query`.", records: null };
        const bull = await findBull(fileName, query);
        if (!bull) return { summary: `No bull found for "${query}" in ${fileName}.`, records: null };
        const capture = await prisma.sourceCapture.create({ data: { sourceId: source?.sourceId, captureType: "csv", originalFileName: fileName, capturedById: su.uid, extractionStatus: "extracted", confidenceScore: 1, notes: `Proof import (pending review): ${bull.registrationNumber} from ${fileName}` } });
        const { animalId, created, evaluationId } = await persistBull(bull, { sourceId: source?.sourceId ?? null, captureId: capture.captureId, userId: su.uid, fileName, approvalStatus: "pending" });
        await prisma.sourceCapture.update({ where: { captureId: capture.captureId }, data: { animalId } });
        const animals: ImportAnimalRef[] = [{ reg: bull.registrationNumber, animalId, created, evaluationId, name: bull.registeredName }];
        const manifest: ImportManifest = { kind: "proof", mode: "reg", label: `Proof import: ${bull.registeredName} (${bull.registrationNumber}) from ${fileName}`, fileName, count: 1, animals };
        const reviewId = await createImportReview({ userId: su.uid, kind: "proof", captureType: "csv", captureId: capture.captureId, manifest });
        await logAction(actor, "import_batch", "stage", reviewId, { reg: bull.registrationNumber });
        return { summary: `Staged ${bull.registeredName} (${bull.registrationNumber}) as pending — an admin approves it in the review queue.`, records: { reviewId, mode: "reg", name: bull.registeredName, reg: bull.registrationNumber, created } };
      }

      if (mode === "topN") {
        const sortCol = str(input.sortCol).replace(/[^A-Za-z0-9$%_ -]/g, "").slice(0, 40) || "LPI";
        const limit = clamp(input.limit, 1, 200, 10);
        const bulls = await topBulls(fileName, sortCol, limit);
        if (!bulls.length) return { summary: `No bulls returned from ${fileName} sorted by ${sortCol}.`, records: null };
        const capture = await prisma.sourceCapture.create({ data: { sourceId: source?.sourceId, captureType: "csv", originalFileName: fileName, capturedById: su.uid, extractionStatus: "extracted", confidenceScore: 1, notes: `Proof import (pending review): top ${limit} by ${sortCol} from ${fileName}` } });
        const animals: ImportAnimalRef[] = [];
        for (const bull of bulls) {
          const { animalId, created, evaluationId } = await persistBull(bull, { sourceId: source?.sourceId ?? null, captureId: capture.captureId, userId: su.uid, fileName, approvalStatus: "pending" });
          animals.push({ reg: bull.registrationNumber, animalId, created, evaluationId, name: bull.registeredName });
        }
        const manifest: ImportManifest = { kind: "proof", mode: "topN", label: `Proof import: top ${animals.length} by ${sortCol} from ${fileName}`, fileName, count: animals.length, animals };
        const reviewId = await createImportReview({ userId: su.uid, kind: "proof", captureType: "csv", captureId: capture.captureId, manifest });
        await logAction(actor, "import_batch", "stage", reviewId, { bulk: animals.length, sortCol });
        return { summary: `Staged the top ${animals.length} bulls by ${sortCol} from ${fileName} as pending — an admin approves them in the review queue.`, records: { reviewId, mode: "topN", count: animals.length, sortCol } };
      }

      return { summary: `Unknown mode "${mode}". Use reg, topN, or mass.`, records: null };
    },
  },

  {
    name: "resolve_import",
    description:
      "Act on a staged batch import in the review queue (created by import_bulls). action: approve (promote the pending records / start the mass job), deny (delete the records the import wrote — DESTRUCTIVE, needs confirm:true), or restore (bring back a denied import). Needs reviewId (from list_reference_data kind: pending_reviews). Requires the record:approve permission (admin only).",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["approve", "deny", "restore"] }, reviewId: { type: "string" }, confirm: { type: "boolean" } }, required: ["action", "reviewId"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:approve", "approve or deny imports");
      const su: SessionUser = { uid: actor.uid, email: "", name: actor.name, role: actor.role };
      const reviewId = str(input.reviewId);
      const action = str(input.action);
      if (!reviewId) return { summary: "reviewId is required.", records: null };
      const { approveImportReview, denyImportReview, restoreImportReview } = await import("@/lib/import-staging");
      if (action === "deny") {
        const gate = confirmGate(input, `Deny import ${reviewId} — this DELETES the records that import wrote.`, { reviewId });
        if (gate) return gate;
        const res = await denyImportReview(reviewId, su);
        return { summary: res.message, records: { reviewId, ok: res.ok, action } };
      }
      if (action === "restore") {
        const res = await restoreImportReview(reviewId, su);
        return { summary: res.message, records: { reviewId, ok: res.ok, action } };
      }
      const res = await approveImportReview(reviewId, su);
      return { summary: res.message, records: { reviewId, ok: res.ok, action: "approve" } };
    },
  },

  {
    name: "resolve_review_item",
    description:
      "Work a per-record item in the review queue (an uploaded/extracted proof, milk record, classification, animal or identifier — NOT a batch import, which uses resolve_import). action: approve (materialize it into a real record and link it to the source), set_status (pending|rejected|needs_more_info|duplicate|conflict_review), or update (edit its extractedDataJson, matchedAnimalId, or reviewNotes before deciding). Needs reviewId. Requires the review:write permission.",
    input_schema: { type: "object", properties: { action: { type: "string", enum: ["approve", "set_status", "update"] }, reviewId: { type: "string" }, status: { type: "string" }, extractedDataJson: { type: "string" }, matchedAnimalId: { type: "string" }, reviewNotes: { type: "string" } }, required: ["action", "reviewId"] },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "review:write", "work the review queue");
      const su: SessionUser = { uid: actor.uid, email: "", name: actor.name, role: actor.role };
      const reviewId = str(input.reviewId);
      if (!reviewId) return { summary: "reviewId is required.", records: null };
      const row = await prisma.importReviewQueue.findUnique({ where: { reviewId }, select: { proposedRecordType: true } });
      if (!row) return { summary: "Review item not found.", records: null };
      if (isBatchImportType(row.proposedRecordType)) return { summary: "That is a batch import — use resolve_import (approve/deny) instead.", records: null };
      const action = str(input.action);

      if (action === "update") {
        const extractedDataJson = str(input.extractedDataJson);
        if (extractedDataJson) { try { JSON.parse(extractedDataJson); } catch { return { summary: "extractedDataJson must be valid JSON.", records: null }; } }
        await prisma.importReviewQueue.update({ where: { reviewId }, data: { extractedDataJson: extractedDataJson || undefined, matchedAnimalId: str(input.matchedAnimalId) || null, reviewNotes: str(input.reviewNotes) || null } });
        return { summary: `Updated review item ${reviewId}.`, records: { reviewId } };
      }
      if (action === "set_status") {
        const status = str(input.status);
        const valid = ["pending", "rejected", "needs_more_info", "duplicate", "conflict_review"];
        if (!valid.includes(status)) return { summary: `Invalid status. Use one of: ${valid.join(", ")} (to finalize into a record, use action approve).`, records: null };
        await prisma.importReviewQueue.update({ where: { reviewId }, data: { status, reviewedById: actor.uid, reviewedAt: new Date(), reviewNotes: str(input.reviewNotes) || undefined } });
        await logAction(actor, "review_item", status, reviewId);
        return { summary: `Set review item ${reviewId} to ${status}.`, records: { reviewId, status } };
      }
      // approve → materialize
      const { applyReviewApproval } = await import("@/lib/review-apply");
      const { targetAnimalId, proposedRecordType } = await applyReviewApproval(reviewId, su);
      await logAction(actor, "review_item", "approve", reviewId, { proposedRecordType, targetAnimalId });
      return { summary: `Approved review item ${reviewId} — created a ${proposedRecordType}${targetAnimalId ? " and linked it to the animal" : ""}.`, records: { reviewId, proposedRecordType, targetAnimalId } };
    },
  },

  {
    name: "import_animals",
    description:
      "Import whole animal(s) from Lactanet BY REGISTRATION NUMBER — fetches each animal's Lactanet profile (identity, evaluation, pedigree, classifications) and SAVES it to the database. `regs`: registration numbers (e.g. HOCANM13486161) as an array, or a pasted block of text (registrations are extracted from it). Up to " + LARGE_ANIMAL_IMPORT + " at a time here — for a larger list use the Animal Import page (it streams progress and has a longer timeout). By default animals are added directly (immediately usable); set review:true to stage them as pending for an admin to approve instead. Fetches live from Lactanet AND writes to the database, so it refuses until confirm:true — tell the user which / how many first. Requires the record:write permission. (For proofs from a Lactanet CSV file use import_bulls; to just VIEW an animal without saving, use get_animal_full_profile.)",
    input_schema: {
      type: "object",
      properties: {
        regs: { type: "array", items: { type: "string" }, description: "registration numbers, or pass a pasted block as one string" },
        review: { type: "boolean", description: "stage as pending for admin approval instead of importing directly" },
        confirm: { type: "boolean", description: "set true ONLY after the user agrees to import these animals" },
      },
      required: ["regs"],
    },
    run: async (input, ctx) => {
      const actor = requireCap(ctx, "record:write", "import animals");
      const raw = Array.isArray(input.regs) ? (input.regs as unknown[]).map((x) => str(x)).join("\n") : str(input.regs);
      const found = raw.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{3}[MF]\d{4,}\b/g) ?? [];
      const regs = [...new Set(found.map((s) => s.trim()))];
      if (!regs.length) return { summary: "No valid registration numbers found (expected e.g. HOCANM13486161).", records: null };
      if (regs.length > LARGE_ANIMAL_IMPORT) {
        return { summary: `That's ${regs.length} animals — more than I import from chat (${LARGE_ANIMAL_IMPORT} max, so the request can't time out). For a larger batch use the Animal Import page: it streams progress and routes big imports through admin review.`, records: { tooMany: true, count: regs.length, max: LARGE_ANIMAL_IMPORT } };
      }
      const doReview = input.review === true;
      const gate = confirmGate(input, `Import ${regs.length} animal(s) from Lactanet (${regs.join(", ")})${doReview ? " — staged as PENDING for admin review" : " — added directly to the database"}.`, { regs, count: regs.length, review: doReview });
      if (gate) return gate;

      const { ingestLactanetReg } = await import("@/lib/lactanet-ingest");
      let ok = 0, fail = 0, created = 0;
      const manifest: { reg: string; animalId: string; created: boolean; evaluationId: string | null; name: string | null }[] = [];
      const results: { reg: string; ok: boolean; name: string | null; created: boolean; traits: number; error?: string }[] = [];
      for (const reg of regs) {
        let outcome: Awaited<ReturnType<typeof ingestLactanetReg>>;
        try { outcome = await ingestLactanetReg(reg, actor.uid, { pending: doReview }); }
        catch (e) { outcome = { reg, ok: false, error: String((e as Error)?.message ?? e) }; }
        if (outcome.ok) {
          ok++;
          if (outcome.created) created++;
          if (doReview && outcome.animalId) manifest.push({ reg: outcome.reg, animalId: outcome.animalId, created: !!outcome.created, evaluationId: outcome.evaluationId ?? null, name: outcome.name ?? null });
        } else fail++;
        results.push({ reg: outcome.reg, ok: outcome.ok, name: outcome.name ?? null, created: !!outcome.created, traits: outcome.traitCount ?? 0, error: outcome.error });
      }

      let reviewId: string | null = null;
      let reviewError: string | null = null;
      if (doReview && manifest.length) {
        try {
          const { createImportReview } = await import("@/lib/import-staging");
          reviewId = await createImportReview({ userId: actor.uid, kind: "animal", captureType: "lactanet_query", sourceName: "LactanetGen", manifest: { kind: "animal", mode: "paste", label: `Animal import: ${manifest.length} animal(s) from Lactanet`, count: manifest.length, animals: manifest } });
        } catch (e) { reviewError = String((e as Error)?.message ?? e); }
      }
      await logAction(actor, "import_batch", doReview ? "stage" : "import", reviewId ?? undefined, { kind: "animal", regs: regs.length, ok, created });
      // Only claim "staged for review" when a queue row actually exists. If it
      // failed, the records are pending with no approval path — surface that
      // rather than falsely reporting success (mirrors /api/lactanet/import).
      const tail = !doReview
        ? ""
        : reviewId
          ? " Staged as pending — an admin approves them in the review queue."
          : manifest.length
            ? ` WARNING: the records were written as pending, but the review-queue row could NOT be created (${reviewError}), so an admin needs to clean them up manually.`
            : "";
      return { summary: `Imported ${ok} of ${regs.length} animal(s) from Lactanet${created ? ` (${created} new)` : ""}${fail ? `, ${fail} failed` : ""}.${tail}`, records: { ok, fail, created, review: doReview, reviewId, reviewError, results } };
    },
  },
];

export const AGENT_TOOL_MAP = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
