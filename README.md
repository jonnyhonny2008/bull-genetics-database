# Bull Stud Genetics Intelligence Platform

**Phase 1 — Historical Genetic Proof Database**

A private, role-based web application for a bull stud to manage historical animal
genetics: genetic proofs, milk records, classification records, source tracking,
uploads/review workflow, animal profiles, search, and comparison — with a built-in
**source-priority engine** that decides (and explains) which conflicting value is preferred.

It runs as **two isolated environments on one codebase**:

| | Demo | Production |
|---|---|---|
| Banner | 🟠 **DEMO ENVIRONMENT** | 🔴 **PRODUCTION ENVIRONMENT** |
| Database | `prisma/demo.db` | `prisma/production.db` |
| Data | Realistic seeded fake animals | **Only** reference/config — no fake animals |
| Demo seed | Allowed | **Hard-blocked** |
| Default port | 3000 | 3100 |

> Phase 1 is **genetics-only** by design. CRM, public catalogue, semen inventory,
> invoicing, mating engine, official evaluation calc, and pedigree-index calc are
> intentionally **out of scope** (see [docs/EXTENDING.md](docs/EXTENDING.md) for how each is hooked in later).

---

## Quick start

Prerequisites: **Node.js 18+** (this project was built and verified on Node 20.18).
Node is already installed on this machine at `C:\Users\Jonathan\nodejs` and on your PATH.

```bash
cd bull-stud-platform
npm install            # already done during the build

# --- DEMO ---
npm run setup:demo     # migrate + seed config + seed demo animals -> demo.db
npm run dev:demo       # http://localhost:3000   (orange DEMO banner)

# --- PRODUCTION (clean) ---
npm run setup:prod     # migrate + seed config ONLY (no fake animals) -> production.db
npm run dev:prod       # http://localhost:3100   (red PRODUCTION banner)
```

Open the URL and log in.

### Logins

| Role | Email | Password | Exists in |
|---|---|---|---|
| Admin | `admin@studgenetics.local` | `Admin#12345` | demo **and** production |
| Staff | `staff@studgenetics.local` | `Staff#12345` | demo only |
| Sales | `sales@studgenetics.local` | `Sales#12345` | demo only |
| Genetic Consultant | `consultant@studgenetics.local` | `Consult#12345` | demo only |

> ⚠️ The `@studgenetics.local` accounts above are **demo only**. Production (Supabase) holds
> only the two Blondin admin accounts, whose passwords are set out-of-band via
> `prisma/set-blondin-admins.ts` (`--rotate` to generate strong ones) and are **not** stored
> in the repo. See [docs/GO-LIVE.md](docs/GO-LIVE.md).

---

## What you can do (mapped to acceptance criteria)

- **Dashboard** with the environment label, totals, breed/role breakdowns, recent
  proof/milk/classification updates, pending reviews, recent uploads, missing-ID and
  duplicate alerts.
- **Animals**: robust search & filters (name / registration / NAAB / semen / tattoo,
  breed, sex, role, status, country, birth year, trait ≥, classification ≥, missing
  primary ID, pending review, no proof).
- **Animal profile**: header, all identifiers, all roles, latest **preferred** proof
  (with "why preferred" reason), full proof history, milk history, classification
  history, source history, pedigree section + future-index placeholder, notes.
- **Create/edit animal** with **multiple identifiers** and **multiple roles**.
- **Record entry**: genetic proofs (flexible, breed/species-aware traits), milk
  records, classification records — all **historical** (new dated rows, never overwrite).
- **Upload Center** → stores the file, creates a `SourceCapture`, and opens an
  `ImportReviewQueue` item (simulated extraction JSON).
- **Review Queue**: edit extracted data, match to an animal, then approve / reject /
  mark duplicate / needs-info / conflict — **approving creates the real record and
  links it to source history**.
- **Comparison**: multi-select animals side-by-side on identifiers, preferred-proof
  traits, classification, and production.
- **Admin**: breeds, trait definitions, sources, source priority rules, users/roles,
  environment info, data-quality & duplicate dashboards, audit log.
- **AI Genetics Intelligence Agent**: a floating assistant on every page that answers
  natural-language questions, calls read-only database tools, and cites the exact
  records behind every answer. Off until an admin saves an Anthropic API key in
  **Admin Settings → AI Genetics Assistant**. Full details: [docs/AGENT.md](docs/AGENT.md).

---

## Stack

- **Next.js 14** (App Router, React 18, TypeScript, Server Actions)
- **Prisma 5** ORM on **PostgreSQL** — production runs on Supabase (`.env.production`).
  (The schema began on SQLite; some older docs below still say SQLite.)
- **Tailwind CSS**
- Zero-dependency auth: `scrypt` password hashing + HMAC-signed session cookie
- Full **audit logging** on important writes
- **AI Genetics Assistant** — Anthropic `@anthropic-ai/sdk`, activated by an admin key
  (see [docs/AGENT.md](docs/AGENT.md))

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DATA-MODEL.md](docs/DATA-MODEL.md).

---

## npm scripts

| Script | Purpose |
|---|---|
| `setup:demo` / `setup:prod` | Migrate + seed an environment from scratch |
| `dev:demo` / `dev:prod` | Run the dev server (ports 3000 / 3100) |
| `build` | Production build (type-checked) |
| `start:demo` / `start:prod` | Run the production build per environment |
| `seed:config:demo` / `seed:config:prod` | (Re)seed reference/config data |
| `seed:demo` | (Re)seed demo animals (refuses under production) |
| `reset:demo` | Wipe & rebuild the demo DB (migrate reset + reseed) |
| `migrate:demo` / `migrate:prod` | Apply committed migrations to a DB |

---

## Project layout

```
bull-stud-platform/
├─ prisma/
│  ├─ schema.prisma          # 22-model schema (historical, flexible, source-traceable)
│  ├─ migrations/            # committed SQL migrations
│  ├─ seed-config.ts         # reference/config seed (BOTH environments)
│  ├─ seed-demo.ts           # demo animals (demo only; blocks production)
│  └─ seed-utils.ts
├─ src/
│  ├─ app/                   # App Router pages + server actions
│  │  ├─ login/              # auth
│  │  └─ (app)/              # authenticated area (dashboard, animals, records, …)
│  ├─ components/            # UI primitives, sidebar, env banner
│  └─ lib/                   # db, auth, env, constants, priority, quality, audit, format
├─ docs/                     # architecture, data model, workflows, extension guides
├─ uploads/                  # durable file storage (demo/ and production/)
├─ .env.demo / .env.production
└─ package.json
```

---

## Documentation index

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the app is built
- [DATA-MODEL.md](docs/DATA-MODEL.md) — every table and relationship
- [DEMO-VS-PRODUCTION.md](docs/DEMO-VS-PRODUCTION.md) — environment separation & safety
- [SOURCE-PRIORITY.md](docs/SOURCE-PRIORITY.md) — how "preferred" values are chosen
- [UPLOAD-REVIEW.md](docs/UPLOAD-REVIEW.md) — the upload → capture → review pipeline
- [EXTENDING.md](docs/EXTENDING.md) — add traits/breeds; extend to CRM, pedigree index,
  public catalogue, mating, semen sales, analytics
- [AGENT.md](docs/AGENT.md) — the AI Genetics Intelligence Agent (setup, tools, safety)
- [GO-LIVE.md](docs/GO-LIVE.md) — move from demo approval to real production use
- [BACKUP.md](docs/BACKUP.md) — back up & export data
