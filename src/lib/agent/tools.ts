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
import { US_CHANGE_TRAITS, usRoundLabel } from "@/lib/us-cdcb/proof-change";
import { US_KEY_TRAITS } from "@/lib/us-cdcb/key-traits";
import { CDCB_BREEDS } from "@/lib/us-cdcb/file-kind";
import { maskKey } from "./config";
// stage-record is server-only — imported dynamically at its call sites (below)
// so this module stays importable by the plain-tsx unit test, like every other
// server-only dependency here.
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

// Friendly trait name → indexed GeneticEvaluation column. CANADIAN vocabulary:
// LPI, Pro$, Conformation — EBVs in KILOGRAMS. The American equivalent is
// US_TRAIT_COL far below, and the two must never resolve into each other.
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
  pedigreeRefs: { select: { notes: true } },
  evaluations: {
    orderBy: { evaluationDate: "desc" },
    select: {
      proofRun: true, evaluationDate: true, countrySystem: true, reliabilityOverall: true,
      daughters: true, herds: true, genotyped: true, activityCode: true, officialCode: true, runKind: true, sireType: true, isPreferred: true, traitsJson: true, lpi: true,
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

/** Year-month key for a proof round, e.g. "2026-04". */
function periodKey(d: Date): string { return d.toISOString().slice(0, 7); }

/** Is this the OFFICIAL proof for its round? By runKind, else Apr/Aug/Dec convention. */
function isOfficialEval(e: { runKind?: string | null; evaluationDate: Date }): boolean {
  if (e.runKind === "official") return true;
  if (e.runKind === "interim") return false;
  const m = e.evaluationDate.getUTCMonth() + 1; // no recorded kind → month heuristic
  return m === 4 || m === 8 || m === 12;
}

/** One evaluation per round (period), keeping the OFFICIAL over the interim. */
function canonicalEvals<T extends { runKind?: string | null; evaluationDate: Date }>(evals: T[]): T[] {
  const rank = (e: T) => (e.runKind === "official" ? 0 : e.runKind === "interim" ? 1 : 2);
  const best = new Map<string, T>();
  for (const e of evals) {
    const k = periodKey(e.evaluationDate);
    const cur = best.get(k);
    if (!cur || rank(e) < rank(cur)) best.set(k, e);
  }
  return [...best.values()].sort((a, b) => b.evaluationDate.getTime() - a.evaluationDate.getTime());
}

/**
 * For a proof round, present the OFFICIAL proof, filling any trait the official
 * is MISSING (absent or null) from that same round's interim proof. Returns the
 * evaluation to report (the official) and the merged trait list — never both
 * proofs side by side. `interimFilled` lists the trait codes taken from interim.
 */
function officialRoundTraits(roundEvals: FullAnimal["evaluations"], preferred: FullAnimal["evaluations"][number], defMap: DefMap): { reportEval: FullAnimal["evaluations"][number]; traits: TraitOut[]; interimFilled: string[] } {
  const official = roundEvals.find(isOfficialEval) ?? preferred;
  const interim = roundEvals.find((e) => e !== official && !isOfficialEval(e)) ?? null;
  const byCode = new Map(traitsFromEval(official, defMap).map((t) => [t.code, t]));
  const interimFilled: string[] = [];
  if (interim) {
    for (const it of traitsFromEval(interim, defMap)) {
      if (it.value == null && it.text == null) continue;
      const off = byCode.get(it.code);
      if (!off || (off.value == null && off.text == null)) { byCode.set(it.code, it); interimFilled.push(it.code); }
    }
  }
  return { reportEval: official, traits: [...byCode.values()], interimFilled };
}

function traitsFromEval(ev: FullAnimal["evaluations"][number] | null, defMap: DefMap): TraitOut[] {
  if (!ev) return [];
  return unpackTraits(ev.traitsJson, defMap).map((t) => ({ code: t.traitCode, name: t.traitName, category: t.traitCategory, value: t.numericValue, text: t.textValue, reliability: t.reliability, percentileRank: t.percentileRank }));
}

async function buildFullProfile(a: FullAnimal) {
  const defMap = await traitDefMap();
  const pref = preferredEval(a);
  // Present the OFFICIAL proof for the preferred round, filling any trait it is
  // missing from that same round's interim — never both proofs at once.
  const roundEvals = pref ? a.evaluations.filter((e) => periodKey(e.evaluationDate) === periodKey(pref.evaluationDate)) : [];
  const merged = pref ? officialRoundTraits(roundEvals, pref, defMap) : null;
  const reportEval = merged?.reportEval ?? null;
  const traits = merged?.traits ?? [];
  const interimFilled = merged?.interimFilled ?? [];
  const prof = parseHolsteinProfileJson(a.holsteinProfileJson);
  // Stored 3-generation pedigree (sire/dam/MGS/MGD/GMGS/GMGD) from PedigreeReference.
  const pedNotes = a.pedigreeRefs.map((p) => p.notes).find((nn) => nn && /\bSIRE:/i.test(nn)) ?? null;
  const pedAncestors = parsePedigreeNotes(pedNotes);
  const relOf = (r: string) => pedAncestors.find((x) => x.relation === r) ?? null;
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
    preferredEvaluation: reportEval ? {
      proofRun: reportEval.proofRun, evaluationDate: reportEval.evaluationDate.toISOString().slice(0, 10), countrySystem: reportEval.countrySystem,
      reliabilityOverall: reportEval.reliabilityOverall, daughters: reportEval.daughters, herds: reportEval.herds, genotyped: reportEval.genotyped,
      activityCode: reportEval.activityCode, officialCode: reportEval.officialCode, basis: reportEval.sireType,
      kind: isOfficialEval(reportEval) ? "official" : "interim",
      traitCount: traits.length, traits,
      interimFilledTraits: interimFilled,
      note: reportEval && !isOfficialEval(reportEval)
        ? "This round has only an interim (unofficial) proof — no official proof exists for it yet."
        : interimFilled.length
          ? `Figures are from the OFFICIAL proof; ${interimFilled.length} trait(s) the official did not carry were filled from the same round's interim proof (${interimFilled.join(", ")}).`
          : "Figures are from the official proof.",
    } : null,
    // One row per round — the official proof where a round has one — so the same
    // month never appears as two separate proofs.
    proofRoundHistory: canonicalEvals(a.evaluations).map((e) => ({ run: e.proofRun ?? e.evaluationDate.toISOString().slice(0, 7), date: e.evaluationDate.toISOString().slice(0, 10), kind: isOfficialEval(e) ? "official" : "interim", lpi: e.lpi, preferred: e.isPreferred })),
    classifications: a.classifications.map((c) => ({ code: c.classificationCode, score: c.finalScore, date: c.classificationDate ? c.classificationDate.toISOString().slice(0, 10) : null, lactation: c.lactationNumber, sections: c.traitValues.map((t) => ({ code: t.traitCode, name: t.traitName, value: t.traitValue })) })),
    milkRecords: a.milkRecords.map((m) => ({ lactation: m.lactationNumber, dim: m.daysInMilk, milk: m.milkAmount, milkUnit: m.milkUnit, fat: m.fatAmount, fatPct: m.fatPercent, protein: m.proteinAmount, proteinPct: m.proteinPercent, type: m.recordType, calvingDate: m.calvingDate ? m.calvingDate.toISOString().slice(0, 10) : null })),
    pedigree: {
      sire: relOf("sire"),
      dam: relOf("dam"),
      ancestors: pedAncestors, // sire/dam/MGS/MGD/GMGS/GMGD from the stored 3-gen pedigree
      note: "3-generation pedigree from stored records. For a deep maternal (tail-female) line — up to 15 generations — use trace_maternal_line with this animal's registration number.",
    },
    holsteinProfile: prof ? { owners: prof.owners, breeders: prof.breeders, awards: prof.awards, lactationCount: prof.lactations.length, familyTree: prof.familyTree, progeny: prof.progeny.slice(0, 25), progenyTotal: prof.progeny.length } : null,
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
/** A readable relationship label for a pedigree node by generation + side. */
function ancestorLabel(n: { generation: number; side: "sire" | "dam" }): string {
  if (n.generation === 1) return n.side === "sire" ? "Sire" : "Dam";
  const p = n.side === "sire" ? "Paternal" : "Maternal";
  return n.generation === 2 ? `${p} grand-parent` : `${p} great-grand-parent`;
}

/** The animal's best (highest-scoring) classification, e.g. EX-94. */
function bestClassification(rows: { date: string | null; code: string | null; score: number | null }[]): { code: string | null; score: number | null; date: string | null } | null {
  if (!rows?.length) return null;
  const scored = rows.filter((r) => r.score != null);
  const pick = (scored.length ? scored : rows).reduce((b, r) => ((r.score ?? -1) > (b.score ?? -1) ? r : b));
  return { code: pick.code, score: pick.score, date: pick.date };
}
/** Short label like "EX-94" from a classification, or null. */
function classLabel(c: { code: string | null; score: number | null } | null): string | null {
  if (!c) return null;
  return [c.code, c.score].filter((x) => x != null && x !== "").join("-") || null;
}

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

  // ALL traits (not just genomics) with value, reliability and percentile.
  const traits = parsed.evaluation.traits.map((t) => ({ code: t.code, value: t.numericValue, text: t.textValue, reliability: t.reliability, percentile: t.percentileRank }));
  // Sire / dam and the full 3-generation pedigree Lactanet renders on one page.
  const ft = parsed.profile.familyTree;
  const gen1 = (side: "sire" | "dam") => { const n = ft.find((x) => x.side === side && x.generation === 1); return n ? { name: n.name, reg: n.reg, birthDate: n.birthDate } : null; };
  const sire = gen1("sire"), dam = gen1("dam");
  const pedigree = ft.map((n) => ({ relation: ancestorLabel(n), generation: n.generation, side: n.side, name: n.name, reg: n.reg, birthDate: n.birthDate }));
  const progRows = parsed.profile.progeny.slice(0, 25);
  // Classifications (EX/VG/GP + section scores) and lactations — females carry
  // their own; bulls don't. This is what makes "look up her classification" work.
  const classifications = parsed.profile.classifications.map((c) => ({ date: c.date, code: c.code, score: c.score, lactation: c.lactation, sections: c.sections }));
  const best = bestClassification(parsed.profile.classifications);
  const lactations = parsed.profile.lactations.map((l) => ({ lactation: l.lactationNumber, dim: l.dim, milk: l.milk, fat: l.fat, fatPct: l.fatPct, prot: l.prot, protPct: l.protPct }));

  return {
    summary: `${parsed.identity.name ?? ref.reg} — pulled LIVE from Lactanet, NOT saved.${classLabel(best) ? ` Classified ${classLabel(best)}.` : ""} Sire: ${sire?.name ?? "unknown"}. ${traits.length} traits, ${ft.length} pedigree ancestors, ${classifications.length} classification(s), ${parsed.progenyTotal ?? progRows.length} progeny. For the deep maternal line use trace_maternal_line; to save this animal use import_animals.`,
    records: {
      found: true, source: "lactanet", externallySourced: true, savedToDatabase: false,
      animal: { name: parsed.identity.name ?? null, reg: ref.reg, sex: ref.sex, birthDate: parsed.identity.birthDate ?? null, naab: parsed.identity.naab ?? null, inbreeding: parsed.identity.inbreeding ?? null },
      classification: best, classifications, lactations,
      sire, dam,
      pedigree, // 3 generations from Lactanet's pedigree page (sire + dam sides)
      evaluation: { basis: parsed.evaluation.basis, reliabilityOverall: parsed.evaluation.reliability, proofRun: parsed.evaluation.runLabel, traitCount: traits.length, traits },
      progeny: { total: parsed.progenyTotal, capped: parsed.progenyCapped, shown: progRows.length, rows: progRows },
      note: "Externally sourced from Lactanet; session-only, not saved. The pedigree here is the 3 generations Lactanet shows on one page — for a deep maternal (tail-female) line up to 15 generations, use trace_maternal_line. Use import_animals to save this animal.",
      warnings: parsed.warnings,
    },
  };
}

/**
 * Walk an animal's MATERNAL (tail-female) line — dam → dam's dam → … — up to
 * `generations` deep, one cheap pedigree-only Lactanet fetch per generation.
 * Stops at the cap, when Lactanet has no registration for the next dam (the trail
 * ends), or when a wall-clock budget is hit (so it stays under the route limit),
 * and reports how far it reached.
 */
async function traceMaternalLine(startReg: string, generations: number, includeClassifications = false): Promise<{ summary: string; records: unknown }> {
  const { parseReg, fetchLactanetAnimal } = await import("@/lib/lactanet-web");
  const { parsePedigree, parseClassifications } = await import("@/lib/lactanet-parse");
  const start = parseReg(startReg);
  if (!start) return { summary: `"${startReg}" is not a registration number (expected e.g. HOCANF12345678).`, records: null };
  // With classifications we fetch TWICE per dam (pedigree + classification), so
  // cap the depth lower to stay inside the time budget.
  const maxGen = Math.max(1, Math.min(Math.round(generations) || 15, includeClassifications ? 8 : 15));
  const BUDGET_MS = 40000; // stay well under the 60s route limit
  const t0 = Date.now();
  const line: { generation: number; name: string | null; reg: string | null; birthDate: string | null; classification?: { code: string | null; score: number | null; date: string | null } | null }[] = [];
  let cur: string | null = start.reg;
  let stopped: string | null = null;
  for (let gen = 1; gen <= maxGen; gen++) {
    if (Date.now() - t0 > BUDGET_MS) { stopped = `stopped at a time budget after ${line.length} generation(s)`; break; }
    if (!cur) break;
    let fetched;
    try { fetched = await fetchLactanetAnimal(cur, ["pedigree"]); }
    catch (e) { stopped = `Lactanet fetch failed at generation ${gen}: ${(e as Error)?.message ?? e}`; break; }
    if (fetched.error || !fetched.tabs.pedigree) { stopped = `Lactanet returned no pedigree at generation ${gen}${fetched.error ? `: ${fetched.error}` : ""}`; break; }
    const dam = parsePedigree(fetched.tabs.pedigree).find((n) => n.side === "dam" && n.generation === 1);
    if (!dam || (!dam.name && !dam.reg)) { stopped = `the maternal line ends — Lactanet shows no dam at generation ${gen}`; break; }
    // Optionally look up this dam's own classification (she's female).
    let classification: { code: string | null; score: number | null; date: string | null } | null = null;
    if (includeClassifications && dam.reg && Date.now() - t0 <= BUDGET_MS) {
      try {
        const cf = await fetchLactanetAnimal(dam.reg, ["classification"]);
        if (!cf.error && cf.tabs.classification) classification = bestClassification(parseClassifications(cf.tabs.classification, "F"));
      } catch { /* classification is best-effort — don't fail the trace */ }
    }
    line.push({ generation: gen, name: dam.name, reg: dam.reg, birthDate: dam.birthDate, ...(includeClassifications ? { classification } : {}) });
    if (!dam.reg) { stopped = `the trail ends at generation ${gen} — Lactanet has no registration number for ${dam.name ?? "the next dam"}, so it can't go further back`; break; }
    cur = dam.reg;
  }
  const reachedAll = line.length >= maxGen && !stopped;
  return {
    summary: `Maternal (tail-female) line for ${start.reg}: traced ${line.length} generation(s)${reachedAll ? ` — the ${maxGen} requested` : stopped ? ` — ${stopped}` : ""}${includeClassifications ? " with each dam's classification" : ""}. Each generation is the previous dam's dam.`,
    records: { startReg: start.reg, requested: maxGen, generationsTraced: line.length, includeClassifications, line, stoppedReason: stopped, source: "lactanet", note: "Each entry is a dam in the tail-female line (the animal's dam, then her dam, and so on). Live from Lactanet; nothing saved." },
  };
}

/**
 * The 3-generation pedigree for an animal NOT in the database, live from Lactanet
 * (read-only, not saved). Lighter than externalAnimalProfile — fetches only the
 * summary + pedigree tabs. Lets a "what's <reg>'s pedigree?" question be answered
 * without importing.
 */
async function externalPedigree(reg: string): Promise<{ summary: string; records: unknown }> {
  const { parseReg, fetchLactanetAnimal } = await import("@/lib/lactanet-web");
  const ref = parseReg(reg);
  if (!ref) return { summary: `"${reg}" is not a registration number (expected e.g. HOCANF15232832), so I can't look it up on Lactanet.`, records: null };
  let fetched;
  try { fetched = await fetchLactanetAnimal(ref.reg, ["summary", "pedigree"]); }
  catch (e) { return { summary: `Lactanet lookup failed: ${(e as Error)?.message ?? e}`, records: null }; }
  if (fetched.error) return { summary: `Lactanet: ${fetched.error}`, records: null };
  const { parseIdentity, parsePedigree } = await import("@/lib/lactanet-parse");
  const identity = fetched.tabs.summary ? parseIdentity(fetched.tabs.summary) : null;
  const ft = fetched.tabs.pedigree ? parsePedigree(fetched.tabs.pedigree) : [];
  const gen1 = (side: "sire" | "dam") => { const n = ft.find((x) => x.side === side && x.generation === 1); return n ? { name: n.name, reg: n.reg, birthDate: n.birthDate } : null; };
  const pedigree = ft.map((n) => ({ relation: ancestorLabel(n), generation: n.generation, side: n.side, name: n.name, reg: n.reg, birthDate: n.birthDate }));
  const sire = gen1("sire"), dam = gen1("dam");
  return {
    summary: `${identity?.name ?? ref.reg} — pedigree from Lactanet (NOT in your database, nothing saved). Sire: ${sire?.name ?? "unknown"}; Dam: ${dam?.name ?? "unknown"}; ${ft.length} ancestors across 3 generations. For the deep maternal (tail-female) line use trace_maternal_line.`,
    records: {
      found: true, source: "lactanet", externallySourced: true, savedToDatabase: false,
      animal: { name: identity?.name ?? null, reg: ref.reg, sex: ref.sex },
      sire, dam, pedigree,
      note: "Live from Lactanet; session-only, not saved — you do NOT need to import the animal to see this. This is the 3-generation pedigree; for a deep maternal line use trace_maternal_line. To save the animal, use import_animals.",
    },
  };
}

// ---------------------------------------------------------------------------
// The AMERICAN (CDCB) side.
//
// One agent spans both countries, so the same tools answer both — but the two
// systems never share a query. Everything below reads UsEvaluation; nothing
// below touches GeneticEvaluation. That separation is the whole safety story:
// a Canadian EBV is in KILOGRAMS and roughly twice the American PTA in POUNDS
// for the same bull, so a single leaked column would read as a plausible number
// and be wrong by a factor of two — the worst kind of bug this product can have.
//
// Three American facts shape these helpers:
//   * GTPI is COMPUTED here, not published by CDCB, so every record that carries
//     it also carries the disclosure and the formula version it was computed with.
//   * Rump Angle has an INTERMEDIATE OPTIMUM, so ranking on it is refused rather
//     than quietly allowed.
//   * CDCB ships ONE file per round. There is no official/interim pair, so only
//     runKind="official" rows are ever a round; monthly and weekly adds exist but
//     are never ranked or presented alongside one.
// ---------------------------------------------------------------------------

export type AgentSystem = "ca" | "us";

/** Which genetic system a read tool was asked for. Canada stays the default. */
export const systemOf = (input: Record<string, unknown>): AgentSystem =>
  String(input.system ?? "").trim().toLowerCase() === "us" ? "us" : "ca";

/** The `system` argument, shared by every read tool that can answer for both. */
const SYSTEM_ARG = {
  system: {
    type: "string",
    enum: ["ca", "us"],
    description:
      "Which genetic system to read. \"ca\" (default) = the Canadian Lactanet/CDN evaluations — EBVs in KILOGRAMS, LPI / Pro$ / Conformation. \"us\" = the American CDCB evaluations — PTAs in POUNDS, GTPI / NM$ / PTAT. Pick the one the user is asking about; never blend the two systems' numbers in one answer or one table.",
  },
} as const;

/** The disclosure that must travel with every GTPI figure the agent sees. */
const GTPI_NOTE =
  "GTPI is CALCULATED by Blondin Sires from CDCB evaluations using the Holstein Association USA formula in force for each round. It is not an official Holstein Association USA publication and is typically within ±3 points. Report it as a whole number and say it is calculated. TPI is a registered trademark of Holstein Association USA.";

const US_UNITS_NOTE =
  "American values are PTAs in POUNDS and are roughly HALF the Canadian breeding value for the same trait. Never compare or combine them with a Canadian EBV.";

const RPA_NOTE =
  "Rump Angle has an intermediate optimum — neither the highest nor the lowest value is best. Report it, but never rank or call a bull 'best' on it.";

// Friendly US trait name → indexed UsEvaluation column. Built from the round-
// compare catalogue so the agent and the reports can never drift apart, then
// widened with the words a person actually types.
const US_TRAIT_COL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const t of US_CHANGE_TRAITS) {
    m[t.code.toLowerCase()] = t.column;
    m[t.short.toLowerCase()] = t.column;
    m[t.label.toLowerCase()] = t.column;
  }
  return Object.assign(m, {
    tpi: "tpi", "net merit": "nmDollar", "nm$": "nmDollar",
    jpi: "jpi", type: "ptat", protein: "pro", prot: "pro",
    rump: "rpa", "rump angle": "rpa", "productive life": "pl", livability: "liv",
    "cheese merit": "cmDollar", "fluid merit": "fmDollar", "grazing merit": "gmDollar",
  });
})();

