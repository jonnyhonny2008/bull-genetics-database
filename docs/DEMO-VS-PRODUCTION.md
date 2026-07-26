# Demo vs Production — Environment Separation

The demo and production environments share **one codebase and one schema** but use
**separate databases**, so fake demo data can never mix with real production data.

## What differs

| | Demo | Production |
|---|---|---|
| Env file | `.env.demo` | `.env.production` |
| `APP_ENV` | `demo` | `production` |
| Database | `prisma/demo.db` | `prisma/production.db` |
| Upload dir | `uploads/demo` | `uploads/production` |
| Banner | 🟠 amber "DEMO ENVIRONMENT" | 🔴 red "PRODUCTION ENVIRONMENT" |
| Reference/config seed | ✅ breeds, traits, sources, priority rules, roles, vocab | ✅ same |
| Demo animal seed | ✅ 11 fake animals + proofs/milk/classification/reviews | ⛔ **blocked** |
| Default port | 3000 | 3100 |

Both environments contain identical **reference/configuration** data (breeds, trait
definitions, sources, source priority rules, roles, status & animal-role vocabularies,
the environment marker, and a default admin login). Only the demo environment contains
fake animals.

## Three layers of protection against demo→production contamination

1. **Separate database files.** `DATABASE_URL` in each env file points at a different
   `.db` file. Demo writes can only ever touch `demo.db`.
2. **A hard seed guard.** `prisma/seed-demo.ts` checks `APP_ENV` at the top and
   **aborts with a non-zero exit** if it is `production`:
   ```
   [seed-demo] REFUSING to seed demo animals into PRODUCTION. Aborting.
   ```
   (Verified — the demo seed cannot run against production.)
3. **A visible banner.** Every page shows the environment. Production is red and states
   "live data. Demo seed is blocked here." Admin → Settings repeats the warning.

## How the environment is selected

`dotenv-cli` loads the correct `.env` file per npm script:

```jsonc
"dev:demo":  "dotenv -e .env.demo -- next dev -p 3000",
"dev:prod":  "dotenv -e .env.production -- next dev -p 3100",
"seed:demo": "dotenv -e .env.demo -- tsx prisma/seed-demo.ts",
```

At runtime, `src/lib/env.ts` reads `APP_ENV` to render the banner; the seed scripts read
it to enforce the guard.

## Resetting / reseeding the demo

```bash
npm run reset:demo     # migrate reset (wipes demo.db) + reseed config + demo animals
```

`reset:demo` only ever targets `demo.db`. There is **no** reset script for production —
production is meant to be protected. To (re)initialise a fresh production database you
run `npm run setup:prod`, which only applies migrations and seeds reference/config data.

## Running both at once

They use different ports and different DB files, so you can run demo (3000) and
production (3100) side by side for a walkthrough.
