// ---------------------------------------------------------------------------
// One-time backfill: tag every animal currently in the database as a Blondin
// house bull — an AnimalRole row with roleType = "blondin".
//
// WHY THIS MUST RUN *BEFORE* THE LACTANET MASS IMPORT
// ---------------------------------------------------
// Today every animal on file is a Blondin bull, so "everything in the table" is
// a correct definition of the Blondin lineup. The moment the Lactanet archive
// files are imported — hundreds of thousands of other studs' bulls — that stops
// being true, and there is no way to tell the two apart after the fact. This
// script is what freezes the distinction while it is still knowable.
//
// The marker is a role row rather than an Animal column so it needs no schema
// migration (roleType is free-form; see src/lib/sire-class.ts). It is also safe
// against the coming import: every importer writes AnimalRole rows only inside
// its "this animal is new" branch, and prisma/classify-sires.ts only ever
// UPDATEs Animal, so nothing an import does can drop or duplicate the tag.
//
// Archived animals are tagged too — archiving is a display decision, and an
// animal that is un-archived later should still read as a Blondin bull. The
// UI filter (blondinWhere in src/lib/sire-class.ts) handles `archived`
// separately.
//
// THE PREMISE IS MACHINE-CHECKED, NOT JUST DOCUMENTED
// ---------------------------------------------------
// A warning that only prints on the path that writes nothing protects nobody:
// the dangerous run is the one WITH --confirm. So --confirm now has to survive
// three checks before a single row is written, each of which fails closed:
//   1. --expect=<N> must equal the live animal count. The operator has to have
//      looked at the number, and that number changes by orders of magnitude the
//      moment the archive lands.
//   2. A hard cap (MAX_SAFE_TOTAL). The Blondin lineup is thousands of bulls;
//      the Lactanet archive is hundreds of thousands. No legitimate run of this
//      script is anywhere near the cap.
//   3. No trace of prisma/import-all-bulls.ts having already run — that is the
//      live code path that inserts other studs' bulls as new Animal rows and so
//      breaks the premise. (--force-after-import overrides check 3 only, for
//      the case where that script was used on Blondin's own proof file.)
// Then it prints what it is about to do and counts down, so a wrong invocation
// is still interruptible before the first write.
//
// Usage:
//   npx dotenv -e .env.production -- npx tsx prisma/tag-blondin-animals.ts
//     → explains itself, prints the current animal count, writes NOTHING
//   npx dotenv -e .env.production -- npx tsx prisma/tag-blondin-animals.ts --dry-run
//     → scans in full and reports what it would write
//   npx dotenv -e .env.production -- npx tsx prisma/tag-blondin-animals.ts --confirm --expect=<N>
//     → writes the tags
//
// Idempotent: an animal that already carries a "blondin" role is skipped, so
// re-running only fills in whatever is missing. Concurrency is handled by a
// Postgres advisory lock — a second simultaneous run aborts instead of racing
// the first one's check-then-insert and writing a duplicate set of roles.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { BLONDIN_ROLE } from "../src/lib/sire-class";

const prisma = new PrismaClient();

const CONFIRM = process.argv.includes("--confirm");
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE_AFTER_IMPORT = process.argv.includes("--force-after-import");
const EXPECT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--expect="));
  if (!arg) return null;
  const n = Number.parseInt(arg.slice("--expect=".length), 10);
  return Number.isFinite(n) ? n : null;
})();

/** Animals per round trip — keyset pagination, so the table size does not matter. */
const BATCH = 1000;

/**
 * Upper bound on a plausible Blondin lineup. Purely a tripwire: the whole point
 * is that a post-archive database cannot slip past --confirm. Raise it only if
 * the house lineup genuinely grows this far, never to get a run to go through.
 */
const MAX_SAFE_TOTAL = 50_000;

/** Seconds to wait, interruptibly, after printing the summary and before writing. */
const COUNTDOWN_SECONDS = 10;

