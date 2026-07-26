import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const [animals, evals, preferred, ids, breeds, users, milk, cls] = await Promise.all([
    prisma.animal.count(),
    prisma.geneticEvaluation.count(),
    prisma.geneticEvaluation.count({ where: { isPreferred: true } }),
    prisma.animalIdentifier.count(),
    prisma.breed.findMany({ select: { breedCode: true, _count: { select: { animals: true } } } }),
    prisma.user.count(),
    prisma.milkRecord.count(),
    prisma.classificationRecord.count(),
  ]);
  console.log("animals:", animals);
  console.log("geneticEvaluations:", evals, "(preferred:", preferred + ")");
  console.log("identifiers:", ids);
  console.log("users:", users, "| milk:", milk, "| classification:", cls);
  console.log("breeds:", breeds.map((b) => `${b.breedCode}=${b._count.animals}`).join(", "));
  // bull with the most proof rounds (best for trend testing)
  const top = await prisma.geneticEvaluation.groupBy({ by: ["animalId"], _count: { evaluationId: true }, orderBy: { _count: { evaluationId: "desc" } }, take: 3 });
  for (const t of top) {
    const a = await prisma.animal.findUnique({ where: { id: t.animalId }, select: { primaryName: true, identifiers: { where: { isPrimary: true }, select: { idValue: true } } } });
    console.log(`  top-trend bull: ${a?.primaryName} (${a?.identifiers[0]?.idValue}) — ${t._count.evaluationId} proof rounds`);
  }
  // sample preferred eval with LPI + conf to confirm columns populated
  const s = await prisma.geneticEvaluation.findFirst({ where: { isPreferred: true, lpi: { not: null } }, select: { proofRun: true, lpi: true, conf: true, milk: true, fat: true } });
  console.log("sample preferred eval:", JSON.stringify(s));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
