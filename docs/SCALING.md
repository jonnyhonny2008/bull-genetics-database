# Scaling GenetiBase for recurring proof rounds

**The requirement this document exists for:** a new proof round is imported 3–4+
times a year, forever, and **every bull changes every round** — so each round
writes ~99,000 new Canadian evaluations and ~70,000 American ones (~170,000 rows).
Nothing here assumes "only a few animals changed", because that is never true.

Produced 2026-08-08 from a six-dimension audit of the codebase plus direct
measurement of the production database.

---

## Measured baseline (production, 2026-08-08)

| | |
|---|---|
| Database size | 1,582 MB of an 8,192 MB cap (Supabase spend cap) |
| `GeneticEvaluation` | 115,401 rows — **617 MB on disk for 207 MB of live data (65% dead space, via `pgstattuple`)** |
| Live row cost | 1,673 bytes live → 5,605 bytes on disk (~3.3× bloat) |
| `traitsJson` | 1,263 bytes = **75% of every row**, stored inline and uncompressed (rows sit under Postgres's ~2 KB TOAST/compression threshold) |
| `UsEvaluation` | 70,571 rows, 436 MB total |
| Compute | Small (2 GB RAM, 2-core); `statement_timeout` = **120 s**; `work_mem` = 5 MB |

**Index usage — the evidence for the write-amplification fixes.** The six
`[isPreferred, <trait>]` indexes on `GeneticEvaluation` occupy ~75 MB of that
table's 105 MB of indexes and have **184 index scans between them, ever** — two
have literally zero — against 295,803 for `animalId_evaluationDate`. Every one of
them is maintained on all ~200K flag flips per round.

---

## Status

**Done and verified against production:**

- **`isPreferred` write amplification (CA + US)** — change-only, chunked, no blank
  window, one shared implementation. Re-running now flips **0 rows** (was ~200K
  writes × 6 indexes, 4–5× per round). Commit `e79b4e6`.
- **`classify-sires` change-only** — **0 Animal rows written** (was ~300K per run,
  4–5× per round), identical output. Commit `9a6f9e9`.
- **VACUUM (ANALYZE) chained to both importers**, plus per-table autovacuum tuning
  applied to production (scale factors 0.2 → 0.02; `fillfactor=90` on `Animal`).
  Commit `9a6f9e9`.
- **`compute-rollback` OOM** — it retained every bull's evaluations in heap (~2 GB
  at the next round, since every bull would then qualify). Now streams and drops
  each chunk. Commit `11a2e6c`.
- **`compute-pedigree-index`** — was ~200,000 sequential round trips; now batched,
  252 s. Commit `9c1dee9`.

**Still open — see section A below, in priority order:** A0 (own the index DDL),
the remaining half of A3 (stop loading `traitsJson` in compute-rollback), A4, A7,
A8, A9, A10, A11.

**The two most urgent remaining:**
- **A9** — `/reports/proof-changes` loads every evaluation of every bull including
  `traitsJson`, with no limit. A `proofRoundCount >= 2` gate accidentally holds
  this down today; **that gate opens completely at the next round** and the report
  OOMs. It is the first page anyone opens when a round lands.
- **A0** — there is no `prisma/migrations` directory, and `us:finish` runs
  `prisma db push --accept-data-loss` against production. Any hand-written index
  is silently dropped by the next push.

---

# GenetiBase — Round-Absorption Implementation Plan

**Scope:** make the platform absorb ~170,000 new evaluation rows (~99K CA + ~70K US) 3–4× a year, forever, without corrupting a round, blowing the 8 GB cap, or degrading the app.

**Everything below is grounded in code read during this audit.** Where an auditor's claim did not survive checking, it is in **Rejected / Downgraded** at the end.

Two facts that shape the whole plan and that several auditors got half-right:

1. **There is no `prisma/migrations` directory.** `prisma migrate deploy` scripts exist in `package.json:11-12` but have nothing to deploy. The real deploy verb is `prisma db push`, and `package.json` `us:finish` runs `prisma db push --accept-data-loss` against production. **Any index created by hand in SQL will be silently dropped by the next push.** Several fixes below need raw-SQL indexes, so owning that DDL is a prerequisite, not an afterthought (item **A0**).
2. **Two mass-import paths exist and they disagree.** `prisma/import-all-bulls.ts` (CLI, also spawned by the review-queue approve at `src/lib/import-staging.ts:155`) runs the full derived refresh. The browser path (`src/app/(app)/import-proofs/MassImport.tsx` → `src/app/api/proof-import/chunk/route.ts`) runs **none** of it and has no finish call. A whole-population import through the button leaves the entire app on the previous round with no error.

---

## A. MUST-FIX BEFORE THE NEXT IMPORT

These either break the round, corrupt data, or take the database down. Ordered so each is safe to land independently.

### A0. Own the index DDL so `db push` can't delete it — S
**Change:** create `prisma/sql/indexes.sql` containing every index Prisma cannot express (partial and partial-unique), all written `CREATE INDEX IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`. Add an npm script `db:indexes:prod` that applies it, and make `us:finish` and any `db:push:prod` invocation run it immediately after the push. Follow the pattern already in `prisma/sql/us-tables.sql` and `prisma/sql/2026-07-animalidentifier-idvalue-index.sql`.

**Why it matters:** A3, A7 and several B items add partial/unique indexes. Without this step they exist until the next deploy and then vanish, and the failure is silent — a dropped partial unique index turns the idempotency guard in A7 into nothing, and a dropped leaderboard index turns a dashboard query into a seq scan over 1M rows.

**Files:** `prisma/sql/indexes.sql` (new), `package.json`.

---

### A1. Make the `isPreferred` normalization change-only and chunked — S
**This is the unfixed defect that PANICked pg_wal.**

`prisma/import-all-bulls.ts:256` clears the flag on every currently-preferred row, then `:257-268` re-sets ~99K rows with a window function. Two unconditional statements → ~200K heap row versions to express ~99K logical flips. `isPreferred` leads six indexes (`prisma/schema.prisma:380-385`), so **no update can be HOT** — every row version drags six index insertions. And because Lactanet ships 4–5 files per round, this pair runs 4–5× per round, of which only the first changes anything.

**Change:** replace lines 255–268 with a staged, guarded, chunked flip.

```sql
-- 1. Compute the target state once. UNLOGGED = no WAL for the staging table.
--    A real table, not TEMP: import-all-bulls.ts constructs its own PrismaClient
--    (line 40) with Prisma's default multi-connection pool, so a TEMP table
--    created on one connection is invisible to the next statement.
DROP TABLE IF EXISTS "_pref_want";
CREATE UNLOGGED TABLE "_pref_want" AS
  SELECT "evaluationId", (rn = 1) AS want FROM (
    SELECT "evaluationId",
           ROW_NUMBER() OVER (PARTITION BY "animalId"
             ORDER BY "evaluationDate" DESC,
                      CASE "runKind" WHEN 'official' THEN 0 WHEN 'interim' THEN 1 ELSE 2 END,
                      "lpi" DESC NULLS LAST, "evaluationId" DESC) AS rn
    FROM "GeneticEvaluation" WHERE "approvalStatus" = 'approved') s;
CREATE INDEX ON "_pref_want" ("evaluationId");

-- 2. Eight chunked passes, k = 0..7, with a 3s sleep between them so the
--    checkpointer can retire WAL instead of racing it.
--    (hashtext(x) & 7 — NOT abs(hashtext(x)) % 8, which errors on INT_MIN.)
UPDATE "GeneticEvaluation" g SET "isPreferred" = w.want
  FROM "_pref_want" w
 WHERE g."evaluationId" = w."evaluationId"
   AND g."isPreferred" IS DISTINCT FROM w.want
   AND (hashtext(g."evaluationId") & 7) = $k;

-- 3. Companion pass. Today's statement 1 has NO approvalStatus filter, so it
--    also clears pending rows; the CTE covers approved only. Without this the
--    behaviour changes.
UPDATE "GeneticEvaluation" SET "isPreferred" = false
 WHERE "isPreferred" AND "approvalStatus" <> 'approved';

DROP TABLE "_pref_want";
```

