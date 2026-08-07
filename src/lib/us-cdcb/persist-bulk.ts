import "server-only";

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { CdcbAnimal } from "./parse";
import { cdcbRoundDate, type CdcbFileId } from "./file-kind";
import { parseId17, id17ToCaReg, caRegToId17Candidates, assessLink, normalizeNaab } from "./identity";
import { computeTpi, TpiUnavailable } from "./index-registry";
import { computeJpi, JpiUnavailable } from "./jpi";
import { CDCB_ID_TYPE } from "./persist";

// ---------------------------------------------------------------------------
// BULK import of a whole CDCB round.
//
// WHY THIS EXISTS. persistCdcbAnimal() issues ~6 queries per animal, which is
// right for a one-off write (the agent, the review queue) but is the wrong shape
// for a round: the April-2026 Holstein file alone is 51,497 animals, so
// per-animal resolution would be ~300,000 round-trips to a remote database —
// hours of wall clock, and every one of them holding a connection from a pool
// that src/lib/db.ts deliberately keeps small.
//
// This path instead does a FIXED number of queries per file regardless of size:
// pre-load the identifier maps once, resolve every animal in memory, then write
// in chunks. Same resolution rules and the same refusal-on-conflict behaviour —
// only the plumbing differs.
// ---------------------------------------------------------------------------

const CHUNK = 500;

