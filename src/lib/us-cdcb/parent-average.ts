import "server-only";

// ---------------------------------------------------------------------------
// PARENT AVERAGE vs GENOMIC EVALUATION — the American question.
//
// Canada's /parent-average takes a sire and a dam and computes the PA of a
// mating that has not happened yet. That needs FEMALE evaluations, and the CDCB
// bull files do not contain cows, so a straight port would be a page that can
// never return an answer.
//
// The American data supports a different question that is just as real, and this
// page answers that one instead: CDCB publishes each bull's own parent average
// alongside his genomic evaluation, so we can show HOW FAR THE GENOMIC TEST MOVED
// HIM OFF HIS PEDIGREE. That is the number a breeder actually argues about — did
// the test confirm the pedigree, or contradict it?
//
// GTPI IS RECOMPUTED FROM THE PARENT AVERAGE, not looked up. CDCB publishes PA
// per trait but no PA index, so the pedigree-expectation GTPI is calculated by
// running the PA traits through the SAME versioned formula the genomic GTPI uses
// (index-registry.ts, resolved for that bull's round). Using one round's formula
// for one number and another's for the other would manufacture a difference that
// is arithmetic rather than biology.
//
// A BULL'S DELTA MEANS NOTHING ALONE. Moving +300 lb of milk off pedigree is
// unremarkable if the whole breed moves ±400; it is extraordinary if the breed
// moves ±60. So every per-bull figure is reported against the spread of that
// same trait across that same breed and round.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeTpi, TpiUnavailable } from "./index-registry";
import { US_SPECIALIST_CATALOG } from "./specialists";

export interface PaTrait {
  code: string;
  name: string;
  group: string;
  unit: string | null;
  pa: number;
  gpta: number;
  delta: number;
  /** Breed-and-round spread of this delta. null when the cohort cannot support one. */
  sd: number | null;
  /** delta in cohort SDs. null when sd is null. */
  z: number | null;
  /** True where neither direction is "better", so a delta is not good or bad news. */
  intermediate: boolean;
}

export interface UsPaReport {
  usAnimalId: string;
  id17: string;
  name: string;
  naabCode: string | null;
  breed: string | null;
  roundCode: string | null;
  roundLabel: string;
  /** GTPI computed from the PA traits with the round's own formula. */
  paTpi: number | null;
  /** The published genomic GTPI, as this app calculates it. */
  gptaTpi: number | null;
  tpiDelta: number | null;
  tpiNote: string | null;
  traits: PaTrait[];
  /** How many bulls of this breed and round the spreads were measured over. */
  cohortN: number;
}

const CATALOG = new Map(US_SPECIALIST_CATALOG.map((t) => [t.code, t]));

const parse = (s: string | null): Record<string, number> => {
  if (!s) return {};
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
};

const SELECT = {
  usAnimalId: true, id17: true, naabCode: true, evalBreed: true, roundCode: true,
  gptaJson: true, paJson: true, tpi: true,
  usAnimal: { select: { name: true } },
} satisfies Prisma.UsEvaluationSelect;

/**
 * Per-trait spread of (genomic − parent average) across a breed and round.
 *
 * Sampled rather than exhaustive: 4,000 bulls pins a standard deviation far
 * tighter than any use here needs, and scanning 53,000 Holstein rows to move the
 * third decimal place would make the page slow for no gain. The sample size is
 * reported so the reader can judge it.
 */
async function cohortSpread(breed: string | null, roundCode: string | null) {
  if (!breed || !roundCode) return { sd: new Map<string, number>(), n: 0 };
  const rows = await prisma.usEvaluation.findMany({
    where: { evalBreed: breed, roundCode, isPreferred: true, approvalStatus: "approved" },
    select: { gptaJson: true, paJson: true },
    take: 4000,
  });
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    const g = parse(r.gptaJson), p = parse(r.paJson);
    for (const [code, gv] of Object.entries(g)) {
      const pv = p[code];
      if (typeof pv !== "number") continue;
      const a = acc.get(code) ?? [];
      a.push(gv - pv);
      acc.set(code, a);
    }
  }
  const sd = new Map<string, number>();
  for (const [code, xs] of acc) {
    if (xs.length < 30) continue; // too thin to quote a spread from
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    sd.set(code, Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length));
  }
  return { sd, n: rows.length };
}

/** Accepts a UsAnimal id, a CDCB id17, or a Canadian Animal id. */
export async function getUsParentAverage(idOrKey: string): Promise<UsPaReport | null> {
  const animal = await prisma.usAnimal.findFirst({
    where: { OR: [{ usAnimalId: idOrKey }, { id17: idOrKey }, { animalId: idOrKey }] },
    select: { usAnimalId: true },
  });
  if (!animal) return null;

  const ev = await prisma.usEvaluation.findFirst({
    where: { usAnimalId: animal.usAnimalId, isPreferred: true, approvalStatus: "approved" },
    select: SELECT,
  });
  if (!ev) return null;

  const gpta = parse(ev.gptaJson), pa = parse(ev.paJson);
  const { sd, n } = await cohortSpread(ev.evalBreed, ev.roundCode);

  const traits: PaTrait[] = [];
  for (const [code, paV] of Object.entries(pa)) {
    const gV = gpta[code];
    if (typeof gV !== "number") continue;
    const def = CATALOG.get(code);
    const s = sd.get(code) ?? null;
    const delta = gV - paV;
    traits.push({
      code,
      name: def?.name ?? code,
      group: def?.group ?? "Other published traits",
      unit: def?.unit ?? null,
      pa: paV, gpta: gV, delta,
      sd: s,
      z: s && s > 0 ? delta / s : null,
      intermediate: def?.direction === "intermediate",
    });
  }
  // Biggest surprises first — a bull's page should open on what is unusual about
  // him, not on whichever trait happens to sort first alphabetically.
  traits.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0) || a.name.localeCompare(b.name));

  // The pedigree-expectation index, through the round's own formula.
  let paTpi: number | null = null;
  let tpiNote: string | null = null;
  if (ev.evalBreed === "HO" && ev.roundCode) {
    try {
      const flat: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(pa)) flat[k] = v;
      paTpi = computeTpi(flat, ev.roundCode)?.value ?? null;
      if (paTpi == null) tpiNote = "CDCB does not publish every trait the GTPI formula needs as a parent average for this bull, so a pedigree GTPI cannot be computed for him.";
    } catch (e) {
      if (!(e instanceof TpiUnavailable)) throw e;
      tpiNote = "No GTPI formula is registered for this round, so a pedigree GTPI cannot be computed.";
    }
  } else if (ev.evalBreed !== "HO") {
    tpiNote = "GTPI is a Holstein index. There is no pedigree-expectation index to compute for this breed.";
  }

  const { usRoundLabel } = await import("./proof-change");
  return {
    usAnimalId: ev.usAnimalId, id17: ev.id17,
    name: ev.usAnimal?.name ?? ev.id17,
    naabCode: ev.naabCode, breed: ev.evalBreed,
    roundCode: ev.roundCode, roundLabel: usRoundLabel(ev.roundCode),
    paTpi, gptaTpi: ev.tpi,
    tpiDelta: paTpi != null && ev.tpi != null ? ev.tpi - paTpi : null,
    tpiNote,
    traits, cohortN: n,
  };
}