**Be honest about the limit:** because every bull genuinely changes every round, the *first* file of a round still flips ~200K rows. There is no version that touches fewer. What this buys: files 2–5 of the round and any re-run become near-free; no row is ever written twice; the WAL is spread over ~30s instead of arriving in one burst; and the blank window (between statement 1 committing and statement 2 committing there are currently **zero** preferred evaluations, and `src/app/(app)/animals/page.tsx:29` and `src/app/(app)/dashboard/page.tsx:216` both filter on it — the whole app shows empty) disappears.

**Apply the identical change in all three copies:** `prisma/import-all-bulls.ts:256-268`, `prisma/import-cdn.ts:198-213`, `prisma/normalize-preferred.ts:11-26`. They have already drifted — `normalize-preferred.ts:17` is missing the official-over-interim tiebreak the other two have, so running it standalone can pick the interim row as preferred. Extract the whole thing into `prisma/normalize-preferred.ts` as an exported `normalizePreferred(prisma)` and have the two importers call it, so it cannot drift again.

---

### A2. One-line guard on the US preferred recompute — S
`src/lib/us-cdcb/persist-bulk.ts:275`:

```ts
await prisma.usEvaluation.updateMany({ where: { usAnimalId: { in: slice } }, data: { isPreferred: false } });
```

No `isPreferred: true` predicate, no period scope. It rewrites **every** `UsEvaluation` row of every animal in the round, across all rounds ever imported — called with all ~70K animals from `prisma/import-cdcb.ts:165`. `isPreferred` leads five indexes (`schema.prisma:822-826`), so none of it is HOT. Cost per round is O(animals × rounds-ever), i.e. unbounded.

**Change:**
```ts
where: { usAnimalId: { in: slice }, isPreferred: true }
```
and add `isPreferred: false` to the where clause of the re-set at `:285`. Two words each; takes the write volume from O(animals × rounds) to O(rows that actually flip), and makes a re-import of an already-imported round free.

---

### A3. compute-rollback: stop loading `traitsJson` and stop retaining the herd — M
**This is arithmetic-certain to OOM on the very next import.**

`prisma/compute-rollback.ts:64` declares `evalsById` and `:80` fills it for every qualifying bull, retained until pass 2 at `:89`. The relation select at `:73` names **no fields**, so Prisma pulls every column including `traitsJson`, and `attachTraits` (`:76`) JSON-parses each one and materialises ~61 nine-field `TraitValueShape` objects per evaluation. Today most bulls fail the `HAVING COUNT(*) > 1` gate at `:50-53` and are never loaded. **After the next import every bull has two rounds and every bull qualifies at once.**

The waste is total: `EvalLite.traitValues` is typed `{ traitCode, numericValue }[]` (`src/lib/rollback.ts:33-40`), and the 14 traits actually scored — `HEADLINE_WEIGHTS` + `OTHER_TRAITS` at `src/lib/rollback.ts:137-140`: LPI, CONF, MILK, FAT, PROT, PRO$, LTI, HWI, MAMM, FL, DS, HL, PROTPCT, FATPCT — are **every one of them** backed by an indexed column in `TRAIT_COLUMNS` (`src/lib/eval-traits.ts:15-20`). I verified this by hand; the JSON is loaded, parsed and expanded for nothing.

**Change (three parts):**

1. Replace the `animal.findMany` at `:68-74` with a direct evaluation query selecting only what is used:
   ```ts
   const ROLLBACK_COLS: [string, string][] = [
     ["LPI","lpi"],["CONF","conf"],["MILK","milk"],["FAT","fat"],["PROT","prot"],
     ["PRO$","proDollar"],["LTI","lti"],["HWI","hwi"],["MAMM","mamm"],["FL","fl"],
     ["DS","ds"],["HL","hl"],["PROTPCT","protPct"],["FATPCT","fatPct"],
   ];
   prisma.geneticEvaluation.findMany({
     where: { animalId: { in: batch }, approvalStatus: "approved" },
     select: { animalId:true, evaluationDate:true, proofRun:true, reliabilityOverall:true, runKind:true,
               lpi:true, conf:true, milk:true, fat:true, prot:true, proDollar:true, lti:true,
               hwi:true, mamm:true, fl:true, ds:true, hl:true, protPct:true, fatPct:true },
     orderBy: [{ animalId: "asc" }, { evaluationDate: "asc" }],
   })
   ```
   Build `traitValues` from `ROLLBACK_COLS`. Drop the `attachTraits` / `traitDefMap` imports from this file. ~1.75 KB/row → ~150 B/row on the wire, and zero `JSON.parse`.
2. Replace `allDeltas: Record<string, number[]>` (`:65`, `:82`) with running moments `{n, sum, sumsq}` per trait. `deltaScalesFrom` → `baselineOf` (`src/lib/rollback.ts:346-352, 368-374`) only ever reduces to mean and SD; add a `deltaScalesFromMoments()` beside it. O(14) memory instead of O(all steps across the herd).
3. Delete `evalsById` and make pass 2 a second chunked fetch over the same `ids`. That is ~100–200 extra queries, not 100K, and it caps peak heap at one 1000-animal chunk forever instead of growing 700 MB per round.

**Add a guard test** in `src/lib/rollback.test.ts` (or a new one) asserting `ALL_TRAITS ⊆ Object.keys(TRAIT_COLUMNS)`, exporting `ALL_TRAITS` from `rollback.ts`. Without it, a future trait added to `HEADLINE_WEIGHTS` with no column would silently score `null` instead of failing loudly.

---

### A4. Split the derived refresh: must-run vs deferred — M
`prisma/import-all-bulls.ts:281-286` chains `classifySires` → `computeRollbackRatings` → `computePedigreeIndexAll`, four independent autocommit chains, no transaction, no completion marker. If step 2 dies (which, before A3, it will), `Animal.latestProofRun` already says the new round while `rollbackResistance` still holds April's numbers and `PedigreeIndexResult` is a full round stale — and nothing anywhere records that. The bull profile renders both side by side with equal authority.

**Change:**
- **Must-run**, chained to every import: `normalizePreferred()` (A1) then `classifySires(prisma)`. Both are pure set-based SQL, seconds, no Node memory, and together they are exactly what makes the new round *visible*.
- **Deferred**, run once per round out of band (npm script, admin button, or the existing `vercel.json` cron surface next to `src/app/api/cron/purge-denied/route.ts`): `computeRollbackRatings` and `computePedigreeIndexAll`. Nothing about import correctness depends on them.
- **Completion markers.** The pattern already exists — `compute-rollback.ts:162-170` upserts into `EnvironmentConfig`. Write `derivedRefresh.classify`, `.rollback`, `.pedigreeIndex`, each `{proofRun, finishedAt}`, at the end of each step. Render a banner on the dashboard and the bull profile when a step's `proofRun` ≠ the newest round. A stale analytics column that says it is stale is fine; one that silently claims to be current is not.