export const usTraitCol = (t: string | undefined) => US_TRAIT_COL[(t ?? "tpi").toLowerCase().trim()] ?? "tpi";

/** Columns that must never be ordered on, because there is no "top" of the list. */
const US_INTERMEDIATE_COLS = new Set<string>(US_CHANGE_TRAITS.filter((t) => t.direction === "intermediate").map((t) => t.column));

const US_TRAIT_MENU = US_CHANGE_TRAITS.map((t) => t.code.toLowerCase()).join(" | ");

/** Breed as a person says it → the CDCB EVAL_BREED code. Null when unrecognised. */
const US_BREED_NAMES: Record<string, string> = {
  HOLSTEIN: "HO", JERSEY: "JE", "BROWN SWISS": "BS", BROWNSWISS: "BS", GUERNSEY: "GU", AYRSHIRE: "AY",
};
function usBreedCode(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!s) return null;
  return CDCB_BREEDS.includes(s) ? s : (US_BREED_NAMES[s] ?? null);
}

const AI_CODE_LABEL: Record<string, string> = {
  A: "active AI", G: "genomic young bull being marketed", F: "foreign",
};

const US_ANIMAL_CARD = {
  id: true, primaryName: true, birthDate: true, sex: true,
  breed: { select: { breedName: true } },
  identifiers: { where: { active: true }, orderBy: [{ isPrimary: "desc" }, { idType: "asc" }], take: 8, select: { idType: true, idValue: true, isPrimary: true } },
  // Marketed-or-not is CDCB's AI-status file, NOT the presence of a NAAB code —
  // plenty of evaluated bulls carry a code and are not being sold.
  usAiStatus: { orderBy: { roundCode: "desc" }, take: 1, select: { code: true, roundCode: true } },
} satisfies Prisma.AnimalSelect;

