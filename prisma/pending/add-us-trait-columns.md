# Making the American linear traits range-filterable

**Status: written, not applied.** Needs a production schema push, which nobody
has authorised. Everything below is ready to run as-is.

## Why this exists

The trait range picker on `/us/animals` offers 22 traits. Every one is backed by
a real indexed column on `UsEvaluation`. The other ~30 CDCB traits — including
**every individual linear type trait** — live only inside `gptaJson`, which is a
`String` column holding ~537 characters of JSON per row.

Filtering on one of those means casting 68,721 rows of text to `jsonb` per query.
Measured against production on 2026-08-07:

| Query                                     | Time     |
| ----------------------------------------- | -------- |
| `count(*) where isPreferred`              | 1.1 s    |
| `+ (gptaJson::jsonb->>'STA')::float <= 1` | 13.6 s   |
| `+ (gptaJson::jsonb->>'DFM')::float >= 1` | 19.1 s   |
| the same two-trait query, second run      | 34.4 s   |

It gets **slower** under load, because the cost is IO on a wide table (the row
also carries `relJson`, `dgvJson`, `paJson`, `gsonsJson`) rather than JSON
parsing. No amount of query-shaping fixes that; the traits need columns.

## What to add

Append to `model UsEvaluation` in `prisma/schema.prisma`, beside the existing
indexed columns:

```prisma
  // --- Linear type traits, on CDCB's -3..+3 scale ---------------------------
  // STA, RPA and RTP are INTERMEDIATE OPTIMUM (see us-cdcb/trait-catalog.ts).
  // Having a column does not make them sortable — it makes them RANGE-able,
  // which is the only filter that suits an optimum.
  sta Float?
  str Float?
  bde Float?
  dfm Float?
  trw Float?
  fua Float?
  ruh Float?
  ruw Float?
  ucl Float?
  ftp Float?
  rtp Float?
  tlg Float?
  udp Float?
  fta Float?
  rlr Float?
  rls Float?
  fls Float?

  // --- Calving. All four are % of hard births / stillbirths: LOWER is better,
  // and they are NOT deviations from zero. A range asks for a ceiling.
  sce Float?
  dce Float?
  ssb Float?
  dsb Float?

  // --- Fitness not already columned ----------------------------------------
  fs   Float?
  efc  Float?
  hcr  Float?
  hlv  Float?
  mspd Float?
  rfi  Float?
  gl   Float?

  // --- Disease resistance (deviations in % resistant — more is better) ------
  mas Float?
  met Float?
  rpl Float?
  ket Float?
  dab Float?
  mfv Float?
```

No new `@@index` lines. These are filter predicates, not sort keys, and Postgres
will not use a btree for a low-selectivity range like `sta <= 1` anyway — it
seq-scans either way. The win is not having to parse JSON while it does. Add an
index only for a trait that becomes a *default sort*.

## Applying it

```bash
npm run db:push:prod
```

Additive and nullable throughout, so no `--accept-data-loss` and no existing
column is touched.

## Backfilling

`prisma/pending/backfill-us-trait-columns.ts` fills them from `gptaJson` in a
single SQL statement, the same shape that backfilled `milkRel` in 48 s:

```bash
npx dotenv -e .env.production -- npx tsx prisma/pending/backfill-us-trait-columns.ts
```

One pass over the table, one `gptaJson::jsonb` cast per row rather than one per
trait. Expect a few minutes. It is idempotent — safe to re-run — and it must be
re-run after every CDCB import until the importer itself writes these columns.

## Then

1. In `src/lib/us-cdcb/persist-bulk.ts`, set the new columns at import time from
   the already-parsed `a.traits` map, exactly as `milkRel` is set. **Do this in
   the same change**, or the next import leaves 70,000 nulls behind it and the
   filter quietly stops matching new bulls.
2. Add the traits to `US_RANGE_TRAITS` in `src/lib/us-cdcb/range-traits.ts` —
   one line each, `direction: dir("STA")` and so on; the catalogue already knows
   which way is better for every one of them.
3. Delete the cost table from that file's header comment, and delete this file.