**Also:** importing five files for one round currently runs all three expensive steps five times. After this split they run once.

---

### A5. Make `classify-sires` change-only — S
`prisma/classify-sires.ts:69-76` rewrites `proofStatus` on **every** non-archived animal with no change predicate — 99,793 row versions per execution to change a handful. Add:

```sql
UPDATE "Animal" a SET "proofStatus" = x.v
  FROM (SELECT "id", CASE WHEN EXISTS (SELECT 1 FROM "AnimalIdentifier" i
          WHERE i."animalId" = "Animal"."id" AND i."idType"='naab' AND i."active")
        THEN 'active' ELSE 'inactive' END AS v
        FROM "Animal" WHERE "archived" = false) x
 WHERE a."id" = x."id" AND a."proofStatus" IS DISTINCT FROM x.v;
```

Do the same for the main UPDATE at `:53-63` (append a row-comparison `(a."sireType", a."latestProofDate", a."latestProofRun", a."latestActivityCode", a."rollbackCount", a."proofRoundCount") IS DISTINCT FROM (l."sireType", l."evaluationDate", l."proofRun", l."activityCode", g.rollbacks, g.rounds)`) and the NULL-out pass at `:80-88` (`AND a."sireType" IS NOT NULL`). Same guard on `compute-rollback.ts:127-141`.

`Animal` carries 11 indexes including `[rollbackResistance]` and `[proofPerformance]` (`schema.prisma:236-246`), so these are non-HOT updates. Expect touched rows per import to fall from ~300K to a few thousand — except on the main UPDATE, where genuinely everything changes, and that one honestly stays at ~99K.

---

### A6. VACUUM (ANALYZE) after every import, and tune autovacuum once — S
Nothing in the repo ever runs `VACUUM` or `ANALYZE`. I grepped: the only hits are the console label in `prisma/db-bloat-report.ts:13` and its read-only `pg_stat_user_tables` query. Meanwhile one round currently produces ~700K dead tuples against ~215K live rows, on a database whose 8 GB volume also holds `pg_wal`.

**Change:** add `prisma/vacuum-after-import.ts` invoked at the end of `import-all-bulls.ts` and `import-cdcb.ts`. Each statement via `$executeRawUnsafe`, **never** inside `$transaction`:
```
VACUUM (ANALYZE) "GeneticEvaluation";
VACUUM (ANALYZE) "Animal";
VACUUM (ANALYZE) "UsEvaluation";
VACUUM (ANALYZE) "UsAnimal";
VACUUM (ANALYZE) "PedigreeIndexResult";
VACUUM (ANALYZE) "AnimalIdentifier";
```

**One-off DDL (persists):**
```sql
ALTER TABLE "Animal"            SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_cost_delay=2, fillfactor=90);
ALTER TABLE "GeneticEvaluation" SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_cost_delay=2);
ALTER TABLE "UsEvaluation"      SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_cost_delay=2);
```
`fillfactor=90` on `Animal` is the important one: it leaves page slack so the repeated derived-column UPDATEs can be HOT and skip index maintenance for non-indexed columns. Postgres's default `autovacuum_vacuum_scale_factor` of 0.2 means `Animal` isn't even considered until 20K dead tuples pile up, and on a cost-throttled 2-core Small it lags a burst badly.

Also wire `prisma/db-bloat-report.ts` into the post-import log so bloat is visible every round rather than discovered at the cap.

---

### A7. Make `flush()` atomic and stop the duplicate-animal failure mode — S
`prisma/import-all-bulls.ts:149-159` issues five independent `insertChunked` calls, **each its own implicit transaction**, in the order animals → identifiers → roles → evals → pedigrees. Die between the first and second (dropped connection — the exact way the last sibling run died) and Animal rows exist with no AnimalIdentifier. On re-run, `regToAnimal` is rebuilt from AnimalIdentifier only (`:113-117`), so those bulls look brand new: fresh UUIDs, a **second** Animal row each. The orphans are permanently unfindable and the duplicates split the bull's proof history across two ids, corrupting rollback scoring and the Proof Change Report. There are 50 such windows per 99K-row run (`BATCH_BULLS = 2000` at `:46`). This is the one failure mode where re-running makes things worse.

**Change:** refactor `insertChunked` to **return** the array of `createMany` PrismaPromises rather than awaiting them (they are lazy), then in `flush()`:
```ts
await prisma.$transaction([...animalOps, ...idOps, ...roleOps, ...evalOps, ...pedOps]);
```
Prisma preserves array order, so the Animal → AnimalIdentifier FK ordering holds, and a flush is ~15 statements — short enough not to pin the oldest xmin.

**Backstop index** (in `prisma/sql/indexes.sql` per A0):
```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "AnimalIdentifier_type_value_uq"
  ON "AnimalIdentifier" ("idType","idValue") WHERE "active";
```
**Run the detection query first — this index will fail to create if the data is already dirty**, which is likely given B4 (recycled NAAB codes) and the orphan bug:
```sql
SELECT "idType","idValue", count(*), array_agg("animalId")
  FROM "AnimalIdentifier" WHERE "active" GROUP BY 1,2 HAVING count(*) > 1;
```
Treat any rows it returns as the pre-existing damage from the two defects above and reconcile them before creating the index.

---

### A8. Replace the US per-animal upsert loop with a chunked ON CONFLICT — M
`src/lib/us-cdcb/persist-bulk.ts:155-182` builds one `prisma.usAnimal.upsert` per animal and hands 500 at a time to `$transaction`. Prisma executes a batch transaction's operations **sequentially, one round trip each** — so the UsAnimal phase is **70,571 sequential round trips**, the identical shape that hung `compute-pedigree-index.ts` at 0.2 CPU-seconds of pure network wait. The file's own header comment at `:14-25` claims it does "a FIXED number of queries per file regardless of size". Steps 1, 2 and 5 honour that. Step 3 does not.

At a 30 ms RTT that is ~35 minutes of wall clock for a phase that should take seconds, and each 500-statement transaction holds a write transaction open ~15 s — 142 of them, pinning the oldest xmin and blocking autovacuum across the whole database on a 2-core/2 GB instance.

**Change:** ~2000 animals per chunk, 35 statements total.
```sql
INSERT INTO "UsAnimal" ("usAnimalId","id17","animalId","name","naabCode","breedCode","sex","birthDate","sire17","dam17")
SELECT gen_random_uuid()::text, v."id17", v."animalId", v."name", v."naabCode", v."breedCode", v."sex",
       v."birthDate", v."sire17", v."dam17"
  FROM jsonb_to_recordset($1::jsonb) AS v("id17" text, "animalId" text, "name" text, "naabCode" text,
       "breedCode" text, "sex" text, "birthDate" timestamptz, "sire17" text, "dam17" text)
ON CONFLICT ("id17") DO UPDATE SET
  "name"=EXCLUDED."name", "naabCode"=EXCLUDED."naabCode", "breedCode"=EXCLUDED."breedCode",
  "sex"=EXCLUDED."sex", "birthDate"=EXCLUDED."birthDate", "sire17"=EXCLUDED."sire17",
  "dam17"=EXCLUDED."dam17",
  "animalId"=COALESCE(EXCLUDED."animalId", "UsAnimal"."animalId")
RETURNING "usAnimalId","id17";
```
The `COALESCE` preserves the documented "never CLEAR a bridge" rule (`persist-bulk.ts:170-173`). **`usAnimalId` is `@default(cuid())` — Prisma-side, not a DB default (`schema.prisma:656`) — so the raw INSERT must supply the id;** `gen_random_uuid()::text` is fine, the column is a plain `String @id`. Feed `RETURNING` straight into `resolved`; keep `byId17` for the `createdAnimals` count. Drop the `$transaction` wrapper — each chunk is already atomic.

