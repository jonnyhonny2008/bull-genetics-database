// Diagnostic (not part of the app): the two hypotheses that are still open.
//
//   npx tsx --conditions=react-server prisma/probe-signal.ts
//
// H1 — INTERIMS PREDICT THE OFFICIAL ROUND.
//      Your original framing: "use the trends in the interims to predict the
//      next proof round". The single-step tests do not cover this. Lactanet
//      publishes interims monthly and an official round in Aug/Dec; if the
//      interims are already absorbing the new daughter data, then the drift
//      ACCUMULATED across them should say something about the official round.
//      Officials do move ~35% less than interims, which is consistent with
//      exactly that — so this deserves a direct test rather than an inference.
//
// H2 — CROSS-TRAIT STRUCTURE.
//      A genetic evaluation is multivariate. If Milk updates ahead of Fat, or a
//      conformation move leads an index move, then one trait's recent movement
//      predicts ANOTHER trait's next move even though it cannot predict its own.
//      Never tested — every test so far has been one trait in isolation.
//
// Both scored out-of-sample against "no change".

import { prisma } from "../src/lib/db";
import { isRollbackRound, isOfficialProof } from "../src/lib/rollback";

const TRAITS = ["lpi", "milk", "fat", "prot", "conf"] as const;
type TraitKey = (typeof TRAITS)[number];
type Row = { animalId: string; evaluationDate: Date } & Record<TraitKey, number | null>;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : "—");

async function main() {
  const rows = (await prisma.geneticEvaluation.findMany({
    where: { animal: { archived: false, identifiers: { some: { active: true, idType: "naab" } } } },
    orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
    select: { animalId: true, evaluationDate: true, lpi: true, milk: true, fat: true, prot: true, conf: true },
  })) as Row[];

  const byBull = new Map<string, Row[]>();
  for (const r of rows) { const a = byBull.get(r.animalId); if (a) a.push(r); else byBull.set(r.animalId, [r]); }

  const corr = (pairs: [number, number][]) => {
    if (pairs.length < 30) return NaN;
    const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
    const mx = mean(xs), my = mean(ys);
    const sx = Math.sqrt(mean(xs.map((v) => (v - mx) ** 2))), sy = Math.sqrt(mean(ys.map((v) => (v - my) ** 2)));
    return mean(pairs.map(([x, y]) => (x - mx) * (y - my))) / (sx * sy);
  };

  // --- H1 -------------------------------------------------------------------
  console.log(`\n${"=".repeat(84)}`);
  console.log(`H1 — does drift accumulated across the INTERIMS predict the OFFICIAL round?`);
  console.log(`${"=".repeat(84)}`);
  console.log(`  For each official round, the bull's total move across every interim since the`);
  console.log(`  previous official round, vs how he then moved ON the official round.\n`);
  console.log(`  ${"trait".padEnd(7)}${"n".padStart(6)}${"corr".padStart(9)}${"slope".padStart(9)}   verdict`);

  for (const t of TRAITS) {
    const pairs: [number, number][] = [];
    for (const s of byBull.values()) {
      let lastOfficialIdx = -1;
      for (let i = 0; i < s.length; i++) {
        const d = s[i].evaluationDate;
        if (isRollbackRound(d)) { lastOfficialIdx = i; continue; }   // April resets everything
        if (!isOfficialProof(d)) continue;
        if (lastOfficialIdx >= 0 && i - lastOfficialIdx >= 2) {
          const start = s[lastOfficialIdx][t];
          const beforeOfficial = s[i - 1][t];
          const onOfficial = s[i][t];
          if (start != null && beforeOfficial != null && onOfficial != null) {
            pairs.push([beforeOfficial - start, onOfficial - beforeOfficial]);
          }
        }
        lastOfficialIdx = i;
      }
    }
    const r = corr(pairs);
    const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
    const mx = mean(xs);
    const slope = pairs.length >= 30
      ? mean(pairs.map(([x, y]) => (x - mx) * y)) / mean(xs.map((v) => (v - mx) ** 2)) : NaN;
    const verdict = !Number.isFinite(r) ? "too few pairs"
      : Math.abs(r) < 0.1 ? "nothing"
      : r < 0 ? `interim drift PARTLY REVERSES (${fmt(r * r * 100, 1)}% of variance)`
      : `interim drift CONTINUES (${fmt(r * r * 100, 1)}% of variance)`;
    console.log(`  ${t.padEnd(7)}${String(pairs.length).padStart(6)}${fmt(r).padStart(9)}${fmt(slope).padStart(9)}   ${verdict}`);
  }

  // --- H2 -------------------------------------------------------------------
  console.log(`\n${"=".repeat(84)}`);
  console.log(`H2 — does one trait's last move predict ANOTHER trait's next move? (non-April)`);
  console.log(`${"=".repeat(84)}`);
  console.log(`  rows = the trait that just moved · columns = the trait moving next\n`);
  console.log(`  ${"last \\ next".padEnd(13)}${TRAITS.map((t) => t.toUpperCase().padStart(9)).join("")}`);

  // Collect (prevDelta per trait, nextDelta per trait) per bull-step.
  const obs: { prev: Partial<Record<TraitKey, number>>; next: Partial<Record<TraitKey, number>> }[] = [];
  for (const s of byBull.values()) {
    for (let i = 2; i < s.length; i++) {
      if (isRollbackRound(s[i].evaluationDate) || isRollbackRound(s[i - 1].evaluationDate)) continue;
      const prev: Partial<Record<TraitKey, number>> = {}, next: Partial<Record<TraitKey, number>> = {};
      for (const t of TRAITS) {
        const a = s[i - 2][t], b = s[i - 1][t], c = s[i][t];
        if (a != null && b != null) prev[t] = b - a;
        if (b != null && c != null) next[t] = c - b;
      }
      obs.push({ prev, next });
    }
  }
  let best = { r: 0, from: "", to: "" };
  for (const from of TRAITS) {
    const cells = TRAITS.map((to) => {
      const pairs = obs
        .filter((o) => o.prev[from] != null && o.next[to] != null)
        .map((o) => [o.prev[from]!, o.next[to]!] as [number, number]);
      const r = corr(pairs);
      if (Number.isFinite(r) && Math.abs(r) > Math.abs(best.r)) best = { r, from, to };
      return fmt(r, 3).padStart(9);
    });
    console.log(`  ${from.padEnd(13)}${cells.join("")}`);
  }
  console.log(`\n  strongest link: ${best.from} → ${best.to}, r = ${fmt(best.r)} (${fmt(best.r * best.r * 100, 1)}% of variance)`);
  console.log(`  Anything under |r| = 0.15 is under 2% of variance — not enough to move a forecast.`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