const US_EVAL_SELECT = {
  usEvaluationId: true, roundCode: true, runKind: true, evaluationDate: true, isPreferred: true,
  evalBreed: true, naabCode: true, isPtaMilk: true, isPtaCt: true, isGraduation: true,
  tpi: true, tpiFormulaVersion: true, tpiConfidence: true, jpi: true,
  nmDollar: true, cmDollar: true, fmDollar: true, gmDollar: true,
  milk: true, fat: true, pro: true, fatPct: true, proPct: true,
  pl: true, scs: true, dpr: true, ccr: true, ptat: true, rpa: true, liv: true, udc: true, flc: true,
} satisfies Prisma.UsEvaluationSelect;

type UsCard = Prisma.UsEvaluationGetPayload<{ select: typeof US_EVAL_SELECT & { animal: { select: typeof US_ANIMAL_CARD } } }>;

/**
 * CDCB's proven-vs-genomic answer, which is PER TRAIT GROUP rather than per
 * animal — a bull can be daughter-proven for production and still on a parent
 * average for calving. There is no single label to give him, so none is invented.
 */
function usBasis(e: { isPtaMilk: boolean | null; isPtaCt: boolean | null }) {
  const one = (v: boolean | null) => (v == null ? "unknown" : v ? "daughter-proven (PTA)" : "parent average / genomic");
  return {
    production: one(e.isPtaMilk),
    calvingTraits: one(e.isPtaCt),
    note: "CDCB flags proven-vs-genomic PER TRAIT GROUP. Do not collapse this to one proven/genomic word for the bull; say which groups are daughter-proven.",
  };
}

/** Is CDCB marketing this bull? From the AI-status file, never from a NAAB code. */
function usMarketed(rows: { code: string; roundCode: string }[]) {
  const r = rows[0];
  if (!r) {
    return { active: false, code: null, label: "not listed in CDCB's AI-status file — not being marketed", round: null };
  }
  return { active: r.code === "A" || r.code === "G", code: r.code, label: AI_CODE_LABEL[r.code] ?? r.code, round: usRoundLabel(r.roundCode) };
}

