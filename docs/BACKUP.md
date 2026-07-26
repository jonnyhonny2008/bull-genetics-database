# Backup & Export

## SQLite (default)

Each environment is a single file, so backup is a file copy. **Stop the server first** (or
ensure no write is in flight) for a consistent copy.

```bash
# Backup
copy prisma\production.db backups\production-2026-07-16.db     # Windows
cp prisma/production.db  backups/production-$(date +%F).db     # bash

# Also back up uploaded source files
xcopy uploads\production backups\uploads-production /E /I      # Windows
cp -r uploads/production backups/uploads-production            # bash
```

Restore = copy the `.db` file back to `prisma/production.db` and restart.

A safe hot backup with the SQLite CLI (if installed):
```bash
sqlite3 prisma/production.db ".backup 'backups/production.db'"
```

## PostgreSQL

```bash
pg_dump "$DATABASE_URL" > backups/production-$(date +%F).sql
# restore:
psql "$DATABASE_URL" < backups/production-2026-07-16.sql
```

## Structured data export (CSV / JSON)

Prisma Studio gives a browsable UI and per-table export:
```bash
npx dotenv -e .env.production -- prisma studio
```

For scripted CSV/JSON exports, add a small script under `prisma/` that reads with the
Prisma client and writes files — e.g. animals with their preferred proof. The audit log
(`AuditLog`) and every history table are queryable this way for reporting.

## What to back up

| Item | Location |
|---|---|
| Production database | `prisma/production.db` (or your Postgres) |
| Uploaded source files | `uploads/production/` |
| Env config | `.env.production` (contains `SESSION_SECRET`) |
| Schema & migrations | `prisma/schema.prisma`, `prisma/migrations/` (in source control) |

## Recommended cadence

- **Before any migration or bulk import**, snapshot the DB file.
- Nightly copy of `prisma/production.db` + `uploads/production/` to off-machine storage.
- Keep `prisma/migrations/` and the codebase in git so the schema is reproducible.