This is the single largest wall-clock cost of every US round.

---

### A9. Two-phase the Proof Change report before it OOMs the lambda — M
`src/lib/proof-change.ts:310-322` fetches every non-archived NAAB bull with `proofRoundCount >= 2` **and, for each, its entire evaluation history including `traitsJson`** — no `take` on either the outer query or the nested relation — then diffs exactly two rounds per bull.

Today the `>= 2 rounds` gate holds the set down (115,401 evals / 99,793 animals ≈ 1.16 rounds each). **At the next import every bull crosses that gate simultaneously**, and because `import-all-bulls.ts:232` drops rows without a NAAB code, essentially the whole roster qualifies. That is ~99,793 bulls × 2 rounds of packed ~61-trait JSON — roughly 340 MB of raw strings before Prisma's object overhead, then `unpackTraits` materialising ~12M objects. It will not be slow, it will be dead, and it is the first page the owner will open when a round lands. Five entry points share it uncached: `/reports/proof-changes`, `/reports/interim-changes`, `/reports/round-summary`, and both Excel export routes.

**Change:**
- **Phase 1 — round list from a cheap aggregate, not from every bull's rows.** Replace the `periodMap` loop at `:327-341` with a round-level query and wrap it in `cached('ca:proofPeriods', …)` from `src/lib/aggregate-cache.ts` (the round list is exactly the round-level fact that cache exists for, per its own charter comment at `:12`):
  ```sql
  SELECT date_trunc('month', g."evaluationDate") AS k, min(g."evaluationDate") AS d,
         count(DISTINCT g."animalId")::int AS bulls,
         bool_or(g."runKind" = 'official') AS official
    FROM "GeneticEvaluation" g JOIN "Animal" a ON a."id" = g."animalId"
   WHERE a."archived" = false AND g."approvalStatus" = 'approved'
   GROUP BY 1 ORDER BY 1 DESC;
  ```
- **Phase 2 — resolve `from`/`to` first, then fetch only those months.** Add `evaluationDate: { in: [...targetMonthStarts] }` to the nested relation. In auto mode fetch the newest **three** periods rather than two, so a bull whose latest round is one behind the herd is still comparable — that is what preserves today's "each bull's latest" semantics at bounded cost. Rows per bull go from N-and-growing to ≤3, forever.
- **Add `@@index([evaluationDate])`** on `GeneticEvaluation` — the existing `[animalId, evaluationDate]` cannot serve a date-only predicate.

**Behaviour note to accept deliberately:** a bull with no row in any of the three newest periods moves from "compared" to `notComparable`, which the report already reports as a count.

---

### A10. Close the browser-import path — S/M
`src/app/api/proof-import/chunk/route.ts:74-97` persists rows and returns. It never normalizes `isPreferred`, never calls `classifySires` / `computeRollbackRatings` / `computePedigreeIndexAll` — I grepped `src/` for all four and got zero hits outside `prisma/*.ts`. `persistBull` writes every new evaluation with `isPreferred: false` (`src/lib/proof-import.ts:146`), and `MassImport.tsx` loops chunks and simply stops (verified: no finish call after the loop). So a 99K-bull import through the button leaves **every new row unpreferred and the previous round still preferred** — the whole app silently displaying last round's numbers.

Separately, the per-row cost makes it unusable at population scale anyway: `persistBull` + `recomputePreferredForAnimal` (`src/lib/priority.ts:121-201`) is ~17 fixed queries plus one UPDATE per stored round — three `loadRankMap` pairs for data that never changes during an import, plus milk-record and classification passes that a *proof* import cannot possibly have touched, plus `:128` selecting every column including `traitsJson`. ~19 queries/row now, ~30 in three years: ~2–3M queries over ~495 browser-driven HTTP requests, on a pool pinned to `connection_limit=1` (`src/lib/db.ts:30-31`).

**Change (pick both):**
1. **Cap it.** Have `MassImport.tsx` refuse a file over ~5,000 data rows with a message pointing at the CLI / review-queue path. The route already caps a chunk at 1000 rows and `maxDuration = 120`; neither can hold a 99K-row job.
2. **Add `POST /api/proof-import/finish`** that `MassImport` calls after the last chunk and that runs **only the two cheap set-based steps**: the guarded flip from A1, then `classifySires(prisma)` (already pure `$executeRawUnsafe`, `prisma/classify-sires.ts:35-88`, so it fits in a serverless invocation). Do **not** put `computeRollbackRatings` or `computePedigreeIndexAll` in it — they load rows into Node and will blow both the 120 s limit and lambda memory. The UI must not report success until `finish` returns, and must show a loud error if it fails.

While in there, cheaply: add a `bulk` flag to `persistBull` that skips `recomputePreferredForAnimal`, and restrict the recompute to the `genetic_evaluation` domain (the milk and classification passes at `priority.ts:150-201` are dead work on a proof import).

---

### A11. Fix the capacity instrument — S
`prisma/db-size-report.ts:77` hardcodes `const QUOTA_MB = 500`; the cap is 8192. It therefore computes `freeMB` as a large negative number and prints a nonsensical "rounds that fit". `:85` hardcodes "~116,000 bulls" for the Canadian side only. `:45-50` counts `animal / geneticEvaluation / animalIdentifier / animalRole` and omits `usAnimal`, `usEvaluation` and `pedigreeIndexResult` entirely, so the American side — which now writes comparably per round — is invisible in the summary.

**Change:** `const QUOTA_MB = Number(process.env.DB_QUOTA_MB ?? 8192)`; add the three missing row counts; derive per-round cost by measuring rather than assuming (`pg_total_relation_size("GeneticEvaluation") / COUNT(DISTINCT "proofRun")` and the same for `UsEvaluation` / `periodKey`); add a dead-tuple line by joining `pg_stat_user_tables.n_dead_tup` (already queried in `db-bloat-report.ts:8-12`). **This is the gate in the runbook — it has to be right before it can be used.**

---

**Total A effort:** roughly 3–4 focused days. A1, A2, A5, A6, A7, A11 are all small and independent; A3, A8, A9 are the substantive ones.

---

## B. DO SOON — degrades badly as rounds accumulate

### B1. Give `GeneticEvaluation` a partial unique key and delete the whole-table preload — M
`prisma/import-all-bulls.ts:131-137` runs an unfiltered `findMany` over the entire evaluation table and builds a JS `Set` of composite keys plus a `maxDate` Map. It is a full sequential scan that evicts `shared_buffers` on a 2 GB instance right before the derived refresh runs, and it grows ~99K entries per round: ~1.1M rows and ~250 MB of Set within three years, with a 2–3× transient spike while the query engine buffers and deserialises.

