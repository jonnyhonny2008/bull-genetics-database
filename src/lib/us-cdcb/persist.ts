import "server-only";

import { prisma } from "@/lib/db";
import type { CdcbAnimal } from "./parse";
import { cdcbRoundDate, cdcbRoundLabel, type CdcbFileId } from "./file-kind";
import { caRegToId17Candidates, parseId17, id17ToCaReg, assessLink, normalizeNaab } from "./identity";
import { computeTpi, TpiUnavailable } from "./index-registry";
import { computeJpi, JpiUnavailable } from "./jpi";

// ---------------------------------------------------------------------------
// Persist one parsed CDCB animal as a UsEvaluation, linked to the Animal this
// app already holds wherever one exists.
//
// LINKING IS THE WHOLE GAME. The "Blondin bull" flag is an AnimalRole on the
// Animal, so a successful link brings the flag, favourites, pedigree links and
// notes along with no extra code — and every FAILED link silently creates an
// unflagged duplicate bull. So resolution is deliberate:
//
//   1. an existing `cdcb_id17` identifier          (already linked once)
//   2. a Canadian registration that transforms to this id17, trying the country
//      variants, and gated by assessLink() so a candidate-grade match needs a
//      confirming name or NAAB and a DISAGREEING NAAB blocks the link entirely
//   3. otherwise create a US-only Animal
//
// It never falls back to matching on NAAB alone: codes are recycled between
// bulls, and src/lib/proof-import.ts documents how that grafts a new bull's proof
// onto the last holder.
// ---------------------------------------------------------------------------

/** The CDCB id, stored as its own identifier type so it never collides with the
 *  19-char Interbull format that pedigree lookups also read by bare value. */
export const CDCB_ID_TYPE = "cdcb_id17";

