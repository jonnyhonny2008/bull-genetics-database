import "server-only";

// ---------------------------------------------------------------------------
// AMERICAN ROUND-TO-ROUND COMPARISON — any two periods on file.
//
// The Canadian equivalent (lib/proof-round-report.ts) is built around Holstein
// EBV tiers and a NAAB universe. This is not a port of it, because the American
// data does not have the same shape:
//
//   * FIVE BREEDS, FIVE BASES. CDCB re-bases each breed separately, so a single
//     all-breed mean movement would be an average across incomparable scales.
//     Everything here is computed PER BREED and the report says so.
//
//   * GTPI EXISTS ONLY FOR HOLSTEIN, JPI ONLY FOR JERSEY. A trait is reported for
//     a breed only where that breed actually carries it, rather than printing a
//     column of dashes that reads like missing data.
//
//   * MIXING RUN KINDS IS THE TRAP. A provisional monthly add and an official
//     triannual round are not peers: the monthly carries young bulls that were
//     not in the official file at all, so "movement" between them is mostly
//     composition, not genetic change. The comparison is still ALLOWED — it is
//     occasionally what you want — but it is flagged, and the flag travels into
//     the CSV and the HTML export rather than living only on the screen.
//
// Only bulls present in BOTH periods are compared. A bull who appears in one is
// counted separately as an arrival or a departure, never as a move of zero.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { US_KEY_TRAITS, type UsKeyTrait } from "./key-traits";
import { usRoundLabel } from "./proof-change";

export interface UsPeriod {
  periodKey: string;
  roundCode: string | null;
  runKind: string;
  label: string;
  animals: number;
}

export interface UsTraitMove {
  code: string;
  label: string;
  unit: string | null;
  decimals: number;
  /** Bulls carrying the trait in BOTH periods. */
  n: number;
  meanFrom: number;
  meanTo: number;
  meanDelta: number;
  sdDelta: number;
  rose: number;
  fell: number;
  unchanged: number;
  /** True where neither extreme is "better", so a mean move is not progress. */
  intermediate: boolean;
}

export interface UsBreedMove {
  breed: string;
  /** Bulls in both periods — the comparable cohort for this breed. */
  common: number;
  arrived: number;
  departed: number;
  traits: UsTraitMove[];
}

export interface UsMover {
  usAnimalId: string;
  id17: string;
  name: string;
  naabCode: string | null;
  breed: string | null;
  from: number;
  to: number;
  delta: number;
}

export interface UsRoundCompare {
  from: UsPeriod;
  to: UsPeriod;
  breeds: UsBreedMove[];
  /** Biggest movers on the lead index, by breed-relative standard deviations. */
  topRisers: UsMover[];
  topFallers: UsMover[];
  /** Set when the two periods are not the same kind of run. */
  mixedRunKinds: string | null;
  generatedAt: Date;
}

const LEAD_COLUMN = "tpi" as const;

/** Every period on file, newest first, with how many animals it covers. */
export async function listUsPeriods(): Promise<UsPeriod[]> {
  const rows = await prisma.usEvaluation.groupBy({
    by: ["periodKey", "roundCode", "runKind"],
    _count: { _all: true },
    orderBy: { periodKey: "desc" },
  });
  return rows.map((r) => ({
    periodKey: r.periodKey,
    roundCode: r.roundCode,
    runKind: r.runKind,
    label: r.roundCode ? usRoundLabel(r.roundCode) : r.periodKey,
    animals: r._count._all,
  }));
}

/** "an official run", not "a official run" — this string is read by customers. */
const article = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

const SELECT = {
  usAnimalId: true, id17: true, evalBreed: true, naabCode: true,
  tpi: true, nmDollar: true, ptat: true, milk: true, rpa: true, dpr: true, ccr: true,
  usAnimal: { select: { name: true } },
} satisfies Prisma.UsEvaluationSelect;

type Row = Prisma.UsEvaluationGetPayload<{ select: typeof SELECT }>;

