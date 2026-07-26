import { PrismaClient } from "@prisma/client";
const p = new PrismaClient({ datasources: { db: { url: "file:./demo.db" } } });
const [animals, evals, traits, ids, males] = await Promise.all([
  p.animal.count(), p.geneticEvaluation.count(), p.geneticTraitValue.count(),
  p.animalIdentifier.count(), p.animal.count({ where: { sex: "M" } }),
]);
console.log(`animals=${animals} males=${males} evals=${evals} traitValues=${traits} identifiers=${ids}`);
// spot-check one imported bull (highest LPI in first 1000)
const top = await p.geneticTraitValue.findFirst({ where: { traitCode: "LPI" }, orderBy: { numericValue: "desc" }, include: { evaluation: { include: { animal: { include: { identifiers: true } }, traitValues: true } } } });
if (top) {
  const a = top.evaluation.animal;
  console.log(`sample top-LPI bull: ${a.primaryName} | LPI=${top.numericValue} | traits=${top.evaluation.traitValues.length} | ids=${a.identifiers.map(i=>i.idType+':'+i.idValue).join(', ')}`);
}
await p.$disconnect();