const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v);
const yn = (v: string | undefined) => (v === "Y" ? true : v === "N" ? false : null);
const dateFromYmd = (s: string | undefined) => {
  if (!s || !/^\d{8}$/.test(s)) return null;
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The haplotype / genetic-condition keys CDCB ships in infoANIM. */
const HAPLOTYPE_KEYS = /^(HH\d|HH[BCDMPR]|HMW|JH1|JHP|JNS|BH\d+|BH[DMPW]|AH\d|AHC|HBR|HCD|HDR)(_PC)?$/;

export interface PersistOutcome {
  usEvaluationId: string;
  /** The American roster row this evaluation belongs to. Always set. */
  usAnimalId: string;
  /** The Canadian Animal this bull is ALSO registered as, when there is one.
   *  Null is the ordinary case: most American bulls are not Canadian bulls. */
  animalId: string | null;
  /** True when this import created a brand-new UsAnimal rather than updating one. */
  createdAnimal: boolean;
  linked: "existing-cdcb-id" | "registration" | "new";
  /** Set when a plausible match was REFUSED — route these to review rather than
   *  importing them blind. */
  conflict?: string;
  tpi: number | null;
  jpi: number | null;
}

/**
 * Resolve which Animal a CDCB record belongs to, creating one only as a last
 * resort. Returns a conflict instead of linking when the evidence disagrees.
 */
async function resolveAnimal(a: CdcbAnimal): Promise<{ animalId: string | null; how: PersistOutcome["linked"]; conflict?: string }> {
  // 1. A bridge this bull already carries from a previous import. It lives on the
  //    UsAnimal row now rather than on an AnimalIdentifier — the identifier was
  //    written in a second pass, so an interrupted run left rows unmarked.
  const existing = await prisma.usAnimal.findUnique({
    where: { id17: a.id17 },
    select: { animalId: true },
  });
  if (existing?.animalId) return { animalId: existing.animalId, how: "existing-cdcb-id" };

  // 2. A stored Canadian registration that transforms to this id17. Rather than
  //    transforming every registration in the table, invert: build the candidate
  //    registrations this id17 could have been stored as, and look those up.
  const parts = parseId17(a.id17);
  if (parts) {
    const sex = (a.info.SEX === "F" ? "F" : "M") as "M" | "F";
    const regCandidates = new Set<string>();
    const bare = id17ToCaReg(a.id17, sex);
    if (bare) regCandidates.add(bare);
    // Country variants: an animal stored as HOCANM… may arrive here as HO124…
    for (const alt of ["CAN", "124", "USA", "840"]) {
      const r = id17ToCaReg(`${parts.breed}${alt.padEnd(3, " ").trim()}${parts.number}`, sex);
      if (r) regCandidates.add(r);
    }

    const hit = await prisma.animalIdentifier.findFirst({
      where: { idValue: { in: [...regCandidates] }, idType: { startsWith: "registration" } },
      select: { animalId: true, idValue: true, animal: { select: { primaryName: true } } },
    });
    if (hit) {
      // Re-derive the candidate from the STORED registration so its confidence
      // reflects the real failure modes (letters in the number, untrusted country).
      const cand = caRegToId17Candidates(hit.idValue).find((c) => c.id17 === a.id17)
        ?? { id17: a.id17, confidence: "candidate" as const, caveat: "registration matched by reverse transform only" };
      const storedNaab = await prisma.animalIdentifier.findFirst({
        where: { animalId: hit.animalId, idType: "naab", active: true },
        select: { idValue: true },
      });
      const check = assessLink(cand, {
        storedName: hit.animal.primaryName,
        cdcbName: a.info.ANIM_NAME,
        storedNaab: storedNaab?.idValue,
        cdcbNaab: a.info.NAAB_CODE,
      });
      if (check.linked) return { animalId: hit.animalId, how: "registration" };
      return { animalId: null, how: "new", conflict: check.conflict };
    }
  }

  return { animalId: null, how: "new" };
}

/** Pack the five CDCB value columns into per-column code→value maps. */
function packTraitColumns(a: CdcbAnimal) {
  const gpta: Record<string, number> = {}, rel: Record<string, number> = {};
  const gsons: Record<string, number> = {}, dgv: Record<string, number> = {}, pa: Record<string, number> = {};
  for (const [code, v] of Object.entries(a.traits)) {
    if (v.gpta != null) gpta[code] = v.gpta;
    if (v.grel != null) rel[code] = v.grel;
    if (v.gsons != null) gsons[code] = v.gsons;
    if (v.dgv != null) dgv[code] = v.dgv;
    if (v.pa != null) pa[code] = v.pa;
  }
  return { gpta, rel, gsons, dgv, pa };
}

/**
 * Write one CDCB animal's evaluation.
 *
 * Idempotent on (animalId, periodKey, sourceFamily): re-importing the same file
 * updates in place rather than stacking duplicate rounds.
 */
export async function persistCdcbAnimal(
  a: CdcbAnimal,
  file: CdcbFileId,
  ctx: { sourceFile: string; userId?: string | null },
): Promise<PersistOutcome> {
  if (!file.periodKey || !file.family || !file.kind) {
    throw new Error(`Refusing to import from an unclassified file: ${ctx.sourceFile}`);
  }
  const evaluationDate = cdcbRoundDate(file);
  if (!evaluationDate) throw new Error(`Could not derive an evaluation date for ${ctx.sourceFile}`);

  // Resolving a Canadian Animal no longer decides whether a row is created. Every
  // American bull gets a UsAnimal of his own; a match only supplies the OPTIONAL
  // bridge that makes the double card and the nav toggle work for a bull who is
  // registered in both countries.
  const resolved = await resolveAnimal(a);
  const bridge = resolved.animalId ?? null;

  const existing = await prisma.usAnimal.findUnique({ where: { id17: a.id17 }, select: { usAnimalId: true } });
  const createdAnimal = !existing;

  const fields = {
    name: a.info.ANIM_NAME?.trim() || a.id17,
    naabCode: a.info.NAAB_CODE ? normalizeNaab(a.info.NAAB_CODE) : null,
    breedCode: a.info.EVAL_BREED ?? null,
    sex: a.info.SEX === "F" ? "F" : "M",
    birthDate: dateFromYmd(a.info.BIRTH),
    sire17: a.info.SIRE_ID ?? null,
    dam17: a.info.DAM_ID ?? null,
  };
  // Set a bridge when we have one, but never CLEAR one already established — a
  // later round may resolve a link an earlier one could not.
  const { usAnimalId } = await prisma.usAnimal.upsert({
    where: { id17: a.id17 },
    update: { ...fields, ...(bridge ? { animalId: bridge } : {}) },
    create: { id17: a.id17, animalId: bridge, ...fields },
    select: { usAnimalId: true },
  });

  const packed = packTraitColumns(a);
  const g = (code: string) => num(a.traits[code]?.gpta);

  // Indexes are computed ONLY for a real round — a provisional monthly add would
  // otherwise be scored with the round's formula and look authoritative.
  let tpi: ReturnType<typeof computeTpi> = null;
  let jpi: ReturnType<typeof computeJpi> = null;
  if (file.roundCode) {
    const flat: Record<string, number | null> = {};
    for (const [code, v] of Object.entries(a.traits)) flat[code] = v.gpta;
    const breed = a.info.EVAL_BREED;
    try { if (breed === "HO") tpi = computeTpi(flat, file.roundCode); }
    catch (e) { if (!(e instanceof TpiUnavailable)) throw e; }
    try { if (breed === "JE") jpi = computeJpi(flat, file.roundCode); }
    catch (e) { if (!(e instanceof JpiUnavailable)) throw e; }
  }

  const haplotypes: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.info)) if (HAPLOTYPE_KEYS.test(k) && v) haplotypes[k] = v;

  const data = {
    id17: a.id17,
    sourceFamily: file.family,
    runKind: file.kind,
    roundCode: file.roundCode,
    periodKey: file.periodKey,
    evaluationDate,
    evalBreed: a.info.EVAL_BREED || null,
    isPtaMilk: yn(a.info.IS_PTA_MILK),
    isPtaCt: yn(a.info.IS_PTA_CT),
    blendCode: a.info.BLEND_CODE || null,
    heterosis: num(Number(a.info.HETEROSIS)),
    naabCode: normalizeNaab(a.info.NAAB_CODE),
    sire17: a.info.SIRE17 || null,
    dam17: a.info.DAM17 || null,
    genInb: num(Number(a.info.GEN_INB)),
    pedInb: num(Number(a.info.PED_INB)),
    genFutInb: num(Number(a.info.GEN_FUT_INB)),
    expFutInb: num(Number(a.info.EXP_FUT_INB)),
    chip: a.info.CHIP || null,
    requesterId: a.info.REQUESTER_ID || null,
    dateReceived: dateFromYmd(a.info.DATE_RECEIVED),
    current: a.info.CURRENT || null,
    gptaJson: JSON.stringify(packed.gpta),
    relJson: JSON.stringify(packed.rel),
    gsonsJson: JSON.stringify(packed.gsons),
    dgvJson: JSON.stringify(packed.dgv),
    paJson: JSON.stringify(packed.pa),
    haplotypesJson: Object.keys(haplotypes).length ? JSON.stringify(haplotypes) : null,
    nmDollar: g("NM"), cmDollar: g("CM"), fmDollar: g("FM"), gmDollar: g("GM"),
    milk: g("MILK"), fat: g("FAT"), pro: g("PRO"), fatPct: g("FATPCT"), proPct: g("PROPCT"),
    pl: g("PL"), scs: g("SCS"), dpr: g("DPR"), ccr: g("CCR"),
    ptat: g("PTAT"), rpa: g("RPA"), liv: g("LIV"),
    udc: tpi ? tpi.composites.udc : null,
    flc: tpi ? tpi.composites.flc : null,
    tpi: tpi?.value ?? null,
    tpiFormulaVersion: tpi?.formula.tpi.label ?? null,
    tpiConfidence: tpi?.confidence ?? null,
    jpi: jpi?.value ?? null,
    jpiFormulaVersion: jpi?.version.label ?? null,
    sourceFile: ctx.sourceFile,
    createdById: ctx.userId ?? undefined,
  };

  const row = await prisma.usEvaluation.upsert({
    where: { usAnimalId_periodKey_sourceFamily: { usAnimalId, periodKey: file.periodKey, sourceFamily: file.family } },
    update: data,
    create: { ...data, usAnimalId, animalId: bridge },
    select: { usEvaluationId: true },
  });

  return {
    usEvaluationId: row.usEvaluationId, usAnimalId, animalId: bridge, createdAnimal,
    linked: createdAnimal ? "new" : resolved.how,
    conflict: resolved.conflict,
    tpi: tpi?.value ?? null, jpi: jpi?.value ?? null,
  };
}