Everything it buys is available from an index. `maxDate`/`unprefer` are already dead — the window pass at `:256-268` recomputes `isPreferred` from scratch anyway, and `void unprefer;` at `:255` admits half of it.

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "GeneticEvaluation_round_uq"
  ON "GeneticEvaluation" ("animalId","proofRun","runKind") WHERE "approvalStatus" = 'approved';
```
Partial, so the deliberate pending-beside-approved allowance documented at `schema.prisma:328-334` survives. Then delete `evalKey` / `maxDate` / `unprefer`, set `isPreferred: false` on every inserted row (A1 fixes it moments later), and switch the eval insert to `createMany({ data, skipDuplicates: true })` — bare `ON CONFLICT DO NOTHING` honours partial unique indexes. Replace `nameUpdate` with a set-based UPDATE joined to the newest approved round. Startup goes from a full-table scan to zero queries.

> **Required companion change, or approvals will start failing.** `src/lib/import-staging.ts:163-186` promotes pending rows to `approved` **first** and only then deletes the superseded approved row. With this index in place, the promote violates it. Reverse the order — delete the superseded approved rows first, then promote, inside one `$transaction`. No auditor caught this interaction; it is a hard break if B1 lands alone.

### B2. Convert the six `[isPreferred, trait]` indexes to partial — M, with a verification gate
`schema.prisma:380-385`. Every consumer constrains `isPreferred = true` (`dashboard/page.tsx:16,216,222`; `animals/page.tsx:98,115`; `sire-rank.ts:28-36`; `agent/tools.ts:1101-1103`), yet each index holds one entry per evaluation. Today 86% of rows are preferred so the leading boolean buys nothing; after five years it is ~5%, i.e. ~1.85M entries each carrying ~99K useful ones — hundreds of MB of pure dead weight that also inflates A1's flip cost every round.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ge_pref_lpi_idx" ON "GeneticEvaluation"("lpi") WHERE "isPreferred";
-- repeat for proDollar, conf, milk, fat, prot; same for UsEvaluation's five
```
**Two gates, both real:**
1. **Do A0 first.** Prisma 5.22 cannot express a partial index, so these must leave `schema.prisma` and live in `prisma/sql/indexes.sql`, re-applied after every `db push`.
2. **Verify the planner before dropping the composites.** Prisma sends `WHERE "isPreferred" = $1`; Postgres can only prove a partial-index predicate when the parameter is folded to a constant (custom plan), and prepared statements can flip to a generic plan after five executions. Run `EXPLAIN (ANALYZE)` on the actual Prisma-generated statement for the dashboard leaderboard and the animals trait sort. If it falls back to a seq scan, **keep the composites** and settle for the next point.
3. **Cheap first move regardless:** run `prisma/db-bloat-report.ts` (it already reports `idx_scan` per index and flags NEVER USED) and drop any of the six the planner has never chosen. `conf`/`milk`/`fat`/`prot` leaderboards may well be dead weight; each one dropped cuts both the per-round insert tax and A1's WAL proportionally, at zero risk.

### B3. Retention policy — M
No pruning exists anywhere. I searched `prisma/` and `src/` for prune/retention/archive and every `deleteMany` on an evaluation table: the only hits are `seed-demo.ts:32`, the per-round idempotency delete at `us-cdcb/persist-bulk.ts:190`, and review-queue cleanup at `import-staging.ts:177,349`.

Add `prisma/prune-rounds.ts`, chained after `classifySires`:
- **CA:** delete rows where `runKind='interim'` and `evaluationDate` is older than the second-most-recent official `proofRun`.
- **US:** delete rows where `sourceFamily='weekly'` (`runKind='unofficial'`, `periodKey` prefixed `W`, per `us-cdcb/file-kind.ts:104,114,122`) and `evaluationDate <` the most recent `all_evaluated` round date.

Both classes are already tie-break losers everywhere they are read (`priority.ts:136`, `proof-change.ts:125`, `agent/tools.ts:171,178`) and their only long-horizon consumer is `/reports/interim-changes`, which compares consecutive runs. Follow every prune with the A6 vacuum — the DELETE itself creates dead tuples.

**Measure the weekly stream before assuming its size.** Weekly is a `young_pub` file with a full date (`file-kind.ts:104`), i.e. new-genotype adds, not a full roster — likely a few thousand rows per file, not 70K. At up to 52 files/year that is still an unbounded, never-superseded accumulation, but size it from `db-size-report.ts` before deciding urgency.

### B4. Bring the bulk importer in line with the NAAB reassignment rule — S
`src/lib/proof-import.ts:82-89` enforces that a NAAB code belongs to one bull at a time (it deactivates the prior holder). `import-all-bulls.ts:123-128` tracks only `hasNaab`, a Set of animalIds — not a code→animal map. So (a) when a code moves from bull A to bull B, both end up active on it, and (b) if a bull's own code changes, `hasNaab.has(animalId)` is already true and the new code is never recorded at all. Per the project's own rule (active = carries a NAAB code), every recycled code permanently inflates the active lineup by one, and it compounds every round — exactly when a whole-population file re-asserts every code.

**Change:** add `idValue` to the select at `:125-127`; build `naabOwner: Map<code, animalId>` and `animalNaab: Map<animalId, code>`. In `queue()`, when the file's code differs from the stored one or `naabOwner` names a different animal, push the new identifier **and** collect `{code, keepAnimalId}`. After the flush loop, one statement:
```sql
UPDATE "AnimalIdentifier" i SET "active" = false
  FROM jsonb_to_recordset($1::jsonb) AS v(code text, keep text)
 WHERE i."idType"='naab' AND i."idValue"=v.code AND i."animalId" <> v.keep AND i."active";
```
This is also what makes A7's unique index creatable.

### B5. compute-pedigree-index: unique key, set-based upsert, explicit dependency — M
The commit-9c1dee9 batching fix is **sound** — I verified it: `parsedByAnimal` built up front (`:53`), distinct ancestor regs deduped (`:77`), both lookups chunked at 2000 (`:79-93`), `resolveFromMaps` pure with zero DB calls in the per-animal loop (`:97-109`). Three residual problems:

1. **Delete-then-insert churn.** `:132-138` deletes all ~91,776 rows in 459 separate transactions, then `:135-147` inserts them in 459 more. `PedigreeIndexResult` has **no unique constraint** (`schema.prisma:564-578`), so a partially-completed re-run double-inserts, and a failure between the two loops leaves a random subset of bulls with no pedigree index at all. **Fix:** add `@@unique([animalId, algorithmVersion])`, replace both loops with `INSERT … SELECT FROM jsonb_to_recordset(…) ON CONFLICT (animalId, algorithmVersion) DO UPDATE … WHERE (indexValue, confidenceScore, notes) IS DISTINCT FROM EXCLUDED.(…)` in ~2000-row batches — the exact pattern already used at `compute-rollback.ts:127-140`. 918 round trips → ~46, no torn window, and unchanged rows write nothing. Set `fillfactor=90` on the table so the updates are HOT.
2. **Silent dependency on `isPreferred`.** `:91` reads each ancestor's `evaluations: { where: { isPreferred: true }, take: 1 }` with no `orderBy`. In `import-all-bulls.ts` the flip runs first (`:256` before `:285`). In the browser path it never runs at all — so if pedigree index is ever invoked after that import it computes from the *previous* round's ancestor values and stamps a fresh `calculationDate`. Wrong numbers presented as current. **Fix:** once A4's markers exist, refuse to run unless `derivedRefresh.classify` records the current `proofRun`.
3. **Non-deterministic ancestor resolution.** `:83` builds `regToAnimalId` last-match-wins over rows arriving chunk-by-chunk in an order determined by the deduped `reg` array, so a registration claimed by two animals resolves differently between runs with identical input. **Fix:** detect regs claimed by >1 animal and resolve them to `null` with a logged count — `src/lib/relatedness.ts:88` already treats an ambiguous registration as something to report and never expand; follow that rule.

