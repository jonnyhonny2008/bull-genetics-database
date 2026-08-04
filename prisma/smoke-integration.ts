// Integration check (not part of the app): do the Proof Forecast report and the
// Mating Program report — built in parallel by two separate work streams —
// actually coexist?
//
//   npx tsx --conditions=react-server prisma/smoke-integration.ts
//
// Both are exercised IN ONE PROCESS against the real database, because that is
// where they could collide: a shared Prisma client, shared trait/reference
// caches, a shared Blondin role filter, and shared report primitives. Running
// them separately would not prove they can live in the same server.

import { getProofForecastReport } from "../src/lib/proof-forecast";
import { buildProofForecastWorkbook } from "../src/lib/proof-forecast-xlsx";
import { getMatingProgramReport, MATING_INDEXES } from "../src/lib/mating-program";
import { buildMatingProgramWorkbook } from "../src/lib/mating-program-xlsx";
import { prisma } from "../src/lib/db";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  // A real female to run the mating program against, so it does actual work
  // rather than short-circuiting on an empty input.
  const female = await prisma.animal.findFirst({
    where: { archived: false, sex: "F", identifiers: { some: { active: true, isPrimary: true } } },
    select: { primaryName: true, identifiers: { where: { active: true, isPrimary: true }, select: { idValue: true } } },
  });
  const femaleReg = female?.identifiers[0]?.idValue ?? "";
  console.log(`\n  test female: ${female?.primaryName ?? "(none found)"} ${femaleReg}\n`);

  console.log("  --- FORECAST REPORT ---");
  const t1 = Date.now();
  const fc = await getProofForecastReport({});
  check("forecast builds", fc.rows.length > 0, `${fc.rows.length} bulls in ${Date.now() - t1} ms`);
  check("forecast targets the next round", !!fc.targetLabel, `${fc.targetLabel} (${fc.targetKind})`);
  check("every bull has key-trait projections",
    fc.rows.every((r) => r.forecast.keyForecasts.length > 0));
  check("every key projection carries a confidence",
    fc.rows.every((r) => r.forecast.keyForecasts.every((k) => k.confidence != null && k.predicted != null)));
  check("confidences are real shares",
    fc.rows.every((r) => r.forecast.keyForecasts.every((k) => (k.confidence ?? -1) >= 0 && (k.confidence ?? 2) <= 1)));
  check("backtest ran", fc.backtest.ran, `range skill ${fc.backtest.overallRangeSkill}%`);
  check("backtest beats the model it replaced", (fc.backtest.overallRangeSkill ?? -1) > 0);

  console.log("\n  --- FORECAST, BLONDIN FILTER (the seam both sessions touch) ---");
  const fcB = await getProofForecastReport({ blondin: "1" });
  check("blondin filter narrows the lineup", fcB.compared > 0 && fcB.compared <= fc.compared,
    `${fcB.compared} of ${fc.compared}`);
  check("blondin cohort is labelled", fcB.cohortLabel.includes("Blondin"), fcB.cohortLabel);

  console.log("\n  --- MATING PROGRAM REPORT (other session) ---");
  const t2 = Date.now();
  const mp = await getMatingProgramReport(femaleReg ? { females: femaleReg, pool: "blondin", topN: "5" } : {});
  check("mating report builds", !!mp, `in ${Date.now() - t2} ms`);
  const mpAny = mp as unknown as Record<string, unknown>;
  const females = (mpAny.females as unknown[]) ?? [];
  check("mating report returns a females array", Array.isArray(females), `${females.length} female(s)`);

  // Every trait the menu offers must actually rank. The menu and the database
  // query were once maintained as two hand-written lists, and the query fell
  // three traits behind: Fat %, Protein % and Daughter Fertility were offered,
  // never read, and the report answered "no eligible bulls" while blaming the
  // proofs for data it had simply not selected. Only an end-to-end check catches
  // that, because each half was internally consistent.
  console.log("\n  --- EVERY RANKABLE TRAIT RETURNS BULLS ---");
  const dead: string[] = [];
  for (const i of MATING_INDEXES) {
    const r = await getMatingProgramReport({ females: femaleReg, index: i.code, topN: "3" });
    const fem = (r as unknown as { females?: { matches?: unknown[] }[] }).females ?? [];
    const n = fem.reduce((s, x) => s + (x.matches?.length ?? 0), 0);
    if (n === 0) dead.push(i.label);
  }
  check("no trait on the Rank-on menu returns an empty list",
    dead.length === 0, dead.length ? `dead: ${dead.join(", ")}` : `all ${MATING_INDEXES.length} rank`);

  console.log("\n  --- EXCEL EXPORTS (both) ---");
  const wb1 = await buildProofForecastWorkbook(fc);
  const buf1 = await wb1.xlsx.writeBuffer();
  check("forecast workbook builds", buf1.byteLength > 10000,
    `${(buf1.byteLength / 1024).toFixed(0)} kB, sheets: ${wb1.worksheets.map((w) => w.name).join(", ")}`);

  const wb2 = await buildMatingProgramWorkbook(await getMatingProgramReport(
    femaleReg ? { females: femaleReg, pool: "blondin", topN: "5" } : {}, { fullExclusions: true },
  ));
  const buf2 = await wb2.xlsx.writeBuffer();
  check("mating workbook builds", buf2.byteLength > 5000,
    `${(buf2.byteLength / 1024).toFixed(0)} kB, sheets: ${wb2.worksheets.map((w) => w.name).join(", ")}`);

  console.log("\n  --- INTERLEAVED (the actual collision test) ---");
  // Run both again, alternating, to catch a cache one report populates that the
  // other then reads wrongly — the failure a sequential run would miss.
  const [a, b, c] = await Promise.all([
    getProofForecastReport({}),
    getMatingProgramReport(femaleReg ? { females: femaleReg, pool: "blondin", topN: "5" } : {}),
    getProofForecastReport({ blondin: "1" }),
  ]);
  check("forecast is identical when run concurrently with the mating report",
    a.rows.length === fc.rows.length && a.backtest.overallRangeSkill === fc.backtest.overallRangeSkill,
    `${a.rows.length} rows, skill ${a.backtest.overallRangeSkill}%`);
  check("mating report survives concurrency", !!b);
  check("blondin forecast is identical under concurrency", c.compared === fcB.compared);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`  FAILED: ${failed.map((f) => f.name).join(", ")}`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { console.error("\n  THREW:", e); await prisma.$disconnect(); process.exit(1); });