/**
 * Recompute which US evaluation is an animal's preferred one.
 *
 * ONLY triannual rows are candidates, by construction — a provisional monthly add
 * must never displace an official round. Entirely separate from the Canadian
 * isPreferred, which it must never touch.
 */
export async function recomputeUsPreferred(usAnimalId: string): Promise<void> {
  const rows = await prisma.usEvaluation.findMany({
    where: { usAnimalId, runKind: "official", approvalStatus: "approved" },
    orderBy: [{ evaluationDate: "desc" }, { sourceFamily: "asc" }],
    select: { usEvaluationId: true },
  });
  const winner = rows[0]?.usEvaluationId ?? null;
  await prisma.usEvaluation.updateMany({ where: { usAnimalId }, data: { isPreferred: false } });
  if (winner) await prisma.usEvaluation.update({ where: { usEvaluationId: winner }, data: { isPreferred: true } });
}

/**
 * Load CDCB's AI-status file — the US "is this bull actually marketed" answer.
 *
 * BULK, because the per-row version could not finish. It did a findUnique plus an
 * upsert for every line: 13,150 sequential round-trips for one 6,575-line file,
 * which ran past ten minutes against the pooled remote database and was killed.
 * This does a fixed number of queries regardless of file size — the same lesson
 * persist-bulk.ts already learned for the evaluation files.
 *
 * Delete-then-insert for the round, so a re-load is idempotent without needing a
 * per-row upsert. Scoped to ONE roundCode: it can never touch another round.
 */