/** Advisory-lock key — arbitrary but fixed, so only this script contends for it. */
const LOCK_KEY = 918_273_645;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rows written by prisma/import-all-bulls.ts — the archive path that breaks the premise. */
async function bulkImportEvidence(): Promise<{ fileName: string | null; at: Date } | null> {
  const hit = await prisma.sourceCapture.findFirst({
    where: { notes: { startsWith: "Bulk import of all bulls from" } },
    orderBy: { capturedAt: "desc" },
    select: { originalFileName: true, capturedAt: true },
  });
  return hit ? { fileName: hit.originalFileName, at: hit.capturedAt } : null;
}

function explain(total: number) {
  console.log("[blondin] Nothing was written.\n");
  console.log(`This script tags ALL ${total} animals currently in the database as Blondin`);
  console.log('house bulls (AnimalRole roleType = "blondin").\n');
  console.log("That is only correct BEFORE the Lactanet mass import. If those archive");
  console.log("files have already been loaded, this would mistag every other stud's bull");
  console.log("as a Blondin bull, and there is no way to undo it accurately.\n");
  console.log("  --dry-run              scan and report, write nothing");
  console.log(`  --confirm --expect=${total}   write the tags`);
  console.log("\n(--expect must match the count above, so an out-of-date invocation aborts.)");
}

