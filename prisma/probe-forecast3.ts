// Diagnostic (not part of the app): the individual direction is unforecastable —
// but is the LINEUP AVERAGE? Those are different questions, and mean absolute
// error answers only the first.
//
//   npx tsx --conditions=react-server prisma/probe-forecast3.ts
//
// Walk-forward: for each target round, predict the cohort's MEAN change from
// prior rounds of the same kind only, and score it against predicting zero.
// Also checks whether the drift is concentrated in one part of the lineup.

import { prisma } from "../src/lib/db";
import { isRollbackRound, isOfficialProof } from "../src/lib/rollback";

const TRAITS = ["lpi", "milk", "fat", "prot", "conf"] as const;
type TraitKey = (typeof TRAITS)[number];
type Row = { animalId: string; evaluationDate: Date; daughters: number | null; sireType: string | null } & Record<TraitKey, number | null>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const kindOf = (d: Date) => (isRollbackRound(d) ? "april" : isOfficialProof(d) ? "official" : "interim");

async function main() {
  const rows = (await prisma.geneticEvaluation.findMany({
    where: { animal: { archived: false, identifiers: { some: { active: true, idType: "naab" } } } },
    orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
    select: { animalId: true, evaluationDate: true, daughters: true, sireType: true, lpi: true, milk: true, fat: true, prot: true, conf: true },
  })) as Row[];

  const byBull = new Map<string, Row[]>();
  for (const r of rows) { const a = byBull.get(r.animalId); if (a) a.push(r); else byBull.set(r.animalId, [r]); }

  interface Step { t: TraitKey; time: number; kind: string; d: number; dBefore: number | null; type: string | null }
  const steps: Step[] = [];
  for (const s of byBull.values()) {
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      for (const t of TRAITS) {
        const av = a[t], bv = b[t];
        if (av == null || bv == null) continue;
        steps.push({ t, time: b.evaluationDate.getTime(), kind: kindOf(b.evaluationDate), d: bv - av, dBefore: a.daughters, type: a.sireType });
      }
    }
  }

  console.log(`\n${"=".repeat(78)}\nCOHORT AVERAGE: is the LINEUP's mean move forecastable?\n${"=".repeat(78)}`);
  const times = [...new Set(steps.map((s) => s.time))].sort((a, b) => a - b);
  for (const kind of ["interim", "official"]) {
    console.log(`\n  --- ${kind} rounds ---`);
    console.log(`  ${"trait".padEnd(7)}${"rounds".padStart(7)}${"|err| drift".padStart(13)}${"|err| zero".padStart(12)}${"skill".padStart(9)}`);
    for (const t of TRAITS) {
      const errD: number[] = [], errZ: number[] = [];
      for (let i = 0; i < times.length; i++) {
        const target = times[i];
        const test = steps.filter((s) => s.t === t && s.time === target && s.kind === kind);
        if (test.length < 20) continue;
        const train = steps.filter((s) => s.t === t && s.time < target && s.kind === kind);
        if (train.length < 200) continue;              // need real history to learn a drift
        const pred = mean(train.map((s) => s.d));
        const actual = mean(test.map((s) => s.d));
        errD.push(Math.abs(pred - actual));
        errZ.push(Math.abs(actual));
      }
      if (errD.length < 4) { console.log(`  ${t.padEnd(7)}${String(errD.length).padStart(7)}   (too few rounds)`); continue; }
      const a = mean(errD), b = mean(errZ);
      console.log(`  ${t.padEnd(7)}${String(errD.length).padStart(7)}${fmt(a).padStart(13)}${fmt(b).padStart(12)}${`${fmt(b > 0 ? ((b - a) / b) * 100 : 0, 1)}%`.padStart(9)}`);
    }
  }

  console.log(`\n${"=".repeat(78)}\nWHERE THE INTERIM DRIFT LIVES (mean ΔLPI per interim step)\n${"=".repeat(78)}`);
  const segs: [string, (s: Step) => boolean][] = [
    ["all", () => true],
    ["genomic, no daughters", (s) => s.type === "genomic" && (s.dBefore ?? 0) === 0],
    ["genomic, has daughters", (s) => s.type === "genomic" && (s.dBefore ?? 0) > 0],
    ["proven", (s) => s.type === "proven"],
  ];
  for (const [label, sel] of segs) {
    const parts = TRAITS.map((t) => {
      const xs = steps.filter((s) => s.kind === "interim" && s.t === t && sel(s)).map((s) => s.d);
      if (xs.length < 30) return `${t}: —`;
      const m = mean(xs);
      const sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / xs.length);
      const se2 = (2 * sd) / Math.sqrt(xs.length);
      return `${t} ${fmt(m).padStart(7)}±${fmt(se2)}${Math.abs(m) > se2 ? "*" : " "}`;
    });
    const n = steps.filter((s) => s.kind === "interim" && s.t === "lpi" && sel(s)).length;
    console.log(`  ${label.padEnd(24)} n=${String(n).padStart(5)}  ${parts.join("  ")}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
