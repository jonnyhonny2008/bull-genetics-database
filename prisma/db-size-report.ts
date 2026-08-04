// READ-ONLY storage report. Writes nothing; run it against production safely:
//
//   npx dotenv -e .env.production -- npx tsx prisma/db-size-report.ts
//
// Answers: where is the space going, what does one proof round actually cost,
// and how many more rounds fit in the plan's remaining quota.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MB = (bytes: bigint | number) => Number(bytes) / 1024 / 1024;
const fmt = (n: number) => n.toFixed(1).padStart(8);

async function main() {
  const [{ total }] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT pg_database_size(current_database())::bigint AS total`,
  );
  console.log(`\nDATABASE TOTAL: ${MB(total).toFixed(1)} MB\n`);

  // Per-table: heap, indexes, TOAST (where long traitsJson strings spill).
  const tables = await prisma.$queryRawUnsafe<
    { name: string; total: bigint; heap: bigint; idx: bigint; toast: bigint }[]
  >(`
    SELECT c.relname AS name,
           pg_total_relation_size(c.oid)::bigint  AS total,
           pg_relation_size(c.oid)::bigint        AS heap,
           pg_indexes_size(c.oid)::bigint         AS idx,
           COALESCE(pg_total_relation_size(c.reltoastrelid),0)::bigint AS toast
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 15
  `);

  console.log("TABLE                          TOTAL      HEAP   INDEXES     TOAST");
  console.log("-".repeat(70));
  for (const t of tables) {
    console.log(
      `${t.name.padEnd(28)} ${fmt(MB(t.total))} ${fmt(MB(t.heap))} ${fmt(MB(t.idx))} ${fmt(MB(t.toast))}`,
    );
  }

  // Row counts for the tables a bulk import multiplies.
  const [animals, evals, ids, roles] = await Promise.all([
    prisma.animal.count(),
    prisma.geneticEvaluation.count(),
    prisma.animalIdentifier.count(),
    prisma.animalRole.count(),
  ]);
  console.log(`\nROW COUNTS  animals=${animals}  evaluations=${evals}  identifiers=${ids}  roles=${roles}`);

  if (evals > 0) {
    // What one evaluation row actually costs, and how much of it is traitsJson.
    const [sz] = await prisma.$queryRawUnsafe<
      { avg_row: number; avg_json: number; max_json: number; null_json: bigint }[]
    >(`
      SELECT AVG(pg_column_size(t.*))::float           AS avg_row,
             AVG(pg_column_size(t."traitsJson"))::float AS avg_json,
             MAX(pg_column_size(t."traitsJson"))::float AS max_json,
             COUNT(*) FILTER (WHERE t."traitsJson" IS NULL)::bigint AS null_json
      FROM (SELECT * FROM "GeneticEvaluation" LIMIT 20000) t
    `);
    const evalTotal = tables.find((x) => x.name === "GeneticEvaluation");
    const perRowAll = evalTotal ? Number(evalTotal.total) / evals : 0;

    console.log(`\nGeneticEvaluation, per row:`);
    console.log(`   tuple (heap only):        ${sz.avg_row?.toFixed(0)} bytes`);
    console.log(`   of which traitsJson:      ${sz.avg_json?.toFixed(0)} bytes  (max ${sz.max_json?.toFixed(0)})`);
    console.log(`   INCLUDING indexes+toast:  ${perRowAll.toFixed(0)} bytes  <-- the number that matters`);
    console.log(`   rows with null traitsJson: ${sz.null_json}`);

    const jsonShare = sz.avg_row ? (sz.avg_json / sz.avg_row) * 100 : 0;
    console.log(`   traitsJson is ${jsonShare.toFixed(0)}% of the stored tuple`);

    // Budget maths against the Supabase quota.
    const QUOTA_MB = 500;
    const usedMB = MB(total);
    const freeMB = QUOTA_MB - usedMB;
    const rowsThatFit = perRowAll > 0 ? (freeMB * 1024 * 1024) / perRowAll : 0;

    console.log(`\nBUDGET (500 MB plan)`);
    console.log(`   used ${usedMB.toFixed(0)} MB · free ${freeMB.toFixed(0)} MB`);
    console.log(`   evaluation rows that still fit: ~${Math.round(rowsThatFit).toLocaleString()}`);
    console.log(`   one all-breed round after the NAAB filter is ~116,000 bulls`);
    console.log(`   => rounds that fit: ${(rowsThatFit / 116000).toFixed(2)}`);
    console.log(`   (ignores the Animal/Identifier rows a first import also creates)`);
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
