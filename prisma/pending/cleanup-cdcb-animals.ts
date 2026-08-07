// Clears the ground for the split American roster.
//
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server prisma/pending/cleanup-cdcb-animals.mts
//
// WHY THIS HAS TO RUN BEFORE `prisma db push`. The push adds UsEvaluation.usAnimalId
// as NOT NULL, and Postgres will refuse that against the rows already in the table
// because there is no value to give them. Those rows are re-creatable in full from
// the files in imports/cdcb, so emptying the American tables costs nothing and is
// the honest way through — inventing a placeholder id17 for each one would not be.
//
// WHAT IT TOUCHES, AND WHAT IT REFUSES TO
//
//   * every UsEvaluation and UsAiStatus row — American data, rebuilt by the import;
//   * the Animal rows the CDCB importer created, identified by the notes stamp it
//     writes. Verified against production 2026-08-07: 35,766 matched, and NONE of
//     them carried a Canadian proof, classification or milk record.
//
// It re-asserts that last condition INSIDE the deleting run rather than only
// beforehand, so it cannot fire against a database whose state moved underneath it.
// If a single matched animal has Canadian data, nothing is deleted at all.
//
// The Canadian side is untouched: after this, Animal holds only what predates the
// American addition, which is what the owner asked for.

const CDCB_CREATED = { notes: { contains: "Imported from CDCB" } };

// No top-level import remains, so declare these files modules explicitly —
// otherwise `main` lands in the global scope and collides between them.
export {};

async function main() {
  // Imported HERE, not at the top: a static named import fails under Node 24,
  // which treats this as strict ESM while src/lib/db compiles to CommonJS — and a
  // top-level await does not survive the CJS transform tsx applies to a .ts file.
  // Inside an async function both problems go away, whichever Node is on PATH.
  const { prisma } = await import("../../src/lib/db");
  const unsafe = await prisma.animal.count({
    where: {
      ...CDCB_CREATED,
      OR: [{ evaluations: { some: {} } }, { classifications: { some: {} } }, { milkRecords: { some: {} } }],
    },
  });
  if (unsafe) {
    console.error(`ABORT: ${unsafe} CDCB-created animals carry Canadian data. Nothing deleted.`);
    process.exit(2);
  }

  const evals = await prisma.usEvaluation.deleteMany({});
  const status = await prisma.usAiStatus.deleteMany({});
  console.log(`cleared ${evals.count} UsEvaluation, ${status.count} UsAiStatus`);

  let removed = 0;
  for (;;) {
    const batch = await prisma.animal.findMany({ where: CDCB_CREATED, select: { id: true }, take: 2000 });
    if (!batch.length) break;
    const ids = batch.map((b) => b.id);
    await prisma.animalIdentifier.deleteMany({ where: { animalId: { in: ids } } });
    await prisma.animalRole.deleteMany({ where: { animalId: { in: ids } } });
    await prisma.watchlist.deleteMany({ where: { animalId: { in: ids } } });
    removed += (await prisma.animal.deleteMany({ where: { id: { in: ids } } })).count;
    process.stdout.write(`\rremoved ${removed} CDCB-created animals`);
  }

  const remaining = await prisma.animal.count();
  console.log(`\nDONE. Animal table now ${remaining} rows — the Canadian roster.`);
  console.log("Next: npm run db:push:prod, then re-run the CDCB import.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
