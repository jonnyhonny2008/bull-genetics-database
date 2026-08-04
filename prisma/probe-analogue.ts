// Diagnostic (not part of the app): the ANALOGUE model, done properly.
//
//   npx tsx --conditions=react-server prisma/probe-analogue.ts
//
// "Find the bulls who were at the same career stage, with the same daughter
// pattern, moving the same way — and use what actually happened to them next."
//
// What makes this a fairer test than my first attempt:
//
//   1. CAREER STAGE is a real feature — rounds since first proof, age, daughter
//      count and the RATE daughters are arriving — not just calendar position.
//   2. TRAJECTORY SHAPE is matched, not summarised: the last three moves enter
//      the distance in trait-standardised units, so "climbing steadily" only
//      matches other bulls who were climbing steadily.
//   3. The neighbours return a DISTRIBUTION, not an average. The point estimate
//      is their MEDIAN (which is what minimises absolute error — using the mean
//      was a real mistake in the first attempt), and the 10th/90th percentiles
//      become a per-bull interval.
//   4. It is scored on the INTERVAL as well as the point. A model can fail to
//      call the direction and still be a large improvement if it says which
//      bulls are about to move and which are settled. That is the question the
//      report actually needs answered, and the shipped model answers it with one
//      cohort-wide number for everybody.
//
// Strictly walk-forward: a neighbour must come from a round that had already
// happened before the round being predicted. No bull is ever his own neighbour.
//
// Reports only. Changes nothing.

import { prisma } from "../src/lib/db";
import { isRollbackRound, isOfficialProof } from "../src/lib/rollback";

const TRAITS = ["lpi", "milk", "fat", "prot", "conf"] as const;
type TraitKey = (typeof TRAITS)[number];

type Row = {
  animalId: string;
  evaluationDate: Date;
  daughters: number | null;
  sireType: string | null;
  reliabilityOverall: number | null;
  animal: { birthDate: Date | null };
} & Record<TraitKey, number | null>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const kindOf = (d: Date) => (isRollbackRound(d) ? "april" : isOfficialProof(d) ? "official" : "interim");

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** One prediction problem, with everything knowable BEFORE the round. */
interface Case {
  bull: string;
  t: TraitKey;
  time: number;
  kind: string;
  last: number;
  target: number;      // the actual next value
  f: number[];         // feature vector, raw (standardised later)
}

const FEATURES = [
  "careerRound", "ageYears", "reliability", "relGrowth",
  "logDaughters", "daughterRate", "d1", "d2", "d3", "levelZ", "genomic",
] as const;