async function main() {
  const total = await prisma.animal.count();

  // Neither flag: explain and leave.
  if (!CONFIRM && !DRY_RUN) {
    explain(total);
    return;
  }

  // --- Guards. Only the writing path has to clear them. --------------------
  if (CONFIRM && !DRY_RUN) {
    if (EXPECT === null) {
      console.error("[blondin] ABORTED — --confirm requires --expect=<N>.");
      console.error(`[blondin] The database holds ${total} animals right now.`);
      console.error(`[blondin] Re-run with:  --confirm --expect=${total}`);
      process.exitCode = 1;
      return;
    }
    if (EXPECT !== total) {
      console.error(`[blondin] ABORTED — --expect=${EXPECT} does not match the live count of ${total}.`);
      console.error("[blondin] Something changed since you read that number. Check WHY before re-running:");
      console.error("[blondin] a large jump means the Lactanet archive has already been imported, and");
      console.error("[blondin] tagging now would mark every other stud's bull as a Blondin bull.");
      process.exitCode = 1;
      return;
    }
    if (total > MAX_SAFE_TOTAL) {
      console.error(`[blondin] ABORTED — ${total} animals exceeds the ${MAX_SAFE_TOTAL} safety cap.`);
      console.error("[blondin] The Blondin lineup is thousands of bulls; a table this size means the");
      console.error("[blondin] Lactanet archive is already loaded and the premise of this script is void.");
      process.exitCode = 1;
      return;
    }
    const evidence = await bulkImportEvidence();
    if (evidence && !FORCE_AFTER_IMPORT) {
      console.error("[blondin] ABORTED — this database has already been through the bulk importer.");
      console.error(`[blondin] prisma/import-all-bulls.ts ran on "${evidence.fileName ?? "?"}" at ${evidence.at.toISOString()}.`);
      console.error("[blondin] That script inserts other studs' bulls as new Animal rows, so");
      console.error('[blondin] "everything in the table is a Blondin bull" may no longer be true.');
      console.error("[blondin] If that run was Blondin's OWN proof file, re-run with --force-after-import.");
      process.exitCode = 1;
      return;
    }

    // Serialize concurrent runs. The idempotency check below is a read followed
    // by a write, and AnimalRole has no unique constraint on (animalId, roleType),
    // so two simultaneous runs would each see "not tagged" and each insert — every
    // animal ending up with two active "blondin" rows. The lock lives on this
    // script's session and is released when it disconnects.
    // Inlined rather than parameterised: pg_try_advisory_lock is overloaded on
    // (bigint) and (int, int), and a bound parameter of an inferred type can fail
    // to resolve. LOCK_KEY is a numeric literal constant, so there is nothing to
    // inject. `::bigint` pins the overload.
    const [{ locked }] = await prisma.$queryRawUnsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_lock(${Number(LOCK_KEY)}::bigint) AS locked`,
    );
    if (!locked) {
      console.error("[blondin] ABORTED — another run of this script already holds the lock.");
      console.error("[blondin] Wait for it to finish; it may simply be slow on a large table.");
      process.exitCode = 1;
      return;
    }

    // Say exactly what is about to happen, then leave time to stop it. The first
    // createMany used to be the first thing the operator saw.
    const edges = await prisma.animal.findMany({ orderBy: { id: "asc" }, select: { primaryName: true }, take: 1 });
    const last = await prisma.animal.findMany({ orderBy: { id: "desc" }, select: { primaryName: true }, take: 1 });
    console.log("[blondin] ABOUT TO WRITE");
    console.log(`[blondin]   animals to tag as Blondin: ${total}`);
    console.log(`[blondin]   first: ${edges[0]?.primaryName ?? "—"}`);
    console.log(`[blondin]   last:  ${last[0]?.primaryName ?? "—"}`);
    console.log("[blondin]   These must ALL be Blondin house bulls. There is no accurate undo.");
    for (let s = COUNTDOWN_SECONDS; s > 0; s--) {
      process.stdout.write(`\r[blondin] starting in ${s}s — Ctrl-C to abort   `);
      await sleep(1000);
    }
    process.stdout.write("\r[blondin] starting.                              \n");
  }

  let scanned = 0;
  let tagged = 0;
  let already = 0;
  let cursor: string | null = null;

  for (;;) {
    const batch: { id: string }[] = await prisma.animal.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    scanned += batch.length;

    // Idempotency: one indexed lookup per batch tells us who is already tagged.
    // Matched on roleType alone, not `active`, so a deactivated tag is never
    // silently duplicated by a second active one. Safe against a concurrent run
    // because of the advisory lock taken above.
    const ids = batch.map((a) => a.id);
    const existing = await prisma.animalRole.findMany({
      where: { animalId: { in: ids }, roleType: BLONDIN_ROLE },
      select: { animalId: true },
    });
    const hasTag = new Set(existing.map((r) => r.animalId));
    const missing = ids.filter((id) => !hasTag.has(id));
    already += ids.length - missing.length;

    if (missing.length && !DRY_RUN) {
      await prisma.animalRole.createMany({
        data: missing.map((animalId) => ({ animalId, roleType: BLONDIN_ROLE, active: true })),
      });
    }
    tagged += missing.length;

    console.log(`[blondin] ${scanned}/${total} scanned · ${tagged} ${DRY_RUN ? "would be tagged" : "tagged"} · ${already} already tagged`);
  }

  console.log("");
  console.log(DRY_RUN ? "[blondin] DRY RUN — nothing was written." : "[blondin] Done.");
  console.log(`[blondin] animals scanned:       ${scanned}`);
  console.log(`[blondin] ${DRY_RUN ? "would be tagged:      " : "newly tagged Blondin: "} ${tagged}`);
  console.log(`[blondin] already tagged:        ${already}`);
  if (!DRY_RUN) {
    const check = await prisma.animalRole.count({ where: { roleType: BLONDIN_ROLE, active: true } });
    console.log(`[blondin] active "${BLONDIN_ROLE}" roles now on file: ${check}`);
    const dupes = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT "animalId" FROM "AnimalRole" WHERE "roleType" = ${BLONDIN_ROLE}
        GROUP BY "animalId" HAVING COUNT(*) > 1
      ) d`;
    const dupeCount = Number(dupes[0]?.n ?? 0);
    console.log(`[blondin] animals with a DUPLICATE "${BLONDIN_ROLE}" role: ${dupeCount}${dupeCount ? "  ← investigate" : ""}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
