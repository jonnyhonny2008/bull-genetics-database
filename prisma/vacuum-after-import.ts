// ---------------------------------------------------------------------------
// Reclaim dead tuples and refresh planner statistics after a bulk import.
//
// WHY THIS HAS TO BE EXPLICIT. A round writes ~170,000 new evaluation rows and
// updates a comparable number, so it leaves hundreds of thousands of dead tuples
// behind. Measured on the live database after the first whole-population import:
// GeneticEvaluation held 617 MB on disk for 207 MB of live data — 65% dead space.
// Autovacuum does run, but Postgres's default autovacuum_vacuum_scale_factor of
// 0.2 means a table is not even considered until a fifth of it is dead, and a
// cost-throttled 2-core instance lags badly behind a burst that size.
//
// ANALYZE matters as much as VACUUM here and is the part people forget: straight
// after an import the planner's statistics still describe the PREVIOUS round, so
// the first queries against the new data can pick badly wrong plans (seq scans
// over a table that just tripled). That is usually what "the app got slow right
// after an import" turns out to be.
//
// VACUUM cannot run inside a transaction block, so every statement goes through
// $executeRawUnsafe directly and NEVER through $transaction.
//
// Plain VACUUM, not VACUUM FULL: FULL takes an ACCESS EXCLUSIVE lock and needs a
// complete second copy of the table free on a volume that is already the
// constraint. Plain VACUUM marks the space reusable, which is what the next
// round actually needs — the file stops growing rather than shrinking.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";

/** Tables a round churns, largest first so the important ones finish first. */
const TABLES = [
  "GeneticEvaluation",
  "UsEvaluation",
  "Animal",
  "AnimalIdentifier",
  "PedigreeIndexResult",
  "UsAnimal",
];

type Client = Pick<PrismaClient, "$executeRawUnsafe">;

export async function vacuumAfterImport(
  prisma: Client,
  opts: { tables?: string[]; log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  for (const t of opts.tables ?? TABLES) {
    const started = Date.now();
    try {
      await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "${t}"`);
      log(`[vacuum] ${t} — ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (e) {
      // A vacuum failure must never fail an otherwise-good import: the data is
      // already committed. Report it and continue — autovacuum will catch up.
      log(`[vacuum] ${t} FAILED (non-fatal): ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

// Standalone entry point.
if (process.argv[1] && /vacuum-after-import\.ts$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  vacuumAfterImport(prisma, { log: (m) => console.log(m) })
    .then(() => console.log("[vacuum] done"))
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
