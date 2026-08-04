// Diagnostic (not part of the app): walk-forward test of every candidate
// correction against "no change", on NON-APRIL rounds only.
//
//   npx tsx --conditions=react-server prisma/probe-forecast2.ts
//
// Strictly out-of-sample: for each target round, everything the model uses is
// learned from rounds STRICTLY BEFORE it. That is the only way to know whether
// a correction would actually have helped on the day.
//
// Candidates:
//   naive        predicted = last                       (the incumbent)
//   drift(kind)  last + mean Δ of that ROUND KIND       (interim vs official)
//   drift(month) last + mean Δ of that CALENDAR MONTH   (the seasonality idea)
//   phi          last + phi × (the bull's own last Δ)   (bounce-back)
//   drift+phi    both
//   daughters    kind drift, split by daughter influx   (the analogue idea's core)
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
} & Record<TraitKey, number | null>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const kindOf = (d: Date) => (isRollbackRound(d) ? "april" : isOfficialProof(d) ? "official" : "interim");

/** One prediction problem: predict `actual` at `date` from what came before. */
interface Case {
  t: TraitKey;
  date: Date;
  kind: string;
  month: number;
  last: number;
  prevDelta: number | null;   // the bull's own previous step
  dGain: number | null;       // daughters added going into this round
  actual: number;
}

