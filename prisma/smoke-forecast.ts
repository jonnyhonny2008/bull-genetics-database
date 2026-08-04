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
  console.log(`  avg LPI confidence: ${r.avgLpiConfidence}%   under 50%: ${r.lowConfidence}/${r.compared}`);

  console.log(`\n  HOW THE LINEUP MOVES ON A ${r.targetKind.toUpperCase()} ROUND`);
  console.log(`  ${"trait".padEnd(22)}${"moves".padStart(8)}${"typical".padStart(10)}${"material".padStart(10)}${"n".padStart(7)}`);
  for (const m of r.movement) {
    console.log(`  ${m.label.padEnd(22)}${(m.movedShare + "%").padStart(8)}${String(m.typicalMove).padStart(10)}${String(m.material).padStart(10)}${String(m.n).padStart(7)}`);
  }


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
    console.log(`    overall confidence ${Math.round((top.forecast.confidencePct ?? 0) * 100)}%  ·  evidence ${top.forecast.confidence}`);
    console.log(`    summary: ${top.forecast.summary}`);
    console.log(`    drivers: ${top.forecast.drivers.join(" · ")}`);
    console.log(`    ${"trait".padEnd(20)}${"current".padStart(10)}${"projected".padStart(11)}${"confidence".padStart(12)}`);
    for (const k of top.forecast.keyForecasts) {
      console.log(`    ${k.name.padEnd(20)}${String(k.current).padStart(10)}${String(k.predicted).padStart(11)}` +
        `${(Math.round((k.confidence ?? 0) * 100) + "%").padStart(12)}`);
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
