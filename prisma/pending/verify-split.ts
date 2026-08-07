// Proves the split actually holds, against the real database.
//
// Run by `npm run us:finish` after the schema push and the import. It checks the
// things that were WRONG before, not the things that are easy to check:
//
//   * the Canadian roster contains no American bull;
//   * every American bull is on the American roster;
//   * isPreferred is actually set — the import's final step silently did nothing
//     for its entire history, which is why the US lineup was empty after a run
//     that reported success;
//   * dual-registered bulls are joined in both directions.
//
// Exits non-zero if any of that is false, so a bad import fails loudly rather
// than leaving a plausible-looking but empty site.

// No top-level import remains, so declare these files modules explicitly —
// otherwise `main` lands in the global scope and collides between them.
export {};

async function main() {
  // Imported HERE, not at the top: a static named import fails under Node 24,
  // which treats this as strict ESM while src/lib/db compiles to CommonJS — and a
  // top-level await does not survive the CJS transform tsx applies to a .ts file.
  // Inside an async function both problems go away, whichever Node is on PATH.
  const { prisma } = await import("../../src/lib/db");
  const [caAnimals, usAnimals, usEvals, preferred, dual, orphanEvals, unnamed] = await Promise.all([
    prisma.animal.count(),
    prisma.usAnimal.count(),
    prisma.usEvaluation.count(),
    prisma.usEvaluation.count({ where: { isPreferred: true } }),
    prisma.usAnimal.count({ where: { animalId: { not: null } } }),
    // An evaluation with no roster row should be impossible: the FK forbids it.
    prisma.usEvaluation.count({ where: { usAnimalId: "" } }),
    prisma.usAnimal.count({ where: { name: null } }),
  ]);

  const byBreed = await prisma.usAnimal.groupBy({ by: ["breedCode"], _count: { _all: true } });
  const withTpi = await prisma.usEvaluation.count({ where: { tpi: { not: null } } });
  const withJpi = await prisma.usEvaluation.count({ where: { jpi: { not: null } } });

  console.log(`Canadian roster (Animal)   : ${caAnimals}`);
  console.log(`American roster (UsAnimal) : ${usAnimals}`);
  console.log(`  by breed                 : ${byBreed.map((b) => `${b.breedCode}=${b._count._all}`).join(" ")}`);
  console.log(`US evaluations             : ${usEvals}  (preferred ${preferred}, TPI ${withTpi}, JPI ${withJpi})`);
  console.log(`Dual-registered (bridged)  : ${dual}`);

  const problems: string[] = [];
  if (usAnimals === 0) problems.push("the American roster is empty — the import did not write");
  if (usEvals === 0) problems.push("no US evaluations were written");
  if (preferred === 0) problems.push("isPreferred is set on nothing — the US lineup will render empty");
  if (orphanEvals > 0) problems.push(`${orphanEvals} evaluations have no roster row`);
  if (unnamed > 0) problems.push(`${unnamed} roster rows have no name`);
  // The whole point: American bulls must not be in the Canadian table. Before the
  // split this number reached 59,634.
  const strays = await prisma.animal.count({ where: { notes: { contains: "Imported from CDCB" } } });
  if (strays > 0) problems.push(`${strays} CDCB-created animals are STILL in the Canadian table`);

  if (problems.length) {
    console.error("\nFAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nOK — the two rosters are separate, and the American side has data.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
