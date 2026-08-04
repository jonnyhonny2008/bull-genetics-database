// Smoke test (not part of the app): run the real report builder against the
// real database and print what a user would see.
//
//   npx tsx --conditions=react-server prisma/smoke-forecast.ts

import { getProofForecastReport } from "../src/lib/proof-forecast";
import { prisma } from "../src/lib/db";

async function main() {
  const t0 = Date.now();
  const r = await getProofForecastReport({});
  const ms = Date.now() - t0;
  // Second call proves the backtest memo works — that is the path a user hits
  // every time they sort, filter or open a bull.
  const t1 = Date.now();
  await getProofForecastReport({ sort: "name" });
  const ms2 = Date.now() - t1;

  console.log(`\n  built in ${ms} ms (cold) / ${ms2} ms (warm)`);
  console.log(`  target        : ${r.targetLabel} (${r.targetKind})`);
  console.log(`  latest on file: ${r.latestLabel}`);
  console.log(`  bulls         : ${r.compared} (${r.notComparable} not comparable)`);
  console.log(`  typical LPI move: ${r.typicalLpiMove}   likely to move: ${r.likelyToMove}/${r.compared}`);

  console.log(`\n  HOW THE LINEUP MOVES ON A ${r.targetKind.toUpperCase()} ROUND`);
  console.log(`  ${"trait".padEnd(22)}${"moves".padStart(8)}${"typical".padStart(10)}${"material".padStart(10)}${"n".padStart(7)}`);
  for (const m of r.movement) {
    console.log(`  ${m.label.padEnd(22)}${(m.movedShare + "%").padStart(8)}${String(m.typicalMove).padStart(10)}${String(m.material).padStart(10)}${String(m.n).padStart(7)}`);
  }

  console.log(`\n  MOST EXPOSED`);
  for (const b of r.mostExposed) console.log(`  ${b.name.slice(0, 34).padEnd(36)}${b.naab ?? "—"}   ±${b.expectedMove} LPI   ${b.pMove}% chance of a material move`);

  console.log(`\n  ACCURACY (range, vs the cohort band this replaces)`);
  const bt = r.backtest;
  console.log(`  ran=${bt.ran} bulls=${bt.bulls} round=${bt.roundLabel}  overall range skill=${bt.overallRangeSkill}%`);
  console.log(`  ${"trait".padEnd(22)}${"CRPS".padStart(10)}${"cohort".padStart(10)}${"skill".padStart(9)}${"cover".padStart(8)}${"no move".padStart(9)}`);
  for (const t of bt.traits) {
    console.log(`  ${t.label.padEnd(22)}${String(t.crps).padStart(10)}${String(t.cohortCrps).padStart(10)}${(t.rangeSkill + "%").padStart(9)}${(t.coverage + "%").padStart(8)}${(t.zeroShare + "%").padStart(9)}`);
  }

  const top = r.rows[0];
  if (top) {
    console.log(`\n  TOP ROW — ${top.name} (${top.naab ?? "—"})`);
    console.log(`    exposure ${top.forecast.exposure} (${top.forecast.exposureBand})  expected LPI move ±${top.forecast.expectedLpiMove}`);
    console.log(`    summary: ${top.forecast.summary}`);
    console.log(`    drivers: ${top.forecast.drivers.join(" · ")}`);
    for (const k of top.forecast.keyForecasts.slice(0, 5)) {
      console.log(`    ${k.name.padEnd(20)} ${String(k.current).padStart(8)} → range ${String(k.lo).padStart(8)}–${String(k.hi).padEnd(8)}` +
        ` ±${k.expectedMove}  up ${Math.round((k.pUp ?? 0) * 100)}% / steady ${Math.round((k.pSteady ?? 0) * 100)}% / down ${Math.round((k.pDown ?? 0) * 100)}%  [${k.basis}, n=${k.neighbours}]`);
    }
  }

  // Every bull must get a band, or the report has silently lost someone.
  const missing = r.rows.filter((x) => !x.forecast.keyForecasts.some((k) => k.code === "LPI" && k.lo != null));
  console.log(`\n  bulls with no LPI band: ${missing.length}`);
  const fallbacks = r.rows.filter((x) => x.forecast.keyForecasts.some((k) => k.basis === "cohort")).length;
  console.log(`  bulls falling back to the cohort band: ${fallbacks}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
