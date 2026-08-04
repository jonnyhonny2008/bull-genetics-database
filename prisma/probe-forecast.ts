// Diagnostic (not part of the app): can ANY per-bull directional signal be found
// for the next proof round?
//
//   npx tsx --conditions=react-server prisma/probe-forecast.ts
//
// Answers, in order:
//   1. COVERAGE   — how much of `daughters` / `herds` / `sireType` / reliability
//                   is actually populated, per round. This gates everything else.
//   2. DIRECTION  — is the signed change of the next round predictable from
//                   anything known BEFORE it? Tested against the only honest
//                   baseline: "no change".
//   3. SEGMENTS   — the theory says young bulls taking on first daughters should
//                   DROP (genomic evaluations are optimistic). Test that
//                   directly rather than assuming it.
//
// Reports only. Changes nothing.

import { prisma } from "../src/lib/db";
import { isRollbackRound, isOfficialProof } from "../src/lib/rollback";

type Row = {
  animalId: string;
  evaluationDate: Date;
  reliabilityOverall: number | null;
  daughters: number | null;
  herds: number | null;
  sireType: string | null;
  genotyped: boolean;
  activityCode: string | null;
  lpi: number | null;
  milk: number | null;
  fat: number | null;
  prot: number | null;
  conf: number | null;
};

const TRAITS = ["lpi", "milk", "fat", "prot", "conf"] as const;
type TraitKey = (typeof TRAITS)[number];

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
};
/** Standard error of a mean — the only way to tell a real bias from noise. */
const se = (xs: number[]) => sd(xs) / Math.sqrt(xs.length);

function kindOf(d: Date): string {
  if (isRollbackRound(d)) return "april";
  return isOfficialProof(d) ? "official" : "interim";
}

