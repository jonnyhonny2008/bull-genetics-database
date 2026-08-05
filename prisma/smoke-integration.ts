// Smoke check (not part of the app): does the Mating Program report build and
// return real results against the live database?
//
//   npx tsx --conditions=react-server prisma/smoke-integration.ts
//
// Exercised against the real database, for a real female, across every rankable
// trait, and as an Excel workbook — the seams where an internally-consistent
// half can still be wrong end-to-end.

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

  console.log("  --- MATING PROGRAM REPORT ---");
  const t2 = Date.now();
  const mp = await getMatingProgramReport(femaleReg ? { females: femaleReg, pool: "blondin", topN: "5" } : {});
  check("mating report builds", !!mp, `in ${Date.now() - t2} ms`);
  const females = (mp as unknown as { females?: unknown[] }).females ?? [];
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

  console.log("\n  --- EXCEL EXPORT ---");
  const wb2 = await buildMatingProgramWorkbook(await getMatingProgramReport(
    femaleReg ? { females: femaleReg, pool: "blondin", topN: "5" } : {}, { fullExclusions: true },
  ));
  const buf2 = await wb2.xlsx.writeBuffer();
  check("mating workbook builds", buf2.byteLength > 5000,
    `${(buf2.byteLength / 1024).toFixed(0)} kB, sheets: ${wb2.worksheets.map((w) => w.name).join(", ")}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log(`  FAILED: ${failed.map((f) => f.name).join(", ")}`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => { console.error("\n  THREW:", e); await prisma.$disconnect(); process.exit(1); });