async function main() {
  const rows = (await prisma.geneticEvaluation.findMany({
    where: { animal: { archived: false, identifiers: { some: { active: true, idType: "naab" } } } },
    orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
    select: {
      animalId: true, evaluationDate: true, daughters: true, sireType: true, reliabilityOverall: true,
      lpi: true, milk: true, fat: true, prot: true, conf: true,
      animal: { select: { birthDate: true } },
    },
  })) as Row[];

  const byBull = new Map<string, Row[]>();
  for (const r of rows) { const a = byBull.get(r.animalId); if (a) a.push(r); else byBull.set(r.animalId, [r]); }

  // Trait scale, so a 40 kg milk move and a 0.3 conformation move are comparable
  // inside the distance. Computed once over all history — it is a unit, not a
  // learned parameter, so it cannot leak an individual round's outcome.
  const scale = new Map<TraitKey, number>();
  for (const t of TRAITS) {
    const ds: number[] = [];
    for (const s of byBull.values()) {
      for (let i = 1; i < s.length; i++) {
        if (isRollbackRound(s[i].evaluationDate)) continue;
        const a = s[i - 1][t], b = s[i][t];
        if (a != null && b != null) ds.push(b - a);
      }
    }
    const m = mean(ds);
    scale.set(t, Math.sqrt(mean(ds.map((v) => (v - m) ** 2))) || 1);
  }
  const levelStats = new Map<TraitKey, { m: number; s: number }>();
  for (const t of TRAITS) {
    const vs = rows.map((r) => r[t]).filter((v): v is number => v != null);
    const m = mean(vs);
    levelStats.set(t, { m, s: Math.sqrt(mean(vs.map((v) => (v - m) ** 2))) || 1 });
  }

  // --- Build every case -----------------------------------------------------
  const cases: Case[] = [];
  for (const s of byBull.values()) {
    const firstTime = s[0].evaluationDate.getTime();
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1], cur = s[i];
      if (isRollbackRound(cur.evaluationDate)) continue;   // April is published, not modelled
      const ageYears = prev.animal.birthDate
        ? (prev.evaluationDate.getTime() - prev.animal.birthDate.getTime()) / (365.25 * 864e5) : 5;
      const relGrowth = prev.reliabilityOverall != null && s[i - 2]?.reliabilityOverall != null
        ? prev.reliabilityOverall - s[i - 2].reliabilityOverall! : 0;
      const monthsOnFile = Math.max(1, (prev.evaluationDate.getTime() - firstTime) / (30.4 * 864e5));
      const daughterRate = (prev.daughters ?? 0) / monthsOnFile;

      for (const t of TRAITS) {
        const a = prev[t], b = cur[t];
        if (a == null || b == null) continue;
        const sc = scale.get(t)!;
        // The last three moves, in trait-standardised units. A step that spans
        // April is a base change, not the bull moving, so it is not a shape.
        const step = (j: number): number => {
          if (i - j - 1 < 0) return 0;
          const p = s[i - j - 1], q = s[i - j];
          if (isRollbackRound(q.evaluationDate)) return 0;
          const pv = p[t], qv = q[t];
          return pv != null && qv != null ? (qv - pv) / sc : 0;
        };
        const ls = levelStats.get(t)!;
        cases.push({
          bull: prev.animalId, t, time: cur.evaluationDate.getTime(), kind: kindOf(cur.evaluationDate),
          last: a, target: b,
          f: [
            i,                                   // careerRound
            ageYears,
            prev.reliabilityOverall ?? 0.8,
            relGrowth,
            Math.log1p(prev.daughters ?? 0),
            daughterRate,
            step(1), step(2), step(3),
            (a - ls.m) / ls.s,                   // levelZ
            prev.sireType === "genomic" ? 1 : 0,
          ],
        });
      }
    }
  }
  console.log(`\n  ${cases.length} non-April cases · ${byBull.size} bulls · features: ${FEATURES.join(", ")}`);

  // Standardise features over ALL cases (a scale, not a fitted parameter).
  const fm: number[] = [], fs: number[] = [];
  for (let j = 0; j < FEATURES.length; j++) {
    const xs = cases.map((c) => c.f[j]);
    const m = mean(xs);
    fm.push(m);
    fs.push(Math.sqrt(mean(xs.map((v) => (v - m) ** 2))) || 1);
  }
  for (const c of cases) c.f = c.f.map((v, j) => (v - fm[j]) / fs[j]);

  // --- Walk-forward evaluation ---------------------------------------------
  const times = [...new Set(cases.map((c) => c.time))].sort((a, b) => a - b);
  const MIN_TRAIN_ROUNDS = 8;
  const cutoff = times[MIN_TRAIN_ROUNDS];

  interface Acc { mae: number[]; naive: number[]; hit: number; width: number[]; bHit: number; bWidth: number[]; pin: number[]; bPin: number[] }
  const newAcc = (): Acc => ({ mae: [], naive: [], hit: 0, width: [], bHit: 0, bWidth: [], pin: [], bPin: [] });

  /** Pinball loss at the 10th/90th percentile — scores interval sharpness AND
   *  calibration together, so a band cannot win by simply being enormous. */
  const pinball = (actual: number, lo: number, hi: number) => {
    const p = (q: number, pred: number) => (actual >= pred ? q * (actual - pred) : (1 - q) * (pred - actual));
    return p(0.1, lo) + p(0.9, hi);
  };

  const WEIGHT_SETS: Record<string, Partial<Record<(typeof FEATURES)[number], number>>> = {
    "all-equal": {},
    "career-heavy": { careerRound: 2, ageYears: 2, logDaughters: 2, daughterRate: 2, reliability: 2 },
    "shape-heavy": { d1: 3, d2: 2, d3: 1.5 },
    "your-brief": { careerRound: 2, logDaughters: 2, daughterRate: 2, reliability: 1.5, relGrowth: 1.5, d1: 2, d2: 1.5 },
  };
  const KS = [25, 50, 100, 200];

  console.log(`\n${"=".repeat(96)}`);
  console.log(`ANALOGUE MODEL — walk-forward, neighbours drawn only from earlier rounds, never the same bull`);
  console.log(`${"=".repeat(96)}`);
  console.log(`  point skill = MAE vs "no change"      band = 10-90th pct of the analogues' actual next moves`);
  console.log(`  pinball     = interval quality vs the shipped cohort-wide band (higher is better)\n`);
  console.log(`  ${"weights".padEnd(13)}${"k".padStart(4)}   ${"trait".padEnd(6)}${"point".padStart(8)}${"cover".padStart(8)}${"width".padStart(9)}${"base cov".padStart(10)}${"base wid".padStart(10)}${"pinball".padStart(9)}`);

  for (const [wname, wset] of Object.entries(WEIGHT_SETS)) {
    const w = FEATURES.map((f) => wset[f] ?? 1);
    for (const K of KS) {
      const acc = new Map<TraitKey, Acc>(TRAITS.map((t) => [t, newAcc()]));
      for (const t of TRAITS) {
        const pool = cases.filter((c) => c.t === t);
        const test = pool.filter((c) => c.time >= cutoff);
        for (const c of test) {
          // Candidates: same trait, same kind of round, already concluded, other bulls.
          const cand = pool.filter((o) => o.time < c.time && o.kind === c.kind && o.bull !== c.bull);
          if (cand.length < K * 2) continue;
          const scored = cand.map((o) => {
            let d = 0;
            for (let j = 0; j < w.length; j++) { const x = (o.f[j] - c.f[j]) * w[j]; d += x * x; }
            return { d, move: o.target - o.last };
          });
          scored.sort((a, b) => a.d - b.d);
          const moves = scored.slice(0, K).map((s) => s.move).sort((a, b) => a - b);
          const med = quantile(moves, 0.5);
          const lo = c.last + quantile(moves, 0.1), hi = c.last + quantile(moves, 0.9);

          // Baseline band: the same cohort-wide quantiles the shipped model uses.
          const all = cand.map((o) => o.target - o.last).sort((a, b) => a - b);
          const bLo = c.last + quantile(all, 0.1), bHi = c.last + quantile(all, 0.9);

          const a = acc.get(t)!;
          a.mae.push(Math.abs(c.last + med - c.target));
          a.naive.push(Math.abs(c.last - c.target));
          if (c.target >= lo && c.target <= hi) a.hit++;
          if (c.target >= bLo && c.target <= bHi) a.bHit++;
          a.width.push(hi - lo);
          a.bWidth.push(bHi - bLo);
          a.pin.push(pinball(c.target, lo, hi));
          a.bPin.push(pinball(c.target, bLo, bHi));
        }
      }
      for (const t of TRAITS) {
        const a = acc.get(t)!;
        if (a.mae.length < 100) continue;
        const skill = ((mean(a.naive) - mean(a.mae)) / mean(a.naive)) * 100;
        const pinSkill = ((mean(a.bPin) - mean(a.pin)) / mean(a.bPin)) * 100;
        console.log(
          `  ${wname.padEnd(13)}${String(K).padStart(4)}   ${t.padEnd(6)}` +
          `${`${fmt(skill, 1)}%`.padStart(8)}${`${fmt((a.hit / a.mae.length) * 100, 1)}%`.padStart(8)}` +
          `${fmt(mean(a.width), 1).padStart(9)}${`${fmt((a.bHit / a.mae.length) * 100, 1)}%`.padStart(10)}` +
          `${fmt(mean(a.bWidth), 1).padStart(10)}${`${fmt(pinSkill, 1)}%`.padStart(9)}`,
        );
      }
      console.log("");
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