export interface BulkOutcome {
  animals: number;
  createdAnimals: number;
  linked: number;
  conflicts: { id17: string; reason: string }[];
  evaluations: number;
  withTpi: number;
  withJpi: number;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const yn = (v: string | undefined) => (v === "Y" ? true : v === "N" ? false : null);
const dateFromYmd = (s: string | undefined) => {
  if (!s || !/^\d{8}$/.test(s)) return null;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  return Number.isNaN(d.getTime()) ? null : d;
};
const HAPLO = /^(HH\d|HH[BCDMPR]|HMW|JH1|JHP|JNS|BH\d+|BH[DMPW]|AH\d|AHC|HBR|HCD|HDR)(_PC)?$/;

/** Every registration form a CDCB id17 could be stored under on the Canadian side. */
function regCandidatesFor(id17: string, sex: "M" | "F"): string[] {
  const p = parseId17(id17);
  if (!p) return [];
  const out = new Set<string>();
  const bare = id17ToCaReg(id17, sex);
  if (bare) out.add(bare);
  for (const alt of ["CAN", "124", "USA", "840"]) {
    const r = id17ToCaReg(`${p.breed}${alt}${p.number}`, sex);
    if (r) out.add(r);
  }
  return [...out];
}

export async function persistCdcbRound(
  animals: CdcbAnimal[],
  file: CdcbFileId,
  ctx: { sourceFile: string; userId?: string | null; onProgress?: (done: number, total: number) => void },
): Promise<BulkOutcome> {
  if (!file.periodKey || !file.family || !file.kind) throw new Error(`Unclassified file: ${ctx.sourceFile}`);
  const evaluationDate = cdcbRoundDate(file);
  if (!evaluationDate) throw new Error(`No evaluation date for ${ctx.sourceFile}`);

  const out: BulkOutcome = { animals: animals.length, createdAnimals: 0, linked: 0, conflicts: [], evaluations: 0, withTpi: 0, withJpi: 0 };

  // ---- 1. Pre-load the lookup maps. Three queries, not 3 x 51,497. ----------
  const id17s = animals.map((a) => a.id17);
  const byId17 = new Map<string, string>();
  for (let i = 0; i < id17s.length; i += 2000) {
    const rows = await prisma.animalIdentifier.findMany({
      where: { idType: CDCB_ID_TYPE, idValue: { in: id17s.slice(i, i + 2000) } },
      select: { animalId: true, idValue: true },
    });
    for (const r of rows) byId17.set(r.idValue, r.animalId);
  }

  // Registration forms for the animals we have NOT already linked.
  const regWanted = new Map<string, string>(); // registration -> id17
  for (const a of animals) {
    if (byId17.has(a.id17)) continue;
    for (const r of regCandidatesFor(a.id17, a.info.SEX === "F" ? "F" : "M")) regWanted.set(r, a.id17);
  }
  const regKeys = [...regWanted.keys()];
  const byReg = new Map<string, { animalId: string; idValue: string; name: string }>();
  for (let i = 0; i < regKeys.length; i += 2000) {
    const rows = await prisma.animalIdentifier.findMany({
      where: { idValue: { in: regKeys.slice(i, i + 2000) }, idType: { startsWith: "registration" } },
      select: { animalId: true, idValue: true, animal: { select: { primaryName: true } } },
    });
    for (const r of rows) byReg.set(r.idValue, { animalId: r.animalId, idValue: r.idValue, name: r.animal.primaryName });
  }

  // Stored NAAB codes for the animals we might link, so a disagreement can block.
  const candidateAnimalIds = [...new Set([...byReg.values()].map((v) => v.animalId))];
  const naabByAnimal = new Map<string, string>();
  for (let i = 0; i < candidateAnimalIds.length; i += 2000) {
    const rows = await prisma.animalIdentifier.findMany({
      where: { animalId: { in: candidateAnimalIds.slice(i, i + 2000) }, idType: "naab", active: true },
      select: { animalId: true, idValue: true },
    });
    for (const r of rows) if (!naabByAnimal.has(r.animalId)) naabByAnimal.set(r.animalId, r.idValue);
  }

  // ---- 2. Resolve every animal in memory ----------------------------------
  const breeds = new Map((await prisma.breed.findMany({ select: { breedId: true, breedCode: true } })).map((b) => [b.breedCode, b.breedId]));
  const toCreate: { a: CdcbAnimal }[] = [];
  const resolved = new Map<string, string>(); // id17 -> animalId

  for (const a of animals) {
    const already = byId17.get(a.id17);
    if (already) { resolved.set(a.id17, already); out.linked++; continue; }

    let hit: { animalId: string; idValue: string; name: string } | undefined;
    for (const r of regCandidatesFor(a.id17, a.info.SEX === "F" ? "F" : "M")) {
      const m = byReg.get(r);
      if (m) { hit = m; break; }
    }
    if (hit) {
      const cand = caRegToId17Candidates(hit.idValue).find((c) => c.id17 === a.id17)
        ?? { id17: a.id17, confidence: "candidate" as const, caveat: "matched by reverse transform only" };
      const check = assessLink(cand, {
        storedName: hit.name, cdcbName: a.info.ANIM_NAME,
        storedNaab: naabByAnimal.get(hit.animalId), cdcbNaab: a.info.NAAB_CODE,
      });
      if (check.linked) { resolved.set(a.id17, hit.animalId); out.linked++; continue; }
      // Refused: a plausible match whose evidence disagrees. Record it and import
      // as a separate animal rather than writing over another bull's identity.
      out.conflicts.push({ id17: a.id17, reason: check.conflict ?? "unconfirmed candidate match" });
    }
    toCreate.push({ a });
  }

  // ---- 3. Create the new animals in chunks --------------------------------
  for (let i = 0; i < toCreate.length; i += CHUNK) {
    const slice = toCreate.slice(i, i + CHUNK);
    // createMany cannot return ids, so create then re-read by a marker we control:
    // the cdcb id17 identifier we write immediately after.
    const made = await prisma.$transaction(
      slice.map(({ a }) => prisma.animal.create({
        data: {
          primaryName: a.info.ANIM_NAME?.trim() || a.id17,
          sex: a.info.SEX === "F" ? "F" : "M",
          breedId: a.info.EVAL_BREED ? breeds.get(a.info.EVAL_BREED) ?? null : null,
          birthDate: dateFromYmd(a.info.BIRTH),
          countryOfOrigin: parseId17(a.id17)?.country === "CAN" ? "CA" : "US",
          currentStatus: "active",
          createdById: ctx.userId ?? undefined,
          notes: `Imported from CDCB (${ctx.sourceFile}).`,
        },
        select: { id: true },
      })),
    );
    made.forEach((m, k) => resolved.set(slice[k].a.id17, m.id));
    out.createdAnimals += made.length;
  }

  // ---- 4. Tag every animal with its CDCB id (skip ones already tagged) -----
  const needTag = animals.filter((a) => !byId17.has(a.id17)).map((a) => ({
    animalId: resolved.get(a.id17)!, idType: CDCB_ID_TYPE, idValue: a.id17, active: true,
  })).filter((r) => r.animalId);
  for (let i = 0; i < needTag.length; i += CHUNK) {
    await prisma.animalIdentifier.createMany({ data: needTag.slice(i, i + CHUNK) });
  }

  // ---- 5. Write the evaluations -------------------------------------------
  // Delete-then-create for this (period, family) so a re-import is idempotent —
  // the same pattern the Canadian importer uses. Scoped to the animals in THIS
  // file, so it can never touch a round it is not importing.
  const animalIds = [...resolved.values()];
  for (let i = 0; i < animalIds.length; i += 2000) {
    await prisma.usEvaluation.deleteMany({
      where: { animalId: { in: animalIds.slice(i, i + 2000) }, periodKey: file.periodKey, sourceFamily: file.family },
    });
  }

  const rows: Prisma.UsEvaluationCreateManyInput[] = [];
  for (const a of animals) {
    const animalId = resolved.get(a.id17);
    if (!animalId) continue;

    const gpta: Record<string, number> = {}, rel: Record<string, number> = {};
    const gsons: Record<string, number> = {}, dgv: Record<string, number> = {}, pa: Record<string, number> = {};
    for (const [code, v] of Object.entries(a.traits)) {
      if (v.gpta != null) gpta[code] = v.gpta;
      if (v.grel != null) rel[code] = v.grel;
      if (v.gsons != null) gsons[code] = v.gsons;
      if (v.dgv != null) dgv[code] = v.dgv;
      if (v.pa != null) pa[code] = v.pa;
    }
    const g = (c: string) => a.traits[c]?.gpta ?? null;

    // Indexes only for a real triannual round — a provisional monthly must never
    // carry an authoritative-looking figure.
    let tpi: ReturnType<typeof computeTpi> = null;
    let jpi: ReturnType<typeof computeJpi> = null;
    if (file.roundCode) {
      try { if (a.info.EVAL_BREED === "HO") tpi = computeTpi(gpta, file.roundCode); }
      catch (e) { if (!(e instanceof TpiUnavailable)) throw e; }
      try { if (a.info.EVAL_BREED === "JE") jpi = computeJpi(gpta, file.roundCode); }
      catch (e) { if (!(e instanceof JpiUnavailable)) throw e; }
    }
    if (tpi) out.withTpi++;
    if (jpi) out.withJpi++;

    const haplo: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.info)) if (HAPLO.test(k) && v) haplo[k] = v;