### B6. `/analysis?view=charts` streams the whole evaluation table — M
`src/app/(app)/analysis/page.tsx:288-294`: a `findMany` over `GeneticEvaluation` filtered only by `animal: animalWhere`, no `take`, no cache, page is `force-dynamic`, walked in JS at `:295-306` to bucket by career stage. The sibling aggregate 70 lines above (`:211-219`) **is** cached with a carefully-built filter key and a comment explaining why; this one was missed because it sits below the `view === "charts"` guard.

**Fix:** push the bucketing into SQL — `row_number() OVER (PARTITION BY "animalId" ORDER BY "evaluationDate") - 1 AS stage` over the matching rows, then `GROUP BY stage`. ~20 rows back instead of 200K-and-growing. The basis filter (`rollback` = April months, `official` = `runKind`) must move into SQL too, since `row_number()` may only advance on matching rounds. Then wrap in `cached('analysis:stageAvg:${col}|${alignBy}|${popKey}', …)` using the same key discipline as `:213`.

### B7. US round-compare: add the missing index and cache the period list — S
`src/lib/us-cdcb/round-compare.ts:94-99` — `listUsPeriods()` is a `groupBy` over the **entire** `UsEvaluation` table with no `where`, uncached, and it is called twice per render (once by the page, again inside `getUsRoundCompare` at `:140`). Then `:152-155` runs two `findMany` calls filtered on `periodKey`, which is only the **second** column of the only index that mentions it (`@@unique([usAnimalId, periodKey, sourceFamily])`, `schema.prisma:819`) — so Postgres cannot use it as a search key. Five sequential scans per render.

**Fix:** (a) add `@@index([periodKey])` to `UsEvaluation` — highest benefit-to-effort ratio in this audit; (b) wrap `listUsPeriods` in `cached("us:periods", …)` and pass the resolved `periods` into `getUsRoundCompare` instead of letting it re-query; (c) drop the `usAnimal: { select: { name } }` join for all but the top-N movers — names are needed for ~30 rows, not 140,000.

### B8. Give the importers their own database client — S
`src/lib/us-cdcb/persist-bulk.ts:3` imports the shared app singleton from `@/lib/db`, so a whole CDCB round runs through a pool configured for page rendering: `connection_limit` 5, `pool_timeout` 20 (`src/lib/db.ts:20-39`). A 20 s pool timeout will abort an import query rather than wait. Worse, `db.ts:48` reads `POSTGRES_PRISMA_URL ?? DATABASE_URL` — if `POSTGRES_PRISMA_URL` is ever present in the import shell, it silently overrides the `.env.production` `DATABASE_URL` and the import writes somewhere else with no log line naming the target. (This is a known past failure on this project.)

**Fix:** add `prisma/import-db.ts` constructing `new PrismaClient({ datasources: { db: { url: <DATABASE_URL with connection_limit=1, pool_timeout=120, connect_timeout=30> } } })`; have `persist-bulk.ts` / `persist.ts` accept the client as a parameter (`import-all-bulls.ts:40` already builds its own). Make it **refuse to run** if `POSTGRES_PRISMA_URL` is set, and log the resolved host+port before writing a row. `connection_limit=1` also makes `TEMP` tables safe if you prefer them over A1's UNLOGGED table.

### B9. `dataVersion` cache key so an import invalidates the app — S
`clearAggregateCache()` (`aggregate-cache.ts:65-68`) is only called from `review/actions.ts:94,109,124`, and even there clears one lambda. The real import is a separate process on the owner's machine that tells the app nothing. So after a round where every bull changed, the bound on staleness is the 10-minute TTL × however many warm lambdas exist — exactly when a stale number is most likely to be mistaken for a broken import.

**Fix:** have every importer write `EnvironmentConfig { key: "dataVersion", value: <roundKey + timestamp> }` as its last statement (the table and a memoised reader already exist — `getRollbackTraitScales` in `src/lib/reference.ts:49`). Add a `dataVersion()` reader memoised ~30 s and prefix every `cached()` key with it: `dashboard/page.tsx:49`, `us/dashboard/page.tsx:55`, `analysis/page.tsx:75` and `:212`, `us-cdcb/list-filters.ts:147,172`. One cheap indexed read per request buys correctness within 30 seconds, and lets the TTL rise to hours.

### B10. Animals list: cache the counts — S
`src/app/(app)/animals/page.tsx:127-130` and `:137` pay `prisma.animal.count()` over the full 99,793-row roster **and** an uncached `sireRoleCounts()` groupBy on every page view, strictly head-to-tail because `connection_limit=1` means the `Promise.all` parallelises nothing. The pill counts change only when `classify-sires` reruns.

**Fix:** mirror the discipline already in `src/lib/us-cdcb/list-filters.ts:171-173` — cache only when the filter set is trivial, so a narrowed query never gets a wide answer:
```ts
const roleCounts = Object.keys(sp).length === 0
  ? await cached('ca:roleCounts', () => sireRoleCounts(roleBase))
  : await sireRoleCounts(roleBase);
```
Same for the unfiltered total. For filtered views, fetch `PAGE_SIZE + 1` rows and show "50+" rather than an exact count.

### B11. Narrow the bull profile's history query — M
`src/app/(app)/animals/[id]/page.tsx:49-61` pulls `evaluations` with no `take`, no `select`, and `include: { source: true }` — every column of every round the bull has ever had, including `traitsJson`, then parsed by `attachTraits` at `:102` and rendered in full at `:617-647`. `milkRecords` and `classifications` have the same shape. Nothing is wrong today; the cost is a straight-line function of rounds-imported, the one quantity now committed to growing without bound.

**Fix:** two-tier it. Narrow unbounded select — `evaluationId, evaluationDate, proofRun, runKind, approvalStatus, reliabilityOverall, sourceId` plus the trait columns `computeRollback` and the trend chart need — and fetch `traitsJson` only for `displayEval` and `officialEval`. Cap the history card at the most recent 10 rounds behind a "show all" param. Replace `include: { source: true }` with a `sourceId → name` map from the already-memoised `getAllSources()` in `src/lib/reference.ts`.

### B12. Duplicate-detection scan on every profile view — S
`src/lib/quality.ts:99-115` loops `await prisma.animalIdentifier.findMany({ include: { animal: true } })` **once per identifier** — the same per-row-await shape as the pedigree bug — and `:119-122` does `primaryName: { contains: norm }`, which compiles to `LIKE '%NAME%'` and makes the `@@index([primaryName])` at `schema.prisma:236` unusable: a sequential scan of `Animal` on every main-tab profile view, which is the default landing for every bull. The page comment at `:123` acknowledges the cost but gating it to the main tab does not remove it.

