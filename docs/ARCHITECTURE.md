# Architecture

## Overview

A single Next.js 14 (App Router) application, backed by Prisma + SQLite, serving a
private role-based dashboard. The **same code and schema** run two environments; the
only difference is which database file and `APP_ENV` value are loaded at startup.

```
Browser ──HTTP──▶ Next.js (App Router)
                    │
                    ├─ Server Components  → read data via Prisma
                    ├─ Server Actions     → write data via Prisma (forms post here)
                    │                        + audit log + preferred recompute
                    └─ lib/ (auth, priority, quality, env, constants)
                    │
                    ▼
                 Prisma Client ──▶ SQLite (demo.db | production.db)
                    │
                    ▼
                 uploads/ (durable file storage for source captures)
```

## Key decisions

- **One `Animal` entity, many roles.** No separate bull/cow/heifer tables. Roles
  (`AnimalRole`) and identifiers (`AnimalIdentifier`) are child rows. The internal
  `Animal.id` (a cuid) is the only permanent key; registration numbers / NAAB / semen
  codes are never used as the primary key.
- **Historical, append-only records.** Genetic proofs, milk, and classification are
  new dated rows with flexible trait children — values are never overwritten.
- **Source traceability everywhere.** Every record can carry a `sourceId` and a
  `captureId` (the upload/entry it came from).
- **Preferred value is computed, not stored as truth.** `src/lib/priority.ts` resolves
  the preferred record live from `SourcePriorityRule`, and also persists an `isPreferred`
  flag (recomputed on every write) so dashboards/lists can query it cheaply.
- **Server Actions over REST.** Forms post directly to typed server actions
  (`actions.ts` files), which keeps the surface small and easy to maintain.
- **Zero-dependency auth.** `scrypt` (Node built-in) hashes passwords; an HMAC-signed
  cookie carries the session — no external auth service, no native modules.

## Request lifecycle (example: adding a proof)

1. `GET /animals/[id]/proofs/new` — a Server Component loads the animal + species-filtered
   trait definitions and renders a form.
2. The form posts to the `saveProof` **Server Action** (`src/app/(app)/records/actions.ts`).
3. The action checks the capability (`record:write`), creates a `GeneticEvaluation`
   plus `GeneticTraitValue` rows, writes an `AuditLog` entry, calls
   `recomputePreferredForAnimal()`, then `revalidatePath()` and redirects to the profile.
4. The profile Server Component re-queries and shows the new proof, with the preferred
   one chosen live via `pickPreferred()`.

## Directories

| Path | Role |
|---|---|
| `src/app/login` | Login page + `loginAction` |
| `src/app/(app)` | Authenticated area; `layout.tsx` enforces auth + builds role-filtered nav |
| `src/app/(app)/*/actions.ts` | Server Actions (writes) |
| `src/lib/db.ts` | Prisma client singleton |
| `src/lib/auth.ts` | Password hashing, session cookie, `login`, `currentUser` |
| `src/lib/env.ts` | `APP_ENV` helpers + banner label/colour |
| `src/lib/constants.ts` | Vocabularies (roles, statuses, id types, …) + capability map |
| `src/lib/priority.ts` | Source-priority resolution + `recomputePreferredForAnimal` |
| `src/lib/quality.ts` | Data-quality flags + duplicate detection + animal matching |
| `src/lib/audit.ts` | `audit()` helper |
| `src/components` | UI primitives, sidebar, env banner |

## Environments

`APP_ENV` and `DATABASE_URL` come from `.env.demo` / `.env.production`. `dotenv-cli`
loads the right file per npm script. `src/lib/env.ts` reads `APP_ENV` to render the
banner and the seed guard reads it to refuse demo data in production. See
[DEMO-VS-PRODUCTION.md](DEMO-VS-PRODUCTION.md).

## Swapping SQLite for PostgreSQL

Change `provider = "sqlite"` to `provider = "postgresql"` in `prisma/schema.prisma`,
set `DATABASE_URL` to your Postgres connection string in each env file, then
`npm run db:generate` and `npm run migrate:*`. Model shapes are unchanged. (JSON blobs
are stored as `String` for SQLite portability; that remains valid on Postgres.)
