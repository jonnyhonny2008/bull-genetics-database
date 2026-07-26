import { PrismaClient } from "@prisma/client";
const p = new PrismaClient({ datasources: { db: { url: "file:./demo.db" } } });

for (const code of ["CONF", "LPI", "MAMM"]) {
  const t0 = Date.now();
  const tvs = await p.geneticTraitValue.findMany({
    where: { traitCode: code, numericValue: { not: null }, evaluation: { isPreferred: true, approvalStatus: "approved", animal: { archived: false } } },
    orderBy: { numericValue: "desc" }, take: 5,
    include: { evaluation: { include: { animal: { select: { primaryName: true } } } } },
  });
  const ms = Date.now() - t0;
  console.log(`\nTop 5 by ${code} (${ms}ms):`);
  for (const tv of tvs) console.log(`  ${String(tv.numericValue).padStart(5)}  ${tv.evaluation.animal.primaryName}`);
}
await p.$disconnect();
