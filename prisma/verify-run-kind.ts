import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const byKind = await prisma.geneticEvaluation.groupBy({ by: ["runKind"], _count: { _all: true } });
  console.log("evaluations by runKind:");
  for (const r of byKind.sort((a, b) => b._count._all - a._count._all))
    console.log(`   ${String(r.runKind ?? "(null)").padEnd(10)} ${r._count._all}`);

  const pref = await prisma.geneticEvaluation.groupBy({
    by: ["runKind"], where: { isPreferred: true }, _count: { _all: true },
  });
  console.log("\nPREFERRED evaluations by runKind (what the reports and mating program read):");
  for (const r of pref.sort((a, b) => b._count._all - a._count._all))
    console.log(`   ${String(r.runKind ?? "(null)").padEnd(10)} ${r._count._all}`);

  const nulls = await prisma.geneticEvaluation.groupBy({
    by: ["proofRun"], where: { runKind: null }, _count: { _all: true },
  });
  console.log(`\nrounds still unclassified: ${nulls.length}`);
  for (const r of nulls.sort((a, b) => b._count._all - a._count._all).slice(0, 12))
    console.log(`   ${String(r.proofRun).padEnd(16)} ${r._count._all}`);

  const files = await prisma.geneticEvaluation.groupBy({ by: ["sourceFile"], _count: { _all: true } });
  console.log(`\ndistinct sourceFile values recorded: ${files.length}`);
  for (const r of files.sort((a, b) => b._count._all - a._count._all).slice(0, 5))
    console.log(`   ${String(r.sourceFile ?? "(null)").padEnd(44)} ${r._count._all}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