async function main() {
  const rows = (await prisma.geneticEvaluation.findMany({
    where: { animal: { archived: false, identifiers: { some: { active: true, idType: "naab" } } } },
    orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
    select: {
      animalId: true, evaluationDate: true, daughters: true, sireType: true, reliabilityOverall: true,
      lpi: true, milk: true, fat: true, prot: true, conf: true,
    },
  })) as Row[];

  // Is a null daughter count a PARSING GAP or a real "this bull has none"?
  // It matters: a gap is fixable, a genuine absence is information.
  const nullD = rows.filter((r) => r.daughters == null);
  const nullGenomic = nullD.filter((r) => r.sireType === "genomic").length;
  const someD = rows.filter((r) => r.daughters != null);
  const someGenomic = someD.filter((r) => r.sireType === "genomic").length;
  console.log(`\n${"=".repeat(78)}\n0. IS THE DAUGHTER COUNT ACTUALLY MISSING?\n${"=".repeat(78)}`);
  console.log(`  rounds with NO daughter count : ${nullD.length} — ${((nullGenomic / nullD.length) * 100).toFixed(1)}% are genomic-classed bulls`);
  console.log(`  rounds WITH a daughter count  : ${someD.length} — ${((someGenomic / someD.length) * 100).toFixed(1)}% are genomic-classed bulls`);
  console.log(`  → if the first number is ~100%, the blank means "no daughters yet", not a parsing gap.`);

  const byBull = new Map<string, Row[]>();
  for (const r of rows) {
    const a = byBull.get(r.animalId);
    if (a) a.push(r); else byBull.set(r.animalId, [r]);
  }

  const cases: Case[] = [];
  for (const s of byBull.values()) {
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1], cur = s[i];
      if (isRollbackRound(cur.evaluationDate)) continue;   // April has its own published model
      for (const t of TRAITS) {
        const a = prev[t], b = cur[t];
        if (a == null || b == null) continue;
        const before = i >= 2 ? s[i - 2][t] : null;
        // A previous step that spans April is a base change, not the bull moving.
        const prevIsApril = i >= 2 ? isRollbackRound(prev.evaluationDate) : false;
        cases.push({
          t, date: cur.evaluationDate, kind: kindOf(cur.evaluationDate),
          month: cur.evaluationDate.getUTCMonth() + 1,
          last: a,
          prevDelta: before != null && !prevIsApril ? a - before : null,
          dGain: prev.daughters != null && cur.daughters != null ? cur.daughters - prev.daughters : null,
          actual: b,
        });
      }
    }
  }
  console.log(`\n  ${cases.length} non-April trait-cases across ${byBull.size} bulls.`);

  // Every distinct target round, oldest first. A round is only scored once
  // enough history exists before it to learn anything.
  const roundKeys = [...new Set(cases.map((c) => c.date.getTime()))].sort((a, b) => a - b);
  const MIN_TRAIN = 6;   // target rounds of history before we start scoring

  interface Score { err: number[]; naive: number[] }
  const models = ["drift(kind)", "drift(month)", "phi-0.10", "phi-0.15", "phi-0.20", "drift+phi", "daughters"] as const;
  const scores = new Map<string, Map<TraitKey, Score>>();
  for (const m of models) scores.set(m, new Map(TRAITS.map((t) => [t, { err: [], naive: [] }])));

  for (let ri = MIN_TRAIN; ri < roundKeys.length; ri++) {
    const target = roundKeys[ri];
    const train = cases.filter((c) => c.date.getTime() < target);
    const test = cases.filter((c) => c.date.getTime() === target);
    if (!test.length) continue;

    // --- learn, from training data only ---
    const driftKind = new Map<string, number>();
    const driftMonth = new Map<string, number>();
    const driftD = new Map<string, number>();
    for (const t of TRAITS) {
      for (const k of ["interim", "official"]) {
        const xs = train.filter((c) => c.t === t && c.kind === k).map((c) => c.actual - c.last);
        if (xs.length >= 30) driftKind.set(`${t}|${k}`, mean(xs));
      }
      for (let m = 1; m <= 12; m++) {
        const xs = train.filter((c) => c.t === t && c.month === m).map((c) => c.actual - c.last);
        if (xs.length >= 30) driftMonth.set(`${t}|${m}`, mean(xs));
      }
      for (const k of ["interim", "official"]) {
        for (const g of ["gain", "flat"]) {
          const xs = train.filter((c) => c.t === t && c.kind === k && (g === "gain" ? (c.dGain ?? 0) > 0 : (c.dGain ?? 0) <= 0))
            .map((c) => c.actual - c.last);
          if (xs.length >= 30) driftD.set(`${t}|${k}|${g}`, mean(xs));
        }
      }
    }

    for (const c of test) {
      const dk = driftKind.get(`${c.t}|${c.kind}`) ?? 0;
      const dm = driftMonth.get(`${c.t}|${c.month}`) ?? 0;
      const dd = driftD.get(`${c.t}|${c.kind}|${(c.dGain ?? 0) > 0 ? "gain" : "flat"}`) ?? dk;
      const p = c.prevDelta ?? 0;
      const preds: Record<string, number> = {
        "drift(kind)": c.last + dk,
        "drift(month)": c.last + dm,
        "phi-0.10": c.last - 0.10 * p,
        "phi-0.15": c.last - 0.15 * p,
        "phi-0.20": c.last - 0.20 * p,
        "drift+phi": c.last + dk - 0.15 * p,
        "daughters": c.last + dd,
      };
      for (const m of models) {
        const s = scores.get(m)!.get(c.t)!;
        s.err.push(Math.abs(preds[m] - c.actual));
        s.naive.push(Math.abs(c.last - c.actual));
      }
    }
  }

  console.log(`\n${"=".repeat(78)}\nSKILL vs "no change"  (positive = better; walk-forward, out-of-sample)\n${"=".repeat(78)}`);
  const hdr = TRAITS.map((t) => t.toUpperCase().padStart(9)).join("");
  console.log(`  ${"model".padEnd(14)}${hdr}${"  overall".padStart(9)}   n`);
  for (const m of models) {
    const cells: string[] = [];
    let we = 0, wn = 0, tot = 0;
    for (const t of TRAITS) {
      const s = scores.get(m)!.get(t)!;
      if (!s.err.length) { cells.push("—".padStart(9)); continue; }
      const e = mean(s.err), n = mean(s.naive);
      const skill = n > 0 ? ((n - e) / n) * 100 : 0;
      cells.push(`${fmt(skill, 1)}%`.padStart(9));
      we += e * s.err.length; wn += n * s.err.length; tot += s.err.length;
    }
    const overall = wn > 0 ? ((wn - we) / wn) * 100 : 0;
    console.log(`  ${m.padEnd(14)}${cells.join("")}${`${fmt(overall, 1)}%`.padStart(9)}   ${tot}`);
  }

  // Same table restricted to the kind of round we are actually predicting next.
  for (const only of ["interim", "official"]) {
    console.log(`\n  --- ${only.toUpperCase()} target rounds only ---`);
    const sub = new Map<string, Map<TraitKey, Score>>();
    for (const m of models) sub.set(m, new Map(TRAITS.map((t) => [t, { err: [], naive: [] }])));
    // Re-run the scoring loop restricted to this kind. Cheap enough to repeat.
    for (let ri = MIN_TRAIN; ri < roundKeys.length; ri++) {
      const target = roundKeys[ri];
      const test = cases.filter((c) => c.date.getTime() === target && c.kind === only);
      if (!test.length) continue;
      const train = cases.filter((c) => c.date.getTime() < target);
      const driftKind = new Map<string, number>();
      for (const t of TRAITS) for (const k of ["interim", "official"]) {
        const xs = train.filter((c) => c.t === t && c.kind === k).map((c) => c.actual - c.last);
        if (xs.length >= 30) driftKind.set(`${t}|${k}`, mean(xs));
      }
      for (const c of test) {
        const dk = driftKind.get(`${c.t}|${c.kind}`) ?? 0;
        const p = c.prevDelta ?? 0;
        const preds: Record<string, number> = {
          "drift(kind)": c.last + dk, "drift(month)": c.last + dk,
          "phi-0.10": c.last - 0.10 * p, "phi-0.15": c.last - 0.15 * p, "phi-0.20": c.last - 0.20 * p,
          "drift+phi": c.last + dk - 0.15 * p, "daughters": c.last + dk,
        };
        for (const m of models) {
          const s = sub.get(m)!.get(c.t)!;
          s.err.push(Math.abs(preds[m] - c.actual));
          s.naive.push(Math.abs(c.last - c.actual));
        }
      }
    }
    console.log(`  ${"model".padEnd(14)}${hdr}${"  overall".padStart(9)}   n`);
    for (const m of ["drift(kind)", "phi-0.15", "drift+phi"]) {
      const cells: string[] = [];
      let we = 0, wn = 0, tot = 0;
      for (const t of TRAITS) {
        const s = sub.get(m)!.get(t)!;
        if (!s.err.length) { cells.push("—".padStart(9)); continue; }
        const e = mean(s.err), n = mean(s.naive);
        cells.push(`${fmt(n > 0 ? ((n - e) / n) * 100 : 0, 1)}%`.padStart(9));
        we += e * s.err.length; wn += n * s.err.length; tot += s.err.length;
      }
      console.log(`  ${m.padEnd(14)}${cells.join("")}${`${fmt(wn > 0 ? ((wn - we) / wn) * 100 : 0, 1)}%`.padStart(9)}   ${tot}`);
    }
  }

  // How big is the movement we are failing to predict? This is what the report
  // SHOULD be telling people, since the direction is not available.
  console.log(`\n${"=".repeat(78)}\nHOW FAR BULLS ACTUALLY MOVE ON A NON-APRIL ROUND\n${"=".repeat(78)}`);
  for (const k of ["interim", "official"]) {
    const cells = TRAITS.map((t) => {
      const xs = cases.filter((c) => c.t === t && c.kind === k).map((c) => Math.abs(c.actual - c.last));
      const moved = xs.filter((v) => v > 0).length;
      return `${t}: |Δ|=${fmt(mean(xs))} moved=${((moved / xs.length) * 100).toFixed(0)}%`;
    });
    console.log(`  ${k.padEnd(9)} ${cells.join("  ")}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