    rows.push({
      animalId, id17: a.id17,
      sourceFamily: file.family!, runKind: file.kind!, roundCode: file.roundCode, periodKey: file.periodKey!,
      evaluationDate, evalBreed: a.info.EVAL_BREED || null,
      isPtaMilk: yn(a.info.IS_PTA_MILK), isPtaCt: yn(a.info.IS_PTA_CT),
      blendCode: a.info.BLEND_CODE || null, heterosis: num(a.info.HETEROSIS),
      naabCode: normalizeNaab(a.info.NAAB_CODE), sire17: a.info.SIRE17 || null, dam17: a.info.DAM17 || null,
      genInb: num(a.info.GEN_INB), pedInb: num(a.info.PED_INB),
      genFutInb: num(a.info.GEN_FUT_INB), expFutInb: num(a.info.EXP_FUT_INB),
      chip: a.info.CHIP || null, requesterId: a.info.REQUESTER_ID || null,
      dateReceived: dateFromYmd(a.info.DATE_RECEIVED), current: a.info.CURRENT || null,
      gptaJson: JSON.stringify(gpta), relJson: JSON.stringify(rel), gsonsJson: JSON.stringify(gsons),
      dgvJson: JSON.stringify(dgv), paJson: JSON.stringify(pa),
      haplotypesJson: Object.keys(haplo).length ? JSON.stringify(haplo) : null,
      nmDollar: g("NM"), cmDollar: g("CM"), fmDollar: g("FM"), gmDollar: g("GM"),
      milk: g("MILK"), fat: g("FAT"), pro: g("PRO"), fatPct: g("FATPCT"), proPct: g("PROPCT"),
      pl: g("PL"), scs: g("SCS"), dpr: g("DPR"), ccr: g("CCR"),
      ptat: g("PTAT"), rpa: g("RPA"), liv: g("LIV"),
      udc: tpi ? tpi.composites.udc : null, flc: tpi ? tpi.composites.flc : null,
      tpi: tpi?.value ?? null, tpiFormulaVersion: tpi?.formula.tpi.label ?? null, tpiConfidence: tpi?.confidence ?? null,
      jpi: jpi?.value ?? null, jpiFormulaVersion: jpi?.version.label ?? null,
      sourceFile: ctx.sourceFile, createdById: ctx.userId ?? undefined,
    });
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await prisma.usEvaluation.createMany({ data: rows.slice(i, i + CHUNK) });
    out.evaluations += r.count;
    ctx.onProgress?.(Math.min(i + CHUNK, rows.length), rows.length);
  }

  return out;
}

/**
 * Recompute the preferred US evaluation for many animals at once.
 *
 * Only triannual ('official') rows are candidates, so a provisional monthly add
 * can never become an animal's authoritative US proof.
 */
export async function recomputeUsPreferredBulk(animalIds: string[]): Promise<number> {
  let set = 0;
  for (let i = 0; i < animalIds.length; i += 2000) {
    const slice = animalIds.slice(i, i + 2000);
    await prisma.usEvaluation.updateMany({ where: { animalId: { in: slice } }, data: { isPreferred: false } });
    const rows = await prisma.usEvaluation.findMany({
      where: { animalId: { in: slice }, runKind: "official", approvalStatus: "approved" },
      orderBy: [{ evaluationDate: "desc" }, { sourceFamily: "asc" }],
      select: { usEvaluationId: true, animalId: true },
    });
    const winner = new Map<string, string>();
    for (const r of rows) if (!winner.has(r.animalId)) winner.set(r.animalId, r.usEvaluationId);
    const ids = [...winner.values()];
    for (let k = 0; k < ids.length; k += 1000) {
      const res = await prisma.usEvaluation.updateMany({ where: { usEvaluationId: { in: ids.slice(k, k + 1000) } }, data: { isPreferred: true } });
      set += res.count;
    }
  }
  return set;
}
