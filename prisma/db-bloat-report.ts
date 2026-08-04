// READ-ONLY. Dead-tuple bloat + per-index size and usage for GeneticEvaluation.
//   npx dotenv -e .env.production -- npx tsx prisma/db-bloat-report.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const dead: { relname: string; n_live_tup: bigint; n_dead_tup: bigint; last_autovacuum: Date | null }[] =
    await prisma.$queryRawUnsafe(`
      SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
      FROM pg_stat_user_tables WHERE n_dead_tup > 0
      ORDER BY n_dead_tup DESC LIMIT 8`);
  console.log("\nDEAD TUPLES (reclaimable by VACUUM FULL)");
  console.log("TABLE                        LIVE      DEAD   last_autovacuum");
  for (const x of dead) {
    console.log(
      `${x.relname.padEnd(26)} ${String(x.n_live_tup).padStart(7)} ${String(x.n_dead_tup).padStart(9)}   ${x.last_autovacuum ?? "never"}`,
    );
  }

  const idx: { indexrelname: string; sz: string; idx_scan: bigint }[] = await prisma.$queryRawUnsafe(`
      SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS sz, idx_scan
      FROM pg_stat_user_indexes WHERE relname = 'GeneticEvaluation'
      ORDER BY pg_relation_size(indexrelid) DESC`);
  console.log("\nGeneticEvaluation INDEXES (scans = times the planner actually used it)");
  let unused = 0;
  for (const x of idx) {
    const flag = Number(x.idx_scan) === 0 ? "   <-- NEVER USED" : "";
    if (Number(x.idx_scan) === 0) unused++;
    console.log(`  ${x.indexrelname.padEnd(44)} ${x.sz.padStart(8)}  scans=${x.idx_scan}${flag}`);
  }
  console.log(`\n  ${idx.length} indexes, ${unused} never used since the last stats reset.`);
  console.log("");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
