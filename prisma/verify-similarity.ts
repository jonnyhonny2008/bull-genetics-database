// Read-only sanity check of "Sires that move like him" on the real lineup.
//   dotenv -e .env.production -- tsx --conditions=react-server <this>
//
// The question it answers: does residualisation actually change the answer, and
// are the top matches still dominated by bulls of the same age (which would mean
// the cohort term is not doing its job)?

import { prisma } from "../src/lib/db";
import { unpackTraits, traitDefMap } from "../src/lib/eval-traits";
import { roundKind } from "../src/lib/proof-forecast";
import { buildResidualIndex, findSimilar, compareBulls } from "../src/lib/proof-similarity";
import type { AnalogueBull } from "../src/lib/proof-analogue";

async function main() {
  const defMap = await traitDefMap();
  const animals = await prisma.animal.findMany({
    where: { archived: false, proofRoundCount: { gte: 2 }, identifiers: { some: { active: true, idType: "naab" } } },
    select: {
      id: true, primaryName: true, birthDate: true,
      identifiers: { where: { active: true, idType: "naab" }, select: { idValue: true } },
      evaluations: { orderBy: { evaluationDate: "asc" }, select: { evaluationDate: true, traitsJson: true, reliabilityOverall: true, daughters: true, sireType: true } },
    },
  });
  console.log(`bulls loaded: ${animals.length}`);

  const bulls: AnalogueBull[] = animals.map((a) => ({
    id: a.id,
    birthTime: a.birthDate?.getTime() ?? null,
    rounds: a.evaluations.map((e) => ({
      time: e.evaluationDate.getTime(),
      kind: roundKind(e.evaluationDate),
      rel: e.reliabilityOverall, daughters: e.daughters, sireType: e.sireType,
      traits: new Map(unpackTraits(e.traitsJson, defMap).filter((t) => t.numericValue != null).map((t) => [t.traitCode, t.numericValue as number])),
    })),
  })).filter((b) => b.rounds.length >= 2);

  const name = new Map(animals.map((a) => [a.id, a.primaryName]));
  const born = new Map(animals.map((a) => [a.id, a.birthDate?.getUTCFullYear() ?? null]));
  const rounds = new Map(bulls.map((b) => [b.id, b.rounds.length]));

  const t0 = Date.now();
  const index = buildResidualIndex(bulls, ["LPI"]);
  console.log(`residual index built in ${Date.now() - t0} ms; round grid ${index.grid.length} rounds; unmeasured (thin) trait-rounds: ${index.unmeasuredRounds}`);
  console.log(`steps crossing a round the bull has no row for: ${index.spanningSteps} (corrected against every round crossed); dropped for an unmeasurable crossed round: ${index.droppedSteps}`);

  // How big are the cohort terms actually being removed?
  const terms = [...index.cohort.get("LPI")!.entries()].sort((a, b) => a[0] - b[0]);
  const biggest = [...terms].sort((a, b) => Math.abs(b[1].median) - Math.abs(a[1].median)).slice(0, 6);
  console.log(`\ncohort LPI moves measured on ${terms.length} rounds. Largest:`);
  for (const [t, v] of biggest) {
    const d = new Date(t);
    console.log(`  ${d.toISOString().slice(0, 7)}  median ${v.median.toFixed(1).padStart(8)}  (n=${v.n})`);
  }

  // Pick a bull with a decent career.
  const subject = bulls.filter((b) => b.rounds.length >= 12).sort((a, b) => b.rounds.length - a.rounds.length)[0];
  if (!subject) { console.log("no bull with 12+ rounds"); return; }
  console.log(`\nsubject: ${name.get(subject.id)} (${rounds.get(subject.id)} rounds, born ${born.get(subject.id)})`);

  for (const mode of ["shape", "magnitude"] as const) {
    const t1 = Date.now();
    const res = findSimilar(index, subject.id, { mode });
    console.log(`\n  ${mode}  status=${res.status} compared=${res.compared} skipped=${res.skipped}  (${Date.now() - t1} ms)`);
    for (const m of res.matches.slice(0, 6)) {
      console.log(`    d ${String(m.distance.toFixed(3)).padStart(6)}  evidence ${String(m.score.toFixed(2)).padStart(6)}  rounds ${String(m.rounds).padStart(3)} (${String(m.informativeRounds).padStart(3)} moving)  born ${born.get(m.id) ?? "?"}  ${name.get(m.id)}`);
    }
    const years = res.matches.map((m) => born.get(m.id)).filter((y): y is number => y != null);
    console.log(`    birth years of the top matches: ${years.join(", ")} (subject ${born.get(subject.id)})`);
  }

  // THE DEFECT THIS REPLACED. Ranking on raw distance handed the top spot to
  // whoever had the least history — 48% of panels were headed by one of two
  // five-round bulls. Measure it across the whole lineup, both ways.
  {
    const topByScore = new Map<string, number>();
    const topByDistance = new Map<string, number>();
    let thinScore = 0, thinDistance = 0, panels = 0;
    for (const b of bulls) {
      const res = findSimilar(index, b.id, { mode: "shape", limit: 500 });
      if (res.status !== "ok" || !res.matches.length) continue;
      panels++;
      const byScore = res.matches[0];
      const byDistance = [...res.matches].sort((x, y) => x.distance - y.distance)[0];
      topByScore.set(byScore.id, (topByScore.get(byScore.id) ?? 0) + 1);
      topByDistance.set(byDistance.id, (topByDistance.get(byDistance.id) ?? 0) + 1);
      if (byScore.rounds <= 5) thinScore++;
      if (byDistance.rounds <= 5) thinDistance++;
    }
    const hog = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => `${name.get(id)} ×${n}`).join(", ");
    console.log(`\nranking check over ${panels} panels:`);
    console.log(`  ranked by raw distance : #1 rests on <=5 rounds in ${thinDistance} panels; biggest hoggers: ${hog(topByDistance)}`);
    console.log(`  ranked by evidence     : #1 rests on <=5 rounds in ${thinScore} panels; biggest hoggers: ${hog(topByScore)}`);
  }

  // Control: does removing the cohort term change WHO comes back?
  const rawIndex = { ...index, residuals: index.raw } as typeof index;
  const withRes = findSimilar(index, subject.id, { mode: "magnitude" }).matches.map((m) => m.id);
  const withoutRes = findSimilar(rawIndex, subject.id, { mode: "magnitude" }).matches.map((m) => m.id);
  const overlapIds = withRes.filter((id) => withoutRes.includes(id)).length;
  console.log(`\nresidualised vs raw top-${withRes.length}: ${overlapIds} bulls in common — residualisation ${overlapIds === withRes.length ? "CHANGED NOTHING (suspicious)" : "changes the answer"}`);

  const nine = buildResidualIndex(bulls, ["CONF", "LPI", "MILK", "FAT", "FATPCT", "PROT", "PROTPCT", "MSPD", "DF"]);
  console.log(`\nnine-trait scales (the commensurability problem, real numbers):`);
  for (const [c, s] of nine.scale) console.log(`  ${c.padEnd(8)} residual SD ${s.toFixed(3)}`);
  const t2 = Date.now();
  const all = findSimilar(nine, subject.id, { mode: "shape" });
  console.log(`\n  combined shape match (${Date.now() - t2} ms), status=${all.status}:`);
  for (const m of all.matches.slice(0, 6)) {
    // `rounds` is the career-step count a reader means; `elements` is the RMS
    // denominator, ~9x larger. Printing the latter as "rounds" was the defect.
    console.log(`    d ${String(m.distance.toFixed(3)).padStart(6)}  evidence ${String(m.score.toFixed(2)).padStart(6)}  rounds ${String(m.rounds).padStart(3)} (${String(m.informativeRounds).padStart(3)} moving, ${m.elements} elements)  traits ${m.traits.length}/9  ${name.get(m.id)}`);
  }
  const c = compareBulls(nine, subject.id, all.matches[0].id, { mode: "shape" })!;
  console.log(`    per-trait distances: ${c.traits.map((t) => `${t.code} ${t.distance.toFixed(2)}`).join(", ")}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