**Fix:** (a) collapse the identifier loop into one query with `OR: identifiers.map(({idType,idValue}) => ({idType, idValue}))` and replace `include: { animal: true }` with a two-field `select`; (b) make the name match indexable — `pg_trgm` GIN index on `Animal("primaryName")`, which also fixes the animals-list `q` search (`animals/page.tsx:54-57`) and `/api/bull-search` (`route.ts:103-109`), all three of which use the same `contains` shape.

### B13. Backups and a per-round undo — M
`docs/BACKUP.md` is still SQLite-era: `:5-22` describes copying `prisma/production.db`, `:48` names it as the production database, `:51` claims `prisma/migrations/` is in source control — it does not exist. The only Postgres guidance is a plain-text `pg_dump` at `BACKUP.md:28` / `docs/DEPLOY.md:259-263`, which `DEPLOY.md:256` frames as necessary because the tier has no automatic backups. Nothing automates it and no import snapshots first.

**Fix:**
1. Rewrite `docs/BACKUP.md` for Postgres; use custom format (~10× smaller, restores selectively): `pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl -f backup-YYYY-MM-DD.dump`.
2. Make the snapshot the first action of `import-all-bulls.ts:73` and `import-cdcb.ts:51`, aborting the import if it fails.
3. **Write `prisma/rollback-round.ts <proofRun> <runKind>`.** A full restore is the wrong instrument for "the file was wrong and we noticed after the derived refresh ran". Every row already carries `proofRun`, `runKind` and `sourceFile` (`import-all-bulls.ts:209`), so a bad Canadian round is a scoped DELETE; the US side has the same handle via `periodKey` + `sourceFamily` (`persist-bulk.ts:190-193`). Have it re-run the flip, classify, and `VACUUM (ANALYZE)`.
4. Add `directUrl = env("DIRECT_URL")` to `schema.prisma:26-29` so DDL always has a non-pooled path.

---

## C. WORTH DOING — real, not urgent

- **C1. `insertChunked` column count.** `prisma/import-all-bulls.ts:154` passes `42` for a row that has 23 explicit fields plus up to 26 packed trait columns = 49. It computes 428 rows × 49 = 20,972 bind parameters — safe only because `MAX_VARS = 18000` (`:47`) is a leftover SQLite-era constant far below Postgres's 65,535. **Anyone "correcting" `MAX_VARS` to 65535 gets 76,440 parameters and a hard mid-import failure.** Fix: derive `cols` from `Object.keys(rows[0]).length` inside `insertChunked`, raise `MAX_VARS` to 60000 with a comment naming the real limit, and seed `packTraits`' `columns` record with all 26 keys set to `null` (`src/lib/eval-traits.ts:56` currently sets a column only when non-null, so rows have heterogeneous shapes) — that both makes the chunk size predictable and gives every row an identical 49-key shape. **S.**
- **C2. Per-round digest tables.** `ProofRoundSummary` (one row per round: n sires, hasOfficial, per-breed averages) plus `ProofRoundBullDelta` (roundKey, animalId, traitCode, previous, latest, delta, z), written set-based at the end of each import next to `import-all-bulls.ts:280-286`. Round-summary gainers/decliners become three indexed queries; the dashboard chart reads ~12 rows; `listProofRuns` (`proof-round-report.ts:346-353`, currently a `findMany` + `distinct` that reads every Holstein evaluation row to populate a ~10-entry dropdown) becomes a 12-row scan. This is the durable answer to the whole "what changed this round" family. A9 removes the acute risk; this removes the cost. **L.**
- **C3. Cache the immutable round comparisons.** `getRoundReport(from, to, type)` (`proof-round-report.ts:242-253`) and `getUsRoundSummary` (`us-cdcb/round-summary.ts:139-174`) are pure functions of two rounds that can never change after import, recomputed on every view and every export. Wrap each in `cached('round-compare:${from}|${to}|${type}', …)` with a long TTL — the key names immutable rounds, so a hit can never be wrong. Also replace `listProofRuns`' `distinct`-after-fetch with a real `groupBy`. **S.**
- **C4. Sort-column index policy.** `TRAIT_COLUMNS` exposes 26 sortable/range-filterable traits (`src/lib/eval-traits.ts:15-20`, `animals/page.tsx:51`, `ca-range-traits.ts:90,133-147`); six are indexed. Prefer **narrowing the UI** to the indexed set with a graceful fallback over adding 20 more indexes — extra indexes tax both the per-round insert and A1's flip. On the US side, `us/animals/page.tsx:317` uses `nulls: "last"` with `dir` defaulting to `"desc"`, which no btree can produce; drop it and exclude nulls in the `where` (what the Canadian branch already does at `animals/page.tsx:115`). **S.**
- **C5. `traitsJson` redundancy.** `packTraits` writes all ~61 traits keyed by code *and* duplicates 26 of them into indexed columns. Omitting the `n` field for traits in `TRAIT_COLUMNS` (and merging column values back in `unpackTraits`) is ~20% smaller JSON with no information lost. Only worth doing if the capacity projection below shows you missing the cap; it touches `mating-program.ts:809,1560` and `compare/page.tsx:46`. **M.**
- **C6. Statement timeouts.** Nothing sets `statement_timeout`, `idle_in_transaction_session_timeout` or `lock_timeout` anywhere — I searched the URLs (`.env.production:4`, `VERCEL_DATABASE_URL.txt:1`), `db.ts:20-39`, and every script. Set `ALTER DATABASE postgres SET statement_timeout = '60s'` and have the dedicated import client from B8 issue `SET statement_timeout = 0` after connect — safe precisely because that client holds one connection. **Do not use `SET` on the app's pooled client**: through the 6543 transaction pooler it does not survive the transaction. **S, but verify against the pooler before relying on it.**
- **C7. US dashboard aggregates.** `us/dashboard/page.tsx:231-235,258-262,274-279` group over the whole `UsEvaluation` table with no round bound, so cold-start cost rises ~70K rows every import for answers that are fixed between imports. Fold into C2's per-round summary; the "Recent import activity" card should read an import-log row rather than reverse-engineering a groupBy over every evaluation row ever written. **M.**

---

## Rejected / Downgraded

- **Partition `GeneticEvaluation` / `UsEvaluation`.** Correctly rejected by its own auditor. Every hot read keys on `isPreferred` or `animalId`, both of which cut across all rounds, so pruning never happens; `GeneticEvaluation`'s PK is `evaluationId` alone (`schema.prisma:292`) so partitioning needs a composite PK; and `db push` has no concept of partitions. Revisit only after B3 retention exists and the project is on `prisma migrate`.
- **"createMany fragments into many statements because rows have heterogeneous shapes."** The parameter arithmetic is right, the Prisma-grouping consequence was never verified against a query log. Kept as C1 for the `MAX_VARS` trap, dropped as a claimed throughput defect.
- **"`num()` does a linear find over a ~45-element array, ~10⁸–10⁹ string comparisons."** After A3 the array is 14 entries built from columns; the cost disappears as a side effect. No separate work.
- **"Move `isPreferred` off the history table onto `Animal.preferredEvaluationId`."** Structurally correct and the right end state, but ~50 files reference `isPreferred` and `animals/page.tsx:115-119` paginates by `ORDER BY <traitcol>` over preferred rows, which only stays index-sortable if the six sortable trait columns are also denormalised onto `Animal`. Not a pre-import change. Reconsider after A1 + B2 land and are measured.
- **"Bump Supabase compute for imports."** 170K inserts are WAL- and IO-bound, not RAM-bound. A temporary bump helps `work_mem` for the full-table sorts and disk IOPS on the first big VACUUM — worth doing on the round where you also run that VACUUM — but it is not a substitute for A1/A3/A5, which reduce the work rather than paying more to do it.
- **"Set timeouts via `options=` in the connection string."** Downgraded to C6 with a verification caveat: the 6543 transaction pooler ignores libpq startup parameters, and Supavisor session-mode passthrough was not verified here.
- **"Add partial indexes for all 26 sortable traits."** Downgraded into C4. They would be cheap on insert (new rows are `isPreferred=false`) but they add 26 indexes for A1's flip to maintain, which is the write path this plan is trying to protect. Narrowing the UI is the better trade until a current-proof projection exists.
- **"`compute-pedigree-index`'s `notes: { contains: 'SIRE:' }` seq scan."** Real but minor and correctly scoped (`:46-49` already selects only two columns). Noted, no action.