async function main() {
  const rows = (await prisma.geneticEvaluation.findMany({
    where: { animal: { archived: false, identifiers: { some: { active: true, idType: "naab" } } } },
    orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
    select: {
      animalId: true, evaluationDate: true, reliabilityOverall: true,
      daughters: true, herds: true, sireType: true, genotyped: true, activityCode: true,
      lpi: true, milk: true, fat: true, prot: true, conf: true,
    },
  })) as Row[];

  console.log(`\n${"=".repeat(78)}\n1. COVERAGE — ${rows.length} rounds across NAAB bulls\n${"=".repeat(78)}`);

  const cov = (pred: (r: Row) => boolean) =>
    `${((rows.filter(pred).length / rows.length) * 100).toFixed(1)}%`;
  console.log(`  daughters populated : ${cov((r) => r.daughters != null)}`);
  console.log(`  daughters > 0       : ${cov((r) => (r.daughters ?? 0) > 0)}`);
  console.log(`  herds populated     : ${cov((r) => r.herds != null)}`);
  console.log(`  reliability present : ${cov((r) => r.reliabilityOverall != null)}`);
  console.log(`  sireType present    : ${cov((r) => r.sireType != null)}`);
  console.log(`  genotyped = true    : ${cov((r) => r.genotyped)}`);

  // Coverage by round — a field present only on recent rounds is useless for
  // learning from history, which is what a forecast has to do.
  const byPeriod = new Map<string, { n: number; d: number; rel: number; date: Date }>();
  for (const r of rows) {
    const k = `${r.evaluationDate.getUTCFullYear()}-${String(r.evaluationDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const e = byPeriod.get(k) ?? { n: 0, d: 0, rel: 0, date: r.evaluationDate };
    e.n++;
    if (r.daughters != null) e.d++;
    if (r.reliabilityOverall != null) e.rel++;
    byPeriod.set(k, e);
  }
  const periods = [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n  round     bulls  daughters%  reliability%  kind`);
  for (const [k, v] of periods.slice(-16)) {
    console.log(
      `  ${k}   ${String(v.n).padStart(5)}  ${((v.d / v.n) * 100).toFixed(0).padStart(9)}%  ${((v.rel / v.n) * 100).toFixed(0).padStart(11)}%  ${kindOf(v.date)}`,
    );
  }

  // --- Build consecutive steps, tagged with everything known BEFORE the step ---
  const byBull = new Map<string, Row[]>();
  for (const r of rows) {
    const a = byBull.get(r.animalId);
    if (a) a.push(r); else byBull.set(r.animalId, [r]);
  }

  interface Step {
    kind: string;
    relBefore: number | null;
    dBefore: number | null;
    dGain: number | null;      // daughters added going INTO the step
    relGrowth: number | null;
    typeBefore: string | null;
    firstDaughters: boolean;   // 0 daughters before, some after
    delta: Partial<Record<TraitKey, number>>;
  }
  const steps: Step[] = [];
  for (const series of byBull.values()) {
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1], b = series[i];
      const delta: Partial<Record<TraitKey, number>> = {};
      for (const t of TRAITS) {
        const av = a[t], bv = b[t];
        if (av != null && bv != null) delta[t] = bv - av;
      }
      if (Object.keys(delta).length === 0) continue;
      steps.push({
        kind: kindOf(b.evaluationDate),
        relBefore: a.reliabilityOverall,
        dBefore: a.daughters,
        dGain: a.daughters != null && b.daughters != null ? b.daughters - a.daughters : null,
        relGrowth: a.reliabilityOverall != null && series[i - 2]?.reliabilityOverall != null
          ? a.reliabilityOverall - series[i - 2].reliabilityOverall! : null,
        typeBefore: a.sireType,
        firstDaughters: (a.daughters ?? 0) === 0 && (b.daughters ?? 0) > 0,
        delta,
      });
    }
  }
  console.log(`\n${"=".repeat(78)}\n2. DIRECTION — is the SIGNED change biased anywhere?\n${"=".repeat(78)}`);
  console.log(`  ${steps.length} consecutive steps.\n`);
  console.log(`  A forecast can only beat "no change" if mean signed Δ is reliably`);
  console.log(`  non-zero for some knowable group. |mean| must exceed ~2×SE to be real.\n`);

  function report(label: string, sel: (s: Step) => boolean) {
    const sub = steps.filter(sel);
    if (sub.length < 20) return;
    const parts: string[] = [];
    for (const t of TRAITS) {
      const xs = sub.map((s) => s.delta[t]).filter((v): v is number => v != null);
      if (xs.length < 20) { parts.push(`${t}: —`); continue; }
      const m = mean(xs), e = se(xs);
      const sig = Math.abs(m) > 2 * e ? "*" : " ";
      parts.push(`${t} ${fmt(m).padStart(7)}±${fmt(2 * e)}${sig}`);
    }
    console.log(`  ${label.padEnd(34)} n=${String(sub.length).padStart(5)}  ${parts.join("  ")}`);
  }

  console.log(`  --- by round kind (April is the known base change) ---`);
  for (const k of ["interim", "official", "april"]) report(k, (s) => s.kind === k);

  console.log(`\n  --- NON-APRIL only, by what we know before the round ---`);
  const nonApril = (s: Step) => s.kind !== "april";
  report("all non-April", nonApril);
  report("reliability < 0.75", (s) => nonApril(s) && s.relBefore != null && s.relBefore < 0.75);
  report("reliability 0.75-0.90", (s) => nonApril(s) && s.relBefore != null && s.relBefore >= 0.75 && s.relBefore < 0.9);
  report("reliability >= 0.90", (s) => nonApril(s) && s.relBefore != null && s.relBefore >= 0.9);
  report("genomic before step", (s) => nonApril(s) && s.typeBefore === "genomic");
  report("proven before step", (s) => nonApril(s) && s.typeBefore === "proven");
  report("0 daughters before", (s) => nonApril(s) && s.dBefore === 0);
  report("1-50 daughters before", (s) => nonApril(s) && s.dBefore != null && s.dBefore > 0 && s.dBefore <= 50);
  report("50+ daughters before", (s) => nonApril(s) && s.dBefore != null && s.dBefore > 50);
  report("FIRST daughters arrive", (s) => nonApril(s) && s.firstDaughters);
  report("daughters gained > 0", (s) => nonApril(s) && s.dGain != null && s.dGain > 0);
  report("daughters gained > 25", (s) => nonApril(s) && s.dGain != null && s.dGain > 25);
  report("reliability climbing >3pt", (s) => nonApril(s) && s.relGrowth != null && s.relGrowth > 0.03);
  report("reliability flat", (s) => nonApril(s) && s.relGrowth != null && s.relGrowth <= 0.001);

  console.log(`\n  --- APRIL only, same cuts (does the base change hit groups differently?) ---`);
  const april = (s: Step) => s.kind === "april";
  report("april · reliability < 0.75", (s) => april(s) && s.relBefore != null && s.relBefore < 0.75);
  report("april · reliability >= 0.90", (s) => april(s) && s.relBefore != null && s.relBefore >= 0.9);
  report("april · genomic before", (s) => april(s) && s.typeBefore === "genomic");
  report("april · proven before", (s) => april(s) && s.typeBefore === "proven");

  // --- 3. Persistence: does last round's move predict this round's move? -----
  console.log(`\n${"=".repeat(78)}\n3. PERSISTENCE — correlation of consecutive changes (non-April)\n${"=".repeat(78)}`);
  console.log(`  A negative r means proofs OVERSHOOT and bounce back — that would be`);
  console.log(`  forecastable. Near zero means each round is genuinely new information.\n`);
  for (const t of TRAITS) {
    const pairs: [number, number][] = [];
    for (const series of byBull.values()) {
      for (let i = 2; i < series.length; i++) {
        const a = series[i - 2], b = series[i - 1], c = series[i];
        if (isRollbackRound(b.evaluationDate) || isRollbackRound(c.evaluationDate)) continue;
        const av = a[t], bv = b[t], cv = c[t];
        if (av == null || bv == null || cv == null) continue;
        pairs.push([bv - av, cv - bv]);
      }
    }
    if (pairs.length < 50) { console.log(`  ${t.padEnd(6)} n=${pairs.length} — too thin`); continue; }
    const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
    const mx = mean(xs), my = mean(ys);
    const cov2 = mean(pairs.map(([x, y]) => (x - mx) * (y - my)));
    const r = cov2 / (sd(xs) * sd(ys));
    console.log(`  ${t.padEnd(6)} n=${String(pairs.length).padStart(5)}  r = ${fmt(r, 3).padStart(6)}   (r²=${fmt(r * r * 100, 1)}% of variance)`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
