// Removes the CDCB-imported rows from the SHARED Animal table, restoring the
// Canadian side to "only the animals that were in the DB before the American
// addition". Run with:
//   npx dotenv -e .env.production -- npx tsx --conditions=react-server prisma/pending/cleanup-cdcb-animals.mts
//
// SAFE BY CONSTRUCTION: it only touches animals whose notes the CDCB importer
// stamped, and it re-asserts — inside the deleting run, not just beforehand —
// that none of them carries a Canadian proof, classification or milk record.
// Verified 2026-08-07 against production: 35,766 matched, 0 carried Canadian data.
// Everything it deletes is re-creatable from the files in imports/cdcb.
import { prisma } from "../../src/lib/db";

const CDCB = { notes: { contains: "Imported from CDCB" } };

async function main() {
  const unsafe = await prisma.animal.count({
    where: { ...CDCB, OR: [{ evaluations: { some: {} } }, { classifications: { some: {} } }, { milkRecords: { some: {} } }] },
  });
  if (unsafe) { console.error(`ABORT: ${unsafe} carry Canadian data`); process.exit(2); }

  let removed = 0;
  for (;;) {
    const batch = await prisma.animal.findMany({ where: CDCB, select: { id: true }, take: 2000 });
    if (!batch.length) break;
    const ids = batch.map((b) => b.id);
    await prisma.usEvaluation.deleteMany({ where: { animalId: { in: ids } } });
    await prisma.animalIdentifier.deleteMany({ where: { animalId: { in: ids } } });
    await prisma.animalRole.deleteMany({ where: { animalId: { in: ids } } });
    removed += (await prisma.animal.deleteMany({ where: { id: { in: ids } } })).count;
    process.stdout.write(`\rdeleted ${removed}`);
  }
  const [animals, us] = await Promise.all([prisma.animal.count(), prisma.usEvaluation.count()]);
  console.log(`\nDONE. removed ${removed}. Animal now ${animals}, UsEvaluation now ${us}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
