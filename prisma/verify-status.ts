import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  // active/inactive must EXACTLY equal NAAB presence.
  const mism = await p.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM "Animal" a WHERE a."archived"=false
       AND ((EXISTS (SELECT 1 FROM "AnimalIdentifier" i WHERE i."animalId"=a."id" AND i."idType"='naab' AND i."active"=true)) <> (a."proofStatus"='active'))`);
  console.log(`active/inactive rows NOT matching NAAB rule: ${Number(mism[0].n)}  (want 0)`);
  // proven must include MACE (officialCode 3 on latest).
  const mace = await p.$queryRawUnsafe<{ st: string | null; n: bigint }[]>(
    `WITH latest AS (SELECT DISTINCT ON (e."animalId") e."animalId", e."officialCode"
       FROM "GeneticEvaluation" e WHERE e."approvalStatus"='approved'
       ORDER BY e."animalId", e."evaluationDate" DESC, CASE e."runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END, e."lpi" DESC NULLS LAST)
     SELECT a."sireType" AS st, COUNT(*) AS n FROM "Animal" a JOIN latest l ON l."animalId"=a."id"
     WHERE l."officialCode"='3' GROUP BY 1`);
  console.log("MACE (officialCode 3) bulls by sireType (want all 'proven'):");
  for (const r of mace) console.log(`  ${r.st}: ${Number(r.n)}`);
  // spot: a couple active + a couple inactive bulls with their NAAB status
  const sample = await p.$queryRawUnsafe<{ name: string; proofstatus: string; naab: string | null }[]>(
    `SELECT a."primaryName" AS name, a."proofStatus" AS proofstatus,
            (SELECT i."idValue" FROM "AnimalIdentifier" i WHERE i."animalId"=a."id" AND i."idType"='naab' AND i."active"=true LIMIT 1) AS naab
     FROM "Animal" a WHERE a."archived"=false AND a."sex"='M' ORDER BY a."proofStatus", random() LIMIT 6`);
  console.log("\nsample:"); for (const s of sample) console.log(`  ${s.proofstatus.padEnd(9)} NAAB=${s.naab ?? "—"}  ${s.name}`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