/** One American bull, flattened for the model. Every field is a US figure. */
function usFlatten(e: UsCard) {
  const a = e.animal;
  return {
    system: "us" as const,
    units: US_UNITS_NOTE,
    name: a.primaryName,
    reg: a.identifiers.find((i) => i.isPrimary)?.idValue ?? null,
    id17: a.identifiers.find((i) => i.idType === "cdcb_id17")?.idValue ?? null,
    breed: a.breed?.breedName ?? null,
    evalBreed: e.evalBreed,
    naab: e.naabCode,
    round: e.roundCode ? usRoundLabel(e.roundCode) : null,
    roundCode: e.roundCode,
    runKind: e.runKind,
    marketed: usMarketed(a.usAiStatus),
    evaluationBasis: usBasis(e),
    isGraduation: e.isGraduation,
    gtpi: e.tpi,
    gtpiFormula: e.tpiFormulaVersion,
    gtpiConfidence: e.tpiConfidence,
    gtpiNote: e.tpi == null ? null : GTPI_NOTE,
    jpi: e.jpi,
    nmDollar: e.nmDollar, cmDollar: e.cmDollar, fmDollar: e.fmDollar, gmDollar: e.gmDollar,
    milk: e.milk, fat: e.fat, pro: e.pro, fatPct: e.fatPct, proPct: e.proPct,
    pl: e.pl, scs: e.scs, dpr: e.dpr, ccr: e.ccr, liv: e.liv,
    ptat: e.ptat, udc: e.udc, flc: e.flc,
    rpa: e.rpa,
    rpaNote: e.rpa == null ? null : RPA_NOTE,
  };
}

/**
 * The UsEvaluation WHERE for a lineup query.
 *
 * Preferred + official only: a provisional monthly add and a weekly unofficial
 * row are not rounds, so they can never enter a ranking or an average.
 */
function usEvalWhere(input: Record<string, unknown>): { where: Prisma.UsEvaluationWhereInput } | { error: string } {
  const AND: Prisma.UsEvaluationWhereInput[] = [
    { isPreferred: true, runKind: "official", approvalStatus: "approved", animal: { archived: false } },
  ];
  const asked = typeof input.breed === "string" ? input.breed.trim() : "";
  if (asked) {
    const code = usBreedCode(asked);
    if (!code) return { error: `CDCB publishes bull evaluations for ${CDCB_BREEDS.join(", ")} only — "${asked}" is not one of them.` };
    AND.push({ evalBreed: code });
  }
  switch (typeof input.role === "string" ? input.role : "") {
    // Proven vs genomic comes from the production trait group's own flag.
    case "proven": AND.push({ isPtaMilk: true }); break;
    case "genomic": AND.push({ isPtaMilk: false }); break;
    // Active means CDCB is marketing him, not that he holds a NAAB code.
    case "active": AND.push({ animal: { usAiStatus: { some: { code: { in: ["A", "G"] } } } } }); break;
    case "inactive": AND.push({ animal: { usAiStatus: { none: { code: { in: ["A", "G"] } } } } }); break;
  }
  return { where: { AND } };
}

/** The "US tables have not been created yet" Prisma failure. */
const isMissingUsTables = (e: unknown) => /does not exist|P2021/i.test(String((e as Error)?.message ?? ""));

const US_SETUP_RESULT = {
  summary: "The American (CDCB) tables do not exist in this database yet — the CDCB importer has never been run here. Tell the user plainly that there is no US data to read until an administrator imports a CDCB round; do NOT answer from the Canadian data instead.",
  records: { system: "us", available: false, reason: "us_tables_not_created" },
};

/** Run a US read, turning "those tables aren't there yet" into a plain answer. */
async function usRead(fn: () => Promise<{ summary: string; records: unknown }>) {
  try {
    return await fn();
  } catch (e) {
    if (isMissingUsTables(e)) return US_SETUP_RESULT;
    throw e;
  }
}

/** Find the Animal behind a US question: registration, CDCB id17, NAAB, or name. */
async function findUsAnimal(name: string, reg: string): Promise<{ id: string; primaryName: string } | null> {
  const sel = { id: true, primaryName: true };
  if (reg) {
    const byId = await prisma.animal.findFirst({
      where: { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } },
      select: sel,
    });
    if (byId) return byId;
    const byEval = await prisma.usEvaluation.findFirst({
      where: { OR: [{ id17: reg.toUpperCase() }, { naabCode: reg.toUpperCase() }] },
      select: { animal: { select: sel } },
    });
    if (byEval) return byEval.animal;
  }
  if (name) {
    const exact = await prisma.animal.findFirst({ where: { archived: false, primaryName: { equals: name, mode: "insensitive" } }, select: sel });
    if (exact) return exact;
    return prisma.animal.findFirst({ where: { archived: false, primaryName: { contains: name, mode: "insensitive" } }, select: sel });
  }
  return null;
}

function parseNumMap(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {}; // a malformed blob is no traits, never a fabricated zero
  }
}

/**
 * Every trait on one US evaluation, unpacked from the stored code→value maps.
 *
 * The union of the published and parent-average maps, not just the published
 * one: a young bull can carry a PA for a trait he has no GPTA for yet, and
 * dropping it would hide that he has one. A code with no confirmed meaning is
 * returned under its raw code with direction "unknown" rather than guessed at.
 *
 * The trait dictionary lives in the (server-only) specialist catalogue, so it is
 * pulled in with a dynamic import like every other server-only dependency here.
 */
async function usTraitRows(e: { gptaJson: string | null; relJson: string | null; paJson: string | null; tpi: number | null; tpiFormulaVersion: string | null; tpiConfidence: string | null; udc: number | null; flc: number | null; jpi: number | null }) {
  const { US_SPECIALIST_CATALOG } = await import("@/lib/us-cdcb/specialists");
  const byCode = new Map(US_SPECIALIST_CATALOG.map((t) => [t.code, t]));
  const gpta = parseNumMap(e.gptaJson), rel = parseNumMap(e.relJson), pa = parseNumMap(e.paJson);
  const published = [...new Set([...Object.keys(gpta), ...Object.keys(pa)])]
    .map((code) => {
      const def = byCode.get(code);
      return {
        code,
        name: def?.name ?? code,
        group: def?.group ?? "Published but not identified",
        direction: def?.direction ?? "unknown",
        unit: def?.unit ?? null,
        value: gpta[code] ?? null,
        reliability: rel[code] ?? null,
        parentAverage: pa[code] ?? null,
        source: "cdcb" as const,
      };
    })
    .sort((x, y) => x.group.localeCompare(y.group) || x.code.localeCompare(y.code));

  // The figures CDCB does NOT publish. Kept in their own list so they can never
  // be read back as an official CDCB number.
  const computed = [
    { code: "GTPI", name: "GTPI (calculated)", value: e.tpi, formula: e.tpiFormulaVersion, confidence: e.tpiConfidence, note: GTPI_NOTE },
    { code: "JPI", name: "JPI (calculated)", value: e.jpi, formula: null, confidence: null, note: "Calculated by Blondin Sires from CDCB evaluations using AJCA's formula. Not an official American Jersey Cattle Association publication." },
    { code: "UDC", name: "Udder Composite (calculated)", value: e.udc, formula: null, confidence: null, note: "Derived from the published linear traits with Holstein Association USA's composite weights — CDCB publishes the linears, not the composite." },
    { code: "FLC", name: "Feet & Legs Composite (calculated)", value: e.flc, formula: null, confidence: null, note: "Derived from the published linear traits with Holstein Association USA's composite weights." },
  ].filter((t) => t.value != null);

  return { published, computed };
}