---

## STORAGE + CAPACITY — the honest projection

**Per-round live data added:**

| | rows/round | ~bytes/row incl. indexes + TOAST | ~MB/round |
|---|---|---|---|
| `GeneticEvaluation` | ~99,000 | ~1.5 KB (26 float8 + ~16 text/date + ~700 B compressed `traitsJson` + 10 indexes) | ~150 |
| `UsEvaluation` | ~70,571 | ~2.0 KB (five stringified JSON maps + ~20 floats + 11 indexes) | ~140 |
| **Total** | **~170,000** | | **~290 MB/round** |

At 3–4 rounds/year that is **~0.9–1.2 GB/year of live data**.

**Trajectory from 2.65 GB today, live data only:** ~3.7 GB at 1 yr · ~4.7 GB at 2 yr · ~5.7 GB at 3 yr · ~6.8 GB at 4 yr · ~7.8 GB at 5 yr. **Live data alone reaches 8 GB in year 4–5.**

**But the usable ceiling is much lower, and this is the number that matters.** Three claims on the same 8 GB volume:
- **Dead tuples.** Today a round produces ~700K dead tuples against ~215K live rows — `Animal` rewritten ~5× over, `GeneticEvaluation` twice over, `PedigreeIndexResult` fully delete-and-reinserted. Nothing vacuums. Heap files never shrink once bloated; they plateau at peak.
- **`pg_wal`.** It shares the volume, and it already caused a `PANIC: No space left on device` **at 2.65 GB of data used**. That single data point tells you the effective headroom is far smaller than "8 GB minus data" — assume 1–2 GB must stay free for WAL during an import.
- **Recovery headroom.** `VACUUM FULL` / `pg_repack` on the largest table needs a full second copy free.

**Effective ceiling as configured: ~5.5–6.0 GB, i.e. year 2–3.** With A1 + A2 + A5 + A6 landed, dead-tuple growth stops compounding and the projection converges on the live-data line: **year 4–5**. With B3 retention on CA interim rows and US weekly rows on top, expect to hold roughly flat against the current CA growth rate.

**Options, in order of preference:**

1. **Stop the write amplification (A1, A2, A5, A6, B5).** Free, in this plan, and it is what turns "year 2–3" into "year 4–5". Do this regardless of everything below.
2. **Retention (B3).** Prune CA interim rows older than the second-most-recent official round, and US weekly/unofficial rows superseded by the latest triannual. Both are already tie-break losers everywhere they are read. This is the only lever that makes growth sub-linear.
3. **Raise the Supabase spend cap / disk.** Buys time, costs money, and fixes nothing — the PANIC was a *rate* problem, not a volume problem. Worth doing anyway as insurance once A1 is in.
4. **`traitsJson` compaction (C5).** ~20% off the largest column, ~30 MB/round. Only pull this lever if 1–3 leave you short.
5. **Archive history out of the hot database** (S3/Parquet or a second cheap Postgres, keeping the current proof + last N rounds live). Correct end state at a 10-year horizon; do not start it before item 2 is in place, because retention may make it unnecessary.

**Instrument first:** A11 makes `prisma/db-size-report.ts` tell the truth. Every number above should be replaced by its measured output after the next import.

---

## IMPORT DAY RUNBOOK

Run in this order, every round. Steps marked **GATE** stop the round if they fail.

**Before you start**
1. **GATE — capacity check.** `npx dotenv -e .env.production -- npx tsx prisma/db-size-report.ts` and `prisma/db-bloat-report.ts`. **Refuse to start unless free space ≥ 3× the size of `GeneticEvaluation`** (the largest table any step rewrites). If not, run item 2 of the capacity options first.
2. **GATE — snapshot.** `pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl -f backup-$(date +%F).dump`. Verify the file is non-trivial before proceeding.
3. **Optional compute bump.** Temporarily move Supabase compute up one tier for the round — it helps `work_mem` on the full-table sorts and disk IOPS on the closing VACUUM. Move back afterwards. Not a substitute for the fixes; skip it once A1/A3/A5 are in and the round runs clean.
4. **Confirm the target.** `POSTGRES_PRISMA_URL` must be unset in the import shell (it silently overrides `DATABASE_URL` — `src/lib/db.ts:48`). With B8 landed the importer refuses to run and logs host+port; until then, check by hand.

**Canadian round**

5. Run the CLI importer per file, **not** the browser button: `npm run import:all -- <file>.csv`. All 4–5 files of the round. (After A1, files 2–5 cost almost nothing.)
6. The importer now ends with: guarded `isPreferred` flip (chunked, ~30 s) → `classifySires` → `VACUUM (ANALYZE)`. That is the must-run set — **the round is now visible in the app.**

**American round**

7. `npm run import:cdcb:prod -- ./imports/cdcb`. After A8 the UsAnimal phase is ~35 statements instead of 70,571 round trips; after A2 the preferred recompute only touches rows that actually flip.
8. `VACUUM (ANALYZE)` on the US tables (chained by A6).

**Derived analytics (deferred — A4)**

9. Run once for the whole round, not per file: `npm run rollback:prod` then the pedigree-index job. These write `EnvironmentConfig.derivedRefresh.*` markers on completion.
10. If either fails, **the round is still good** — the app shows a staleness banner rather than wrong numbers. Fix and re-run; do not re-import.

**Verify**

11. `SELECT count(*) FROM "GeneticEvaluation" WHERE "isPreferred"` should equal `SELECT count(DISTINCT "animalId") FROM "GeneticEvaluation" WHERE "approvalStatus"='approved'`. Any gap means the flip did not complete.
12. Dashboard, `/animals` sorted by LPI, `/reports/proof-changes` — all three should show the new round and no staleness banner. `/reports/proof-changes` is the memory-heaviest page; open it deliberately.
13. `prisma/db-size-report.ts` again — record the delta so the next round's gate uses a measured number.
14. Re-apply raw indexes if any `prisma db push` ran during the round (A0: `npm run db:indexes:prod`). **`us:finish` runs `db push --accept-data-loss` — if you used it, this step is mandatory.**
15. Cache: with B9 in place, nothing to do. Until then, redeploy or wait 10 minutes before trusting dashboard aggregates.

**If the round is wrong**

16. `npx tsx prisma/rollback-round.ts <proofRun> <runKind>` (B13) — scoped delete + re-normalize + re-classify + VACUUM. Do **not** restore the dump unless the scoped rollback cannot express the problem.