const valueOf = (r: Row, t: UsKeyTrait): number | null => {
  const v = r[t.column];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export async function getUsRoundCompare(opts: {
  from: string;
  to: string;
  /** CDCB breed code. Omitted means every breed, each reported separately. */
  breed?: string;
  topN?: number;
}): Promise<UsRoundCompare | null> {
  const periods = await listUsPeriods();
  const from = periods.find((p) => p.periodKey === opts.from);
  const to = periods.find((p) => p.periodKey === opts.to);
  if (!from || !to || from.periodKey === to.periodKey) return null;

  const where = (periodKey: string): Prisma.UsEvaluationWhereInput => ({
    periodKey,
    approvalStatus: "approved",
    ...(opts.breed ? { evalBreed: opts.breed } : {}),
  });

  const [fromRows, toRows] = await Promise.all([
    prisma.usEvaluation.findMany({ where: where(from.periodKey), select: SELECT }),
    prisma.usEvaluation.findMany({ where: where(to.periodKey), select: SELECT }),
  ]);

  const fromBy = new Map(fromRows.map((r) => [r.usAnimalId, r]));
  const toBy = new Map(toRows.map((r) => [r.usAnimalId, r]));

  // Group the comparable pairs by breed. Breed comes from the LATER row: a bull
  // re-evaluated in a different breed is reported where he now sits.
  const pairsByBreed = new Map<string, { a: Row; b: Row }[]>();
  for (const [id, b] of toBy) {
    const a = fromBy.get(id);
    if (!a) continue;
    const breed = b.evalBreed ?? "—";
    const arr = pairsByBreed.get(breed) ?? [];
    arr.push({ a, b });
    pairsByBreed.set(breed, arr);
  }

  const breeds: UsBreedMove[] = [];
  for (const [breed, pairs] of pairsByBreed) {
    const arrived = toRows.filter((r) => (r.evalBreed ?? "—") === breed && !fromBy.has(r.usAnimalId)).length;
    const departed = fromRows.filter((r) => (r.evalBreed ?? "—") === breed && !toBy.has(r.usAnimalId)).length;

    const traits: UsTraitMove[] = [];
    for (const t of US_KEY_TRAITS) {
      const deltas: number[] = [], fromVals: number[] = [], toVals: number[] = [];
      let rose = 0, fell = 0, unchanged = 0;
      for (const { a, b } of pairs) {
        const va = valueOf(a, t), vb = valueOf(b, t);
        if (va == null || vb == null) continue;
        const d = vb - va;
        deltas.push(d); fromVals.push(va); toVals.push(vb);
        if (d > 0) rose++; else if (d < 0) fell++; else unchanged++;
      }
      // A trait no bull in this breed carries is omitted, not printed as dashes.
      if (!deltas.length) continue;
      const m = mean(deltas);
      traits.push({
        code: t.code, label: t.label, unit: t.unit, decimals: t.decimals,
        n: deltas.length,
        meanFrom: mean(fromVals), meanTo: mean(toVals),
        meanDelta: m, sdDelta: sd(deltas, m),
        rose, fell, unchanged,
        intermediate: t.direction === "intermediate",
      });
    }
    breeds.push({ breed, common: pairs.length, arrived, departed, traits });
  }
  breeds.sort((x, y) => y.common - x.common);

  // Movers on the lead index, ranked by how far they moved RELATIVE TO THEIR OWN
  // BREED's spread — 40 GTPI points means something different in Holstein than
  // 40 JPI points does in Jersey, so a single pooled ranking would be wrong.
  const scored: (UsMover & { z: number })[] = [];
  for (const [breed, pairs] of pairsByBreed) {
    const ds: number[] = [];
    for (const { a, b } of pairs) {
      if (a[LEAD_COLUMN] == null || b[LEAD_COLUMN] == null) continue;
      ds.push(b[LEAD_COLUMN]! - a[LEAD_COLUMN]!);
    }
    if (ds.length < 2) continue;
    const m = mean(ds), s = sd(ds, m);
    if (!(s > 0)) continue;
    for (const { a, b } of pairs) {
      const va = a[LEAD_COLUMN], vb = b[LEAD_COLUMN];
      if (va == null || vb == null) continue;
      scored.push({
        usAnimalId: b.usAnimalId, id17: b.id17,
        name: b.usAnimal?.name ?? b.id17, naabCode: b.naabCode, breed,
        from: va, to: vb, delta: vb - va, z: (vb - va - m) / s,
      });
    }
  }
  const topN = opts.topN ?? 25;
  const byZ = [...scored].sort((x, y) => y.z - x.z);

  return {
    from, to, breeds,
    topRisers: byZ.slice(0, topN),
    topFallers: byZ.slice(-topN).reverse(),
    mixedRunKinds:
      from.runKind === to.runKind
        ? null
        : `${from.label} is ${article(from.runKind)} run and ${to.label} is ${article(to.runKind)} run. These are not peers — a provisional or unofficial file carries bulls the official round did not, so much of the movement below is a change of population rather than a change of evaluation.`,
    generatedAt: new Date(),
  };
}