/** The exhaustive American record for one animal. */
async function buildUsProfile(animalId: string, animalName: string) {
  const [animal, evals] = await Promise.all([
    prisma.animal.findUnique({ where: { id: animalId }, select: US_ANIMAL_CARD }),
    prisma.usEvaluation.findMany({
      where: { animalId, approvalStatus: "approved" },
      orderBy: { evaluationDate: "desc" },
      select: {
        ...US_EVAL_SELECT, sourceFamily: true, periodKey: true,
        gptaJson: true, relJson: true, paJson: true, haplotypesJson: true,
        sire17: true, dam17: true, genInb: true, pedInb: true, genFutInb: true, expFutInb: true,
      },
    }),
  ]);
  if (!animal) return null;

  const official = evals.filter((e) => e.runKind === "official");
  const pref = evals.find((e) => e.isPreferred) ?? official[0] ?? null;
  const traits = pref ? await usTraitRows(pref) : null;
  const haplotypes = pref?.haplotypesJson ? (JSON.parse(pref.haplotypesJson) as Record<string, string>) : null;

  return {
    system: "us" as const,
    units: US_UNITS_NOTE,
    found: true,
    animal: {
      name: animal.primaryName,
      sex: animal.sex,
      breed: animal.breed?.breedName ?? null,
      birthDate: animal.birthDate ? animal.birthDate.toISOString().slice(0, 10) : null,
      identifiers: animal.identifiers.map((i) => ({ idType: i.idType, idValue: i.idValue, isPrimary: i.isPrimary })),
      marketed: usMarketed(animal.usAiStatus),
    },
    preferredEvaluation: pref
      ? {
          round: pref.roundCode ? usRoundLabel(pref.roundCode) : null,
          roundCode: pref.roundCode,
          runKind: pref.runKind,
          evaluationDate: pref.evaluationDate.toISOString().slice(0, 10),
          evalBreed: pref.evalBreed,
          naab: pref.naabCode,
          evaluationBasis: usBasis(pref),
          isGraduation: pref.isGraduation,
          graduationNote: pref.isGraduation ? "First official round after the young-bull list — a graduating bull moves far more than an ordinary round, so treat the change as a change of evaluation type, not as a proof holding or slipping." : null,
          sire17: pref.sire17, dam17: pref.dam17,
          inbreeding: { genomic: pref.genInb, pedigree: pref.pedInb, expectedFuture: pref.expFutInb, genomicFuture: pref.genFutInb },
          keyTraits: US_KEY_TRAITS.map((t) => ({
            code: t.code, label: t.label, value: (pref as Record<string, unknown>)[t.column] as number | null,
            unit: t.unit, direction: t.direction, computed: t.source === "computed",
          })),
          traitCount: traits ? traits.published.length + traits.computed.length : 0,
          publishedTraits: traits?.published ?? [],
          computedIndexes: traits?.computed ?? [],
          haplotypes,
        }
      : null,
    // One row per official round. CDCB ships ONE file per round, so there is no
    // official/interim pair here and nothing to merge — unlike Canada.
    proofRoundHistory: official.map((e) => ({
      round: e.roundCode ? usRoundLabel(e.roundCode) : e.evaluationDate.toISOString().slice(0, 7),
      roundCode: e.roundCode,
      date: e.evaluationDate.toISOString().slice(0, 10),
      gtpi: e.tpi, nmDollar: e.nmDollar, ptat: e.ptat, milk: e.milk,
      isGraduation: e.isGraduation,
      preferred: e.isPreferred,
    })),
    nonRoundRuns: evals.filter((e) => e.runKind !== "official").map((e) => ({ periodKey: e.periodKey, runKind: e.runKind, date: e.evaluationDate.toISOString().slice(0, 10) })),
    notes: [
      GTPI_NOTE,
      RPA_NOTE,
      "Only the official rounds above are authoritative. Monthly (provisional) and weekly (unofficial) adds are listed under nonRoundRuns for completeness and must never be ranked or called a proof round.",
      "There is no interim proof and no Rollback Resistance on the American side — neither concept exists in CDCB's publishing model.",
    ],
    warning: `${animalName} is shown here on his AMERICAN evaluation only. Do not mix these figures with any Canadian LPI/EBV figure for the same bull.`,
  };
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "search_animals",
    description: "Find sires by name or registration number, optionally filtered by role (proven/genomic/active/inactive) and breed. Use for 'find', 'look up', 'is there a bull named…'. Set system:\"us\" to search the American CDCB lineup instead of the Canadian one — the US results carry PTAs in pounds and a calculated GTPI, and on that side 'proven/genomic' comes from CDCB's per-trait-group flag and 'active' from CDCB's AI-status file.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name fragment or registration number (US: also a CDCB 17-char id or a NAAB code)" },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        breed: { type: "string", description: "Breed name fragment, e.g. Holstein. On the US side: Holstein, Jersey, Brown Swiss, Guernsey or Ayrshire only." },
        limit: { type: "integer", description: "Max results (default 15, max 50)" },
        ...SYSTEM_ARG,
      },
    },
    run: async (input) => {
      if (systemOf(input) === "us") return usRead(async () => {
        const f = usEvalWhere(input);
        if ("error" in f) return { summary: f.error, records: null };
        const q = str(input.query);
        const AND = [...(f.where.AND as Prisma.UsEvaluationWhereInput[])];
        if (q) AND.push({ OR: [
          { animal: { primaryName: { contains: q, mode: "insensitive" } } },
          { animal: { identifiers: { some: { idValue: { contains: q, mode: "insensitive" } } } } },
          { id17: { contains: q.toUpperCase() } },
          { naabCode: { contains: q.toUpperCase() } },
        ] });
        const rows = await prisma.usEvaluation.findMany({
          where: { AND }, take: clamp(input.limit, 1, 50, 15),
          orderBy: { animal: { primaryName: "asc" } },
          select: { ...US_EVAL_SELECT, animal: { select: US_ANIMAL_CARD } },
        });
        return { summary: `${rows.length} bull(s) with an official US (CDCB) evaluation matched${q ? ` "${q}"` : ""}. ${US_UNITS_NOTE}`, records: rows.map(usFlatten) };
      });
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
    description: "The card for one sire by exact name or registration number. system:\"ca\" (default) returns the Canadian preferred evaluation, proven/genomic status, proof performance, rollback resistance and proof-round count. system:\"us\" returns his American CDCB card instead — calculated GTPI, NM$, PTAT, Milk, Rump Angle, DPR, CCR (PTAs in pounds), which trait groups are daughter-proven, and whether CDCB's AI-status file lists him as marketed. Rollback Resistance and Proof Performance do NOT exist on the US card.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, reg: { type: "string" }, ...SYSTEM_ARG },
    },
    run: async (input) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      if (!name && !reg) return { summary: "Provide a name or registration number.", records: null };
      if (systemOf(input) === "us") return usRead(async () => {
        const hit = await findUsAnimal(name, reg);
        if (!hit) return { summary: `No animal found for ${reg || name}.`, records: null };
        const row = await prisma.usEvaluation.findFirst({
          where: { animalId: hit.id, runKind: "official", approvalStatus: "approved" },
          orderBy: [{ isPreferred: "desc" }, { evaluationDate: "desc" }],
          select: { ...US_EVAL_SELECT, animal: { select: US_ANIMAL_CARD } },
        });
        if (!row) {
          return { summary: `${hit.primaryName} is in the database but has no official CDCB evaluation — he has no American proof here. Do not substitute his Canadian figures.`, records: { system: "us", name: hit.primaryName, usEvaluation: null } };
        }
        return { summary: `US (CDCB) card for ${hit.primaryName}. ${US_UNITS_NOTE}`, records: usFlatten(row) };
      });
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
    description: `Top or bottom N sires by a trait among optional role/breed filters. Use for 'highest LPI', 'best conformation active bulls', 'lowest…'. CANADIAN traits (system:"ca", default): lpi, pro$, conf, milk, fat, prot, mamm, fl, ds — EBVs in kilograms. AMERICAN traits (system:"us"): ${US_TRAIT_MENU} — PTAs in pounds, plus the calculated gtpi. Ranking on the American rump angle (rpa) is REFUSED: it has an intermediate optimum, so there is no bull at the top of that list.`,
    input_schema: {
      type: "object",
      properties: {
        trait: { type: "string", description: `Canadian: lpi | pro$ | conf | milk | fat | prot | mamm | fl | ds. American (system:"us"): ${US_TRAIT_MENU}` },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        breed: { type: "string" },
        order: { type: "string", enum: ["top", "bottom"], description: "top = highest (default)" },
        limit: { type: "integer", description: "default 10, max 30" },
        ...SYSTEM_ARG,
      },
      required: ["trait"],
    },
    run: async (input) => {
      if (systemOf(input) === "us") return usRead(async () => {
        const col = usTraitCol(input.trait as string);
        if (US_INTERMEDIATE_COLS.has(col)) {
          return { summary: `${str(input.trait) || col} has an INTERMEDIATE OPTIMUM — neither the highest nor the lowest value is the best one, so ranking bulls on it would be meaningless. Explain that to the user and offer to report the trait for named bulls instead, or to rank on a trait that has a direction.`, records: null };
        }
        const f = usEvalWhere(input);
        if ("error" in f) return { summary: f.error, records: null };
        const dir = input.order === "bottom" ? "asc" : "desc";
        const rows = await prisma.usEvaluation.findMany({
          where: { AND: [...(f.where.AND as Prisma.UsEvaluationWhereInput[]), { [col]: { not: null } }] },
          orderBy: { [col]: dir }, take: clamp(input.limit, 1, 30, 10),
          select: { ...US_EVAL_SELECT, animal: { select: US_ANIMAL_CARD } },
        });
        const note = col === "tpi" ? ` ${GTPI_NOTE}` : "";
        return { summary: `${input.order === "bottom" ? "Lowest" : "Highest"} ${rows.length} on the AMERICAN side by ${col} (official CDCB rounds only). ${US_UNITS_NOTE}${note}`, records: rows.map(usFlatten) };
      });
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
    description: "Aggregate counts and averages for the lineup: how many proven/genomic/active/inactive, total sires and proof rounds, and average LPI/Pro$/Conformation. Use for 'how many…', 'lineup overview', 'average LPI'. With system:\"us\" it reports the AMERICAN lineup instead — how many bulls carry an official CDCB round, how many are daughter-proven for production, how many CDCB is marketing, and average GTPI/NM$/PTAT/Milk in US units.",
    input_schema: { type: "object", properties: { role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] }, breed: { type: "string" }, ...SYSTEM_ARG } },
    run: async (input) => {
      if (systemOf(input) === "us") return usRead(async () => {
        const f = usEvalWhere(input);
        if ("error" in f) return { summary: f.error, records: null };
        const where = f.where;
        const [total, provenMilk, provenCt, marketed, avg, byBreed] = await Promise.all([
          prisma.usEvaluation.count({ where }),
          prisma.usEvaluation.count({ where: { AND: [where, { isPtaMilk: true }] } }),
          prisma.usEvaluation.count({ where: { AND: [where, { isPtaCt: true }] } }),
          prisma.usEvaluation.count({ where: { AND: [where, { animal: { usAiStatus: { some: { code: { in: ["A", "G"] } } } } }] } }),
          prisma.usEvaluation.aggregate({ where, _avg: { tpi: true, nmDollar: true, ptat: true, milk: true, fat: true, pro: true } }),
          prisma.usEvaluation.groupBy({ by: ["evalBreed"], where, _count: { _all: true } }),
        ]);
        const r0 = (v: number | null) => (v == null ? null : Math.round(v));
        const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
        return {
          summary: `${total} bull(s) hold an official CDCB round. ${US_UNITS_NOTE}`,
          records: {
            system: "us", units: US_UNITS_NOTE,
            bullsWithOfficialRound: total,
            daughterProvenForProduction: provenMilk,
            parentAverageForProduction: total - provenMilk,
            daughterProvenForCalvingTraits: provenCt,
            marketedByCdcb: marketed,
            notMarketed: total - marketed,
            byEvalBreed: byBreed.map((b) => ({ breed: b.evalBreed, bulls: b._count._all })),
            averages: { gtpi: r0(avg._avg.tpi), nmDollar: r0(avg._avg.nmDollar), ptat: r2(avg._avg.ptat), milk: r0(avg._avg.milk), fat: r0(avg._avg.fat), pro: r0(avg._avg.pro) },
            notes: [
              GTPI_NOTE,
              "Proven vs genomic is CDCB's PER-TRAIT-GROUP flag: production and calving traits are flagged separately, so the two counts above will differ.",
              "Marketed comes from CDCB's AI-status file (A = active AI, G = genomic young bull marketed), not from holding a NAAB code.",
              "Only official rounds are counted. There is no interim proof on the American side.",
            ],
          },
        };
      });
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
    description: "CANADIAN ONLY. Best or worst sires by Rollback Resistance (April base-change retention, base 100) or Proof Performance (0–100, every round). Use for 'most rollback resistant', 'which bulls hold up best', 'proof stability leaders'. Both metrics are computed from Lactanet rounds and measure retention through Canada's ANNUAL April re-basing. The United States re-bases about every five years, so neither number exists — or can be computed — for the American side; calling this with system:\"us\" refuses rather than returning Canadian scores under an American question.",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["rollbackResistance", "proofPerformance"], description: "default rollbackResistance" },
        order: { type: "string", enum: ["top", "bottom"] },
        role: { type: "string", enum: ["proven", "genomic", "active", "inactive"] },
        limit: { type: "integer", description: "default 10, max 30" },
        ...SYSTEM_ARG,
      },
    },
    run: async (input) => {
      // The refusal is the point: these scores are Canadian by construction, and
      // returning them for a US question would answer it with the wrong country's
      // numbers under an American-sounding label.
      if (systemOf(input) === "us") {
        return {
          summary: "Rollback Resistance and Proof Performance do not exist on the American side and cannot be computed there. Rollback Resistance measures how a bull holds through Lactanet's ANNUAL April re-basing; CDCB re-bases roughly every five years, so there is no annual rollback to resist. Tell the user that plainly — do not answer with the Canadian scores. For how an American proof moved between rounds, compare his CDCB rounds with proof_history (system:\"us\").",
          records: null,
        };
      }
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
    description: `A single sire's proof rounds over time for one trait, oldest to newest. CANADIAN (system:"ca", default, trait defaults to LPI): one point per round — the OFFICIAL proof's value, falling back to the interim only if the official is missing that trait, so a month never shows twice. AMERICAN (system:"us", trait defaults to the calculated GTPI; traits: ${US_TRAIT_MENU}): one point per official CDCB round. There is no interim proof on the US side, so nothing is merged — a round is simply a round. Use for 'how has X's LPI changed', 'how has his GTPI moved', 'proof trend'.`,
    input_schema: {
      type: "object",
      properties: { name: { type: "string" }, reg: { type: "string" }, trait: { type: "string", description: "Canadian default lpi; American default gtpi" }, ...SYSTEM_ARG },
    },
    run: async (input) => {
      if (systemOf(input) === "us") return usRead(async () => {
        const col = usTraitCol(input.trait as string);
        const hit = await findUsAnimal(str(input.name), str(input.reg));
        if (!hit) return { summary: `No animal found for ${str(input.reg) || str(input.name)}.`, records: null };
        // Official rounds only — a monthly or weekly add is not a round, and
        // plotting one beside a round would invent movement that never happened.
        const rows = await prisma.usEvaluation.findMany({
          where: { animalId: hit.id, runKind: "official", approvalStatus: "approved" },
          orderBy: { evaluationDate: "asc" },
          select: { roundCode: true, evaluationDate: true, isGraduation: true, [col]: true } as Prisma.UsEvaluationSelect,
        });
        type Row = { roundCode: string | null; evaluationDate: Date; isGraduation: boolean; [k: string]: unknown };
        const series = (rows as unknown as Row[]).map((e) => ({
          round: e.roundCode ? usRoundLabel(e.roundCode) : e.evaluationDate.toISOString().slice(0, 7),
          roundCode: e.roundCode,
          value: (e[col] ?? null) as number | null,
          isGraduation: e.isGraduation,
        }));
        const grad = series.some((s) => s.isGraduation);
        return {
          summary: `${hit.primaryName}: ${series.length} official CDCB round(s) of ${col}. ${US_UNITS_NOTE}${col === "tpi" ? ` ${GTPI_NOTE}` : ""}`,
          records: {
            system: "us", units: US_UNITS_NOTE, name: hit.primaryName, trait: col, series,
            notes: [
              "Every point is an official round — CDCB ships one file per round, so there is no interim proof to fall back to and no month can appear twice.",
              ...(grad ? ["A round flagged isGraduation is the bull's first official round after the young-bull list. He moves roughly six times a normal round there, so that step is a change of evaluation type, not a proof holding or slipping."] : []),
              ...(US_INTERMEDIATE_COLS.has(col) ? [RPA_NOTE] : []),
            ],
          },
        };
      });
      const col = traitCol(input.trait as string);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      const where: Prisma.AnimalWhereInput = reg
        ? { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }
        : { archived: false, primaryName: { contains: name, mode: "insensitive" } };
      const a = await prisma.animal.findFirst({ where, select: { primaryName: true, evaluations: { orderBy: { evaluationDate: "asc" }, select: { proofRun: true, evaluationDate: true, runKind: true, [col]: true } } } });
      if (!a) return { summary: `No sire found for ${reg || name}.`, records: null };
      // Collapse to one point per round — official proof preferred, interim only
      // used to fill this trait when the official round lacks it.
      type Ev = { proofRun: string | null; evaluationDate: Date; runKind: string | null; [k: string]: unknown };
      const byPeriod = new Map<string, { official?: Ev; interim?: Ev }>();
      for (const raw of a.evaluations as unknown as Ev[]) {
        const k = periodKey(raw.evaluationDate);
        const g = byPeriod.get(k) ?? {};
        if (isOfficialEval(raw)) g.official = raw; else g.interim = raw;
        byPeriod.set(k, g);
      }
      const series = [...byPeriod.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, g]) => {
        const base = g.official ?? g.interim!;
        const valOff = g.official ? (g.official[col] as number | null) : null;
        const valInt = g.interim ? (g.interim[col] as number | null) : null;
        const value = valOff != null ? valOff : valInt;
        const source = valOff != null ? "official" : valInt != null ? "interim" : isOfficialEval(base) ? "official" : "interim";
        return { round: base.proofRun ?? base.evaluationDate.toISOString().slice(0, 7), value, source };
      });
      return { summary: `${a.primaryName}: ${series.length} round(s) of ${col} (official proof per round).`, records: { name: a.primaryName, trait: col, series } };
    },
  },
  {
    name: "pedigree_index",
    description: "An animal's 3-generation pedigree (sire/dam/MGS/MGD/GMGS/GMGD) plus, for held sires, the estimated Pedigree Index (parent average LPI from male-line ancestors) and its confidence. Use for 'pedigree', 'what's <reg>'s pedigree', 'what does his pedigree suggest', 'ancestors'. If the animal is NOT in the database and a registration number is given, it falls back to a LIVE Lactanet pedigree lookup (read-only) — so you can answer a pedigree question WITHOUT importing the animal. By name alone there's no external lookup. For the deep maternal line (up to 15 generations) use trace_maternal_line. NOTE the ancestry itself is country-neutral — the same sire and dam whichever system you are discussing — but the estimated Pedigree Index is a CANADIAN LPI figure built from Canadian ancestor proofs. There is no American pedigree index; never present the LPI estimate as if it belonged to a US question.",
    input_schema: { type: "object", properties: { name: { type: "string" }, reg: { type: "string" } } },
    run: async (input, ctx) => {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const reg = typeof input.reg === "string" ? input.reg.trim() : "";
      const where: Prisma.AnimalWhereInput = reg
        ? { archived: false, identifiers: { some: { idValue: { equals: reg, mode: "insensitive" } } } }
        : { archived: false, primaryName: { contains: name, mode: "insensitive" } };
      const a = await prisma.animal.findFirst({ where, select: { primaryName: true, pedigreeRefs: { select: { notes: true } } } });
      if (!a) {
        // Not held — look the pedigree up live on Lactanet (read-only, not saved),
        // so a pedigree question never requires importing the animal first.
        if (reg) {
          requireCap(ctx, "animal:read", "look a pedigree up on Lactanet");
          return externalPedigree(reg);
        }
        return { summary: `No animal named "${name}" is in your database. Give me its registration number (e.g. HOCANF15232832) and I'll pull the pedigree live from Lactanet — no import needed.`, records: null };
      }
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
      "EXHAUSTIVE record for ONE animal by exact name or registration number — EVERY field held, not the curated subset the other tools return. Returns: identity/status fields; ALL genetic traits on the preferred evaluation, UNPACKED from storage (up to ~60 when present) — indexes (LPI, Pro$, PI, LTI, HWI, RI, MI, EI), production (MILK, FAT, PROT, %F, %P, SCS), functional & health/fertility (HL, LP, DF=Daughter Fertility, CA/DCA=Calving Ability, MDR, MR, HH, BCS, MSPD, MTMP, FE, BMR, METH, CH), conformation composites (CONF, MAMM, FL, DS, RUMP, AFS), and EVERY linear conformation trait (STA, HFE, CHW, BODY, RIB, RA=Rump Angle, PW=Pin Width, LOIN, THURL, FA=Foot Angle, HD, BQ, RLSV, RLRV=Rear Legs Rear View, FLV, LOCO, FUA=Fore Udder Attachment, RAH, RAW, UDEP=Udder Depth, UTEX, MSUS=Median Suspensory/cleft, FTP/RTP=Teat Placement, TL=Teat Length) — each with value, per-trait reliability and percentile rank WHERE PRESENT; plus proof-round history, classification history with section scores, lactation/milk records, and any stored owners/awards where present (breed-association data, not populated from Lactanet). Trait availability VARIES by animal and round — ONLY traits actually stored are returned; anything absent is simply not in the list (do not infer a missing trait is zero). Use this for detailed conformation/linear/health-trait questions or 'everything about' an animal. NOTE: beef traits, non-return-rate, and udder-cleft-as-a-separate-score are NOT tracked in this system. LOOKUP FALLBACK: if the animal is NOT in the database and you were given a registration number, this pulls its profile LIVE from Lactanet (read-only, not saved) so you can still answer 'tell me about <reg>'. By name alone there is no external lookup — ask for the registration number. To SAVE an external animal, use import_animals. SET system:\"us\" FOR THE AMERICAN RECORD instead: every trait CDCB published for him on his preferred OFFICIAL round (value, reliability and parent average per trait, unpacked from storage), which trait groups are daughter-proven versus parent-average, inbreeding, haplotype calls, the calculated GTPI/JPI/UDC/FLC kept in their own list because CDCB does not publish them, his official round history, and whether CDCB's AI-status file lists him as marketed. Everything there is a PTA in POUNDS. There is no live American lookup — US figures exist only for animals whose CDCB rounds have been imported.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Exact or partial animal name" }, reg: { type: "string", description: "Registration number (exact). US: a CDCB 17-char id or a NAAB code also resolves." }, ...SYSTEM_ARG } },
    run: async (input, ctx) => {
      const name = str(input.name), reg = str(input.reg);
      if (!name && !reg) return { summary: "Provide a name or registration number.", records: null };
      if (systemOf(input) === "us") return usRead(async () => {
        const hit = await findUsAnimal(name, reg);
        if (!hit) {
          // No live American fallback exists: the external lookup is Lactanet,
          // which would answer an American question with Canadian numbers.
          return { summary: `No animal found for ${reg || name}. There is no live American lookup — the only external source wired up is Lactanet, which publishes Canadian evaluations, so it cannot answer a CDCB question. American figures come from imported CDCB rounds only.`, records: null };
        }
        const profile = await buildUsProfile(hit.id, hit.primaryName);
        if (!profile?.preferredEvaluation) {
          return { summary: `${hit.primaryName} is held here but has no CDCB evaluation — there is no American proof for him. Say so; do not fall back to his Canadian figures.`, records: profile ?? null };
        }
        return { summary: `Full AMERICAN (CDCB) profile for ${hit.primaryName}: ${profile.preferredEvaluation.traitCount} traits on the preferred official round, ${profile.proofRoundHistory.length} official round(s) on file. ${US_UNITS_NOTE}`, records: profile };
      });
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
      "Project a MATING between a sire (male) and dam (female) as the Parent Average (PA = simple mean of the two parents) across every trait BOTH animals have. Answers 'what would a mating of X and Y produce', 'PA of X × Y'. For each shared numeric trait it returns the sire value, the dam value, and the computed PA; categorical descriptors (A2/colour/polled) are returned side-by-side without a mean; traits held by only one parent are listed under unavailableForPA and are NEVER guessed or defaulted to zero. Each parent's overall reliability, evaluation basis (proven vs genomic/parent-average), genotyped flag and daughter count are included so you can caveat how trustworthy the projection is. FLOW: internal database first; if a parent is NOT in the database AND a registration number was supplied, it does a LIVE Lactanet lookup for that reg and clearly labels those values as externally sourced (possibly on a different evaluation basis than internal proofs). Externally-pulled data is SESSION-ONLY and is NOT saved unless saveToDatabase=true — always confirm with the user before setting that. If a parent is missing and cannot be looked up (no reg, or Lactanet has nothing / the lookup fails), it reports that plainly and does NOT return a partial PA. CANADIAN ONLY: every value here is a Lactanet trait — EBVs in kilograms. There is no American mating calculator, so never label its output with US trait names or mix a CDCB figure into it.",
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
      "CREATE a new animal or UPDATE an existing one's identity fields. A CREATE is STAGED in the admin Review Queue (approved before the animal exists); an UPDATE takes a two-step confirm (call once to preview the exact changes, then again with confirm:true) — tell the user which. To UPDATE, give animalId (or a name/reg that resolves to exactly one animal); to CREATE, omit all three and give primaryName. Fields: primaryName, shortName, sex ('M'|'F'), breedCode (e.g. HO/JE/AY/BS) or breedId, birthDate (yyyy-mm-dd), countryOfOrigin ('CA'|'US'|'INT'), currentStatus (active|proven|genomic|retired|reference), notes. Optional `identifiers`: array of { idType, idValue, isPrimary?, country?, org? }. IMPORTANT: on an UPDATE, supplying identifiers REPLACES the whole identifier list — include every one you want to keep. Mirrors the New/Edit Animal screens. Requires the animal:write permission. Does NOT touch proofs/classifications/milk — use the record tools for those.",
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
        confirm: { type: "boolean", description: "UPDATE only: set true ONLY after the user has agreed to the exact changes you previewed." },
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
        // Editing an existing animal's identity can't be staged through the review
        // queue (that path only CREATES records), so it takes a two-step confirm:
        // a wrong fuzzy-name match must not silently rewrite the wrong bull's name.
        const changed: string[] = [];
        if (str(input.primaryName)) changed.push(`name → "${str(input.primaryName)}"`);
        if (input.shortName !== undefined) changed.push(`short name → "${str(input.shortName)}"`);
        if (str(input.sex)) changed.push(`sex → ${str(input.sex)}`);
        if (breedId) changed.push(`breed → ${breedCode || breedId}`);
        if (input.birthDate !== undefined) changed.push(`birth date → ${str(input.birthDate) || "cleared"}`);
        if (input.countryOfOrigin !== undefined) changed.push(`country → ${str(input.countryOfOrigin) || "cleared"}`);
        if (str(input.currentStatus)) changed.push(`status → ${str(input.currentStatus)}`);
        if (input.notes !== undefined) changed.push("notes updated");
        if (identifiers) changed.push(`REPLACE all identifiers with ${identifiers.length}`);
        const gate = confirmGate(input, `Update ${target.name}: ${changed.join("; ") || "no changes specified"}.`, { animalId: target.id, name: target.name, changes: changed });
        if (gate) return gate;
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
      // A new animal is staged for admin approval, then materialised by the same
      // review-approval path used for extracted-data imports.
      const idList = (identifiers ?? []).map((r) => ({ idType: r.idType, idValue: r.idValue, isPrimary: r.isPrimary }));
      const summary = `Create a new ${str(input.sex) || "F"} animal "${primaryName}"${breedCode ? ` (${breedCode})` : ""}${idList.length ? ` with ${idList.length} identifier(s): ${idList.map((i) => `${i.idType} ${i.idValue}`).join(", ")}` : ""}.`;
      const { reviewId } = await (await import("./stage-record")).stageAgentRecord({
        userId: actor.uid, proposedRecordType: "animal", matchedAnimalId: null,
        data: { primaryName, shortName: str(input.shortName) || undefined, sex: str(input.sex) || "F", breedCode: breedCode || undefined, country: str(input.countryOfOrigin) || undefined, identifiers: idList },
        summary,
      });
      await logAction(actor, "animal", "stage", reviewId, { primaryName });
      return { summary: `Staged for admin approval — ${summary} In the Review Queue (id ${reviewId}); the animal is not created until an admin approves it there.`, records: { reviewId, staged: true, name: primaryName } };
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
      "Record a genetic evaluation (proof) for ONE animal by manual entry. Resolve the animal by animalId/name/reg. Give `traits` as an object of trait code → value, e.g. {\"LPI\":3200,\"CONF\":12,\"MILK\":900,\"FAT\":40}. Optional: evaluationDate (yyyy-mm-dd, default today), proofRun label (e.g. 'April 2026'), countrySystem, notes. Requires record:write. STAGED FOR APPROVAL: the proof is placed in the admin Review Queue with a summary and does NOT affect the animal until an admin approves it there — tell the user this. To pull OFFICIAL Lactanet proofs use import_bulls instead of typing them in.",
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
      // Staged for admin approval rather than written directly: the animal may have
      // been resolved by a fuzzy name match, and a genetic proof is exactly the kind
      // of value that must never land on the wrong bull unseen.
      const traitsMap: Record<string, number | string> = {};
      for (const t of raw) traitsMap[t.traitCode] = t.numericValue ?? (t.textValue as string);
      const evaluationDate = str(input.evaluationDate) || undefined;
      const proofRun = str(input.proofRun) || undefined;
      const traitList = raw.map((t) => `${t.traitCode} ${t.numericValue ?? t.textValue}`).join(", ");
      const summary = `Add a genetic proof to ${target.name}: ${raw.length} trait(s) — ${traitList}${proofRun ? `; run "${proofRun}"` : ""}${evaluationDate ? `; dated ${evaluationDate}` : ""}.`;
      const { reviewId } = await (await import("./stage-record")).stageAgentRecord({
        userId: actor.uid, proposedRecordType: "genetic_evaluation", matchedAnimalId: target.id,
        data: { traits: traitsMap, evaluationDate, proofRun, countrySystem: str(input.countrySystem) || undefined },
        summary,
      });
      await logAction(actor, "genetic_evaluation", "stage", reviewId, { animalId: target.id, traits: raw.length });
      return { summary: `Staged for admin approval — ${summary} It is in the Review Queue (id ${reviewId}) and will NOT affect ${target.name} until an admin approves it there.`, records: { reviewId, staged: true, animalId: target.id, name: target.name } };
    },
  },

  {
    name: "add_milk_record",
    description: "Record a lactation / milk record for a cow. Resolve by animalId/name/reg. Fields: recordDate (yyyy-mm-dd, default today), lactationNumber, milkAmount, milkUnit (default kg), fatAmount, fatPercent, proteinAmount, proteinPercent. Requires record:write. STAGED FOR APPROVAL: goes to the admin Review Queue and does NOT affect the animal until approved there — tell the user.",
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
      const recordDate = str(input.recordDate) || undefined;
      const parts = [
        toNum(input.milkAmount) != null ? `${toNum(input.milkAmount)} ${str(input.milkUnit) || "kg"} milk` : null,
        toNum(input.fatAmount) != null ? `${toNum(input.fatAmount)} fat` : null,
        toNum(input.proteinAmount) != null ? `${toNum(input.proteinAmount)} protein` : null,
      ].filter(Boolean).join(", ");
      const summary = `Add a milk record to ${target.name}${toNum(input.lactationNumber) != null ? ` (lactation ${toNum(input.lactationNumber)})` : ""}${recordDate ? `, dated ${recordDate}` : ""}${parts ? `: ${parts}` : ""}.`;
      const { reviewId } = await (await import("./stage-record")).stageAgentRecord({
        userId: actor.uid, proposedRecordType: "milk_record", matchedAnimalId: target.id,
        data: {
          recordDate, lactationNumber: toNum(input.lactationNumber) ?? undefined,
          milkAmount: toNum(input.milkAmount) ?? undefined, fatAmount: toNum(input.fatAmount) ?? undefined,
          fatPercent: toNum(input.fatPercent) ?? undefined, proteinAmount: toNum(input.proteinAmount) ?? undefined,
          proteinPercent: toNum(input.proteinPercent) ?? undefined,
        },
        summary,
      });
      await logAction(actor, "milk_record", "stage", reviewId, { animalId: target.id });
      return { summary: `Staged for admin approval — ${summary} In the Review Queue (id ${reviewId}); it won't affect ${target.name} until approved there.`, records: { reviewId, staged: true, animalId: target.id, name: target.name } };
    },
  },

  {
    name: "add_classification",
    description: "Record a classification for a cow. Resolve by animalId/name/reg. Fields: classificationDate (yyyy-mm-dd, default today), finalScore, classificationCode (EX|VG|GP|G...), lactationNumber. Optional `traits`: object of classification trait code → value (linear/section scores). Requires record:write. STAGED FOR APPROVAL: goes to the admin Review Queue and does NOT affect the animal until approved there — tell the user.",
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
      const finalScore = toNum(input.finalScore);
      const code = str(input.classificationCode) || undefined;
      const traitsIn = input.traits && typeof input.traits === "object" && !Array.isArray(input.traits) ? (input.traits as Record<string, unknown>) : {};
      const traitsMap: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(traitsIn)) if (v != null && v !== "") traitsMap[k] = v as string | number;
      const classificationDate = str(input.classificationDate) || undefined;
      const summary = `Add a classification to ${target.name}${code ? `: ${code}` : ""}${finalScore != null ? ` ${finalScore}` : ""}${classificationDate ? `, dated ${classificationDate}` : ""}${Object.keys(traitsMap).length ? ` (+${Object.keys(traitsMap).length} linear trait(s))` : ""}.`;
      const { reviewId } = await (await import("./stage-record")).stageAgentRecord({
        userId: actor.uid, proposedRecordType: "classification", matchedAnimalId: target.id,
        data: { classificationDate, finalScore: finalScore ?? undefined, classificationCode: code, lactationNumber: toNum(input.lactationNumber) ?? undefined, traits: traitsMap },
        summary,
      });
      await logAction(actor, "classification", "stage", reviewId, { animalId: target.id });
      return { summary: `Staged for admin approval — ${summary} In the Review Queue (id ${reviewId}); it won't affect ${target.name} until approved there.`, records: { reviewId, staged: true, animalId: target.id, name: target.name } };
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
    name: "trace_maternal_line",
    description:
      "Trace an animal's MATERNAL (tail-female) line — its dam, then the dam's dam, and so on — up to 15 generations, LIVE from Lactanet. Needs a registration number (works for any animal, whether or not it's in the database). Read-only; nothing is saved. Each generation is one live Lactanet fetch, so it stops at the requested depth, when Lactanet has no registration for the next dam (the trail ends), or when a time budget is hit — and it tells you how far it reached and why it stopped. Set includeClassifications:true to ALSO fetch each dam's classification (EX/VG score) — useful for a cow-family view — but that doubles the fetches, so the depth is capped at 8 generations when it's on. Use this for the deep maternal line or 'N generations back on the dam side'. For the SIRE and the immediate 3-generation pedigree, use get_animal_full_profile or pedigree_index.",
    input_schema: {
      type: "object",
      properties: {
        reg: { type: "string", description: "registration number, e.g. HOCANF12345678" },
        generations: { type: "integer", description: "how many generations back on the dam side (default 15, max 15; max 8 when includeClassifications is on)" },
        includeClassifications: { type: "boolean", description: "also fetch each dam's classification (EX/VG score) — slower, capped at 8 generations" },
      },
      required: ["reg"],
    },
    run: async (input, ctx) => {
      requireCap(ctx, "animal:read", "trace a maternal line on Lactanet");
      const reg = str(input.reg);
      if (!reg) return { summary: "Provide a registration number to trace the maternal line.", records: null };
      const inclClass = input.includeClassifications === true;
      return traceMaternalLine(reg, clamp(input.generations, 1, 15, inclClass ? 8 : 15), inclClass);
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