export async function persistAiStatus(lines: string[], roundCode: string): Promise<{ rows: number; matched: number }> {
  const RE = /^([A-Z]{2}[A-Z0-9]{3}[A-Z0-9]{12})\s+([AFG])\s*$/;
  const parsed: { id17: string; code: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const m = RE.exec(line.trim());
    if (!m) continue;
    // The file can repeat an id17; the table is unique on (id17, roundCode), so
    // the later line would be rejected rather than merged. Keep the first.
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    parsed.push({ id17: m[1], code: m[2] });
  }
  if (!parsed.length) return { rows: 0, matched: 0 };

  // Resolve the Canadian bridge for the bulls that have one, in chunks.
  const bridges = new Map<string, string>();
  const ids = parsed.map((p) => p.id17);
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await prisma.usAnimal.findMany({
      where: { id17: { in: ids.slice(i, i + 2000) } },
      select: { id17: true, animalId: true },
    });
    for (const r of rows) bridges.set(r.id17, r.animalId ?? "");
  }

  await prisma.usAiStatus.deleteMany({ where: { roundCode } });
  let rows = 0;
  for (let i = 0; i < parsed.length; i += 1000) {
    const r = await prisma.usAiStatus.createMany({
      data: parsed.slice(i, i + 1000).map((p) => ({
        id17: p.id17, roundCode, code: p.code,
        animalId: bridges.get(p.id17) || null,
      })),
      skipDuplicates: true,
    });
    rows += r.count;
  }
  // "Matched" means the bull is on the AMERICAN roster. Orphans are expected and
  // kept: the status file and the evaluation files are published independently.
  return { rows, matched: bridges.size };
}
