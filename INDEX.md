# Package Index — Bull Stud Genetics Intelligence Platform

**Start here.** This zip is the complete, deployable app (Next.js 14 + Prisma + SQLite),
Phase 1 — Historical Genetic Proof Database.

- **`index.html`** — open in a browser for a visual overview + run instructions.
- **`README.md`** — full overview, scripts, logins, structure.

## Deploy in 3 commands
```bash
npm install
npm run setup:prod      # clean production DB (config only, no fake animals)
npm run build && npm run start:prod     # http://localhost:3100
```
To explore with seeded sample data instead: `npm run setup:demo && npm run dev:demo` (http://localhost:3000).
Login: `admin@studgenetics.local` / `Admin#12345` (change before real use — see `docs/GO-LIVE.md`).

## What's inside
| Path | Contents |
|---|---|
| `src/` | App (pages, server actions) + `lib/` (auth, priority, quality, lactanet, holstein) |
| `prisma/` | Schema, migrations, config + demo seeds, trait catalogues |
| `docs/` | Architecture, data model, importers, data sources, go‑live, backup, extending |
| `imports/` | Drop official Lactanet CSVs here (see `imports/README.txt`) |
| `.env.example` / `.env.demo` / `.env.production` | Environment configs |

## Documentation map
- `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`
- `docs/DEMO-VS-PRODUCTION.md`, `docs/SOURCE-PRIORITY.md`, `docs/UPLOAD-REVIEW.md`
- `docs/IMPORTERS.md` — Lactanet bull CSV + Holstein.ca paste importer
- `docs/DATA-SOURCES.md` — official export options (the reg‑number‑only route)
- `docs/GO-LIVE.md`, `docs/BACKUP.md`, `docs/EXTENDING.md`

## Not included (add after deploy)
- `node_modules/` → run `npm install`
- Databases (`*.db`) → created by `npm run setup:*`
- Large Lactanet proof CSVs → copy into `imports/`
