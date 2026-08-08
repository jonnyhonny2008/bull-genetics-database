// ---------------------------------------------------------------------------
// Enforce the invariant: exactly ONE preferred GeneticEvaluation per animal —
// the latest approved proof round, official outranking interim on a shared date.
//
// THIS IS THE STEP THAT BURST pg_wal AND TOOK THE DATABASE READ-ONLY.
//
// The original shape was two unconditional statements:
//     UPDATE ... SET "isPreferred" = false WHERE "isPreferred" = true;   -- ~99K rows
//     UPDATE ... SET "isPreferred" = true  FROM (window function) ...;   -- ~99K rows
// which is ~200,000 heap row versions to express ~99,000 logical flips. Because
// `isPreferred` LEADS SIX INDEXES on this table, none of those updates can be a
// HOT update: every row version drags six index insertions with it. Lactanet
// ships 4-5 files per round and the pair ran once PER FILE, so a single round
// paid that cost four or five times over — of which only the first changed
// anything at all.
//
// Three things are fixed here:
//
//   1. CHANGE-ONLY. Each row is compared to the state it should be in and skipped
//      when it already matches (`IS DISTINCT FROM`). Files 2-5 of a round, and any
//      re-run, become nearly free. The FIRST file of a round still flips ~99K rows
//      because every bull genuinely does get a new proof every round — there is no
//      version of this that touches fewer, and pretending otherwise would be a lie.
//
//   2. CHUNKED, WITH A PAUSE. The flip is split into 8 passes over disjoint hash
//      buckets with a short sleep between them, so the checkpointer can retire WAL
//      instead of racing a single burst. Same total work, spread over ~30s.
//
//   3. NO BLANK WINDOW. The old pair committed statement 1 before statement 2, and
//      in between there were ZERO preferred evaluations table-wide. The animals
//      list and the dashboard both filter on `isPreferred`, so for that window the
//      whole app rendered empty. Computing the target state first and moving each
//      row directly to it removes the window entirely.
//
// Kept in ONE place and exported, because the three copies that used to exist had
// already drifted: this file's own version was missing the official-over-interim
// tiebreak that prisma/import-all-bulls.ts and prisma/import-cdn.ts both had, so
// running it standalone could promote an interim proof over the settled official
// one for the same round.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";

/** Hash buckets the flip is spread across. */
const BUCKETS = 8;
/** Pause between buckets, so WAL is generated in waves the checkpointer can absorb. */
const PAUSE_MS = 3000;

type Client = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NormalizeResult {
  /** Rows whose flag actually changed. Zero on a correct re-run. */
  flipped: number;
  /** Animals that now have exactly one preferred evaluation. */
  preferred: number;
}

export async function normalizePreferred(
  prisma: Client,
  opts: { log?: (msg: string) => void } = {},
): Promise<NormalizeResult> {
  const log = opts.log ?? (() => {});

  // The target state, computed ONCE. UNLOGGED so building it costs no WAL.
  //
  // A real table rather than a TEMP one on purpose: the importers construct their
  // own PrismaClient with a multi-connection pool, and a TEMP table created on one
  // connection is invisible to the next statement, which may be issued on another.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_pref_want"`);
  await prisma.$executeRawUnsafe(`
    CREATE UNLOGGED TABLE "_pref_want" AS
      SELECT "evaluationId",
             (rn = 1) AS want,
             (hashtext("evaluationId") & ${BUCKETS - 1}) AS bucket
      FROM (
        SELECT "evaluationId",
               ROW_NUMBER() OVER (PARTITION BY "animalId"
                 ORDER BY "evaluationDate" DESC,
                          CASE "runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END,
                          "lpi" DESC NULLS LAST, "evaluationId" DESC) AS rn
        FROM "GeneticEvaluation"
        WHERE "approvalStatus" = 'approved'
      ) s
  `);
  // Bucket-first: each pass scans 1/8 of the staging table, then looks each row up
  // in GeneticEvaluation by primary key.
  await prisma.$executeRawUnsafe(`CREATE INDEX ON "_pref_want" ("bucket")`);

  let flipped = 0;
  for (let k = 0; k < BUCKETS; k++) {
    const n = await prisma.$executeRawUnsafe(
      `UPDATE "GeneticEvaluation" g SET "isPreferred" = w.want
         FROM "_pref_want" w
        WHERE g."evaluationId" = w."evaluationId"
          AND w."bucket" = $1
          AND g."isPreferred" IS DISTINCT FROM w.want`,
      k,
    );
    flipped += n;
    log(`[preferred] bucket ${k + 1}/${BUCKETS}: ${n} row(s) flipped`);
    if (k < BUCKETS - 1 && n > 0) await sleep(PAUSE_MS);
  }

  // The staging CTE covers APPROVED rows only, but the statement this replaces had
  // no approvalStatus filter and therefore also cleared the flag on pending rows.
  // Without this companion pass an approved-then-unapproved row could keep a stale
  // preferred flag, which is a behaviour change rather than a fix.
  flipped += await prisma.$executeRawUnsafe(
    `UPDATE "GeneticEvaluation" SET "isPreferred" = false
      WHERE "isPreferred" AND "approvalStatus" <> 'approved'`,
  );

  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_pref_want"`);

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "GeneticEvaluation" WHERE "isPreferred"`,
  )) as { n: number }[];
  return { flipped, preferred: rows[0]?.n ?? 0 };
}

// Standalone entry point.
if (process.argv[1] && /normalize-preferred\.ts$/.test(process.argv[1])) {
  const prisma = new PrismaClient();
  normalizePreferred(prisma, { log: (m) => console.log(m) })
    .then(async (r) => {
      console.log(`[normalize] ${r.flipped} flag(s) changed; ${r.preferred} preferred evaluation(s) now set`);
      const animals = (await prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "animalId")::int AS n FROM "GeneticEvaluation" WHERE "approvalStatus" = 'approved'`,
      )) as { n: number }[];
      const expected = animals[0]?.n ?? 0;
      if (r.preferred !== expected) {
        console.warn(`[normalize] MISMATCH: ${expected} animal(s) have an approved eval but ${r.preferred} are flagged preferred.`);
      } else {
        console.log(`[normalize] OK — one preferred evaluation per animal with an approved proof (${expected}).`);
      }
    })
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
