# Deploying the Bull Stud Genetics Platform — free hosting, step by step

This puts the app online at a URL your team can log into, at **no cost**, using
Vercel's Hobby plan for the app and the Supabase free tier you are already on.

Follow the steps in order. Commands are PowerShell, run from
`C:\Users\Jonathan\WorkflowSR\bull-stud-platform` unless stated otherwise.

> **Node is not on your PATH by default.** Start every terminal session with:
> ```powershell
> $env:Path = "C:\Users\Jonathan\nodejs;" + $env:Path
> ```

---

## What you get, and what it costs

| Piece | Service | Free tier | If you outgrow it |
|---|---|---|---|
| Web app | Vercel Hobby | 100 GB bandwidth/mo, unlimited deploys | Pro, $20/mo |
| Database | Supabase Free | 500 MB, 15 pooled connections | Pro, $25/mo |
| URL | `*.vercel.app` | included | custom domain is free to attach |

Current usage — 935 bulls, 14,815 proof rounds — is roughly **60 MB**, so there
is about 8× headroom on the database before cost is a question.

> **One licensing caveat:** Vercel's Hobby plan is for non-commercial use. A
> private internal tool for a working bull stud is commercial, strictly read. It
> will run fine either way, but if you want to be clean about it, budget for Pro
> ($20/mo) or use a small always-on server instead (see the last section).

---

## Step 1 — Rotate the production passwords

The previous version of `prisma/set-blondin-admins.ts` had passwords written
directly into the file. **Treat them as compromised** — anyone who has seen this
folder, or any copy of it, has them.

Generate fresh strong passwords and print them once:

```powershell
$env:Path = "C:\Users\Jonathan\nodejs;" + $env:Path
npx dotenv -e .env.production -- npx tsx prisma/set-blondin-admins.ts --rotate
```

Output ends with:

```
================================================================
NEW PASSWORDS — shown once, not stored anywhere. Copy them now:
  jhoncoop@blondinsires.com
    kR7$mQ2wPx9nHt4vBz6L
  dbrady@blondinsires.com
    9Fj#pW3xNq8mVc5tRy2K
================================================================
```

**Put both in a password manager immediately.** They are never written to disk.

To choose the passwords yourself instead:

```powershell
$env:ADMIN_PW_JHONCOOP = "your-chosen-password"
$env:ADMIN_PW_DBRADY   = "their-chosen-password"
npx dotenv -e .env.production -- npx tsx prisma/set-blondin-admins.ts
```

The script rejects anything under 12 characters, and it deletes every account
that is not one of those two — production stays at exactly two admins.

---

## Step 2 — Generate a session secret

This signs the login cookie. Production needs its own, separate from local.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Keep the output for Step 6. Anyone holding it can forge a login session, so
treat it exactly like a password.

---

## Step 3 — Get the Supabase transaction-pooler URL

Vercel runs each request in a short-lived function, and every warm function keeps
its own database pool. The **session** pooler (port 5432) you use locally allows
only 15 clients for the entire project and will run out. Serverless needs the
**transaction** pooler on port 6543.

1. Open <https://supabase.com/dashboard> → your project
2. Click **Connect** in the top bar
3. Choose **Transaction pooler**
4. Copy the URI — it looks like
   `postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
5. Replace `[YOUR-PASSWORD]` with your real database password
6. Append `?pgbouncer=true`

Final value for Step 6:

```
postgresql://postgres.abcdefgh:REALPASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```

> `pgbouncer=true` tells Prisma to stop using prepared statements, which the
> transaction pooler cannot support. Without it you get intermittent
> `prepared statement "s0" already exists` errors once traffic overlaps.

---

## Step 4 — Put the code in Git

There is no repository yet, so nothing is version-controlled or backed up.

```powershell
cd C:\Users\Jonathan\WorkflowSR\bull-stud-platform
git init
git add -A
git status
```

**Read the `git status` output before committing.** Confirm you do NOT see:

- `.env.production` or `.env.demo` — real credentials
- anything under `imports/` — 626 proof CSVs, hundreds of MB
- `prisma/demo.db` — a 1.5 GB SQLite file

`.gitignore` covers all three. If any of them appear, stop and fix `.gitignore`
first: a secret committed once stays in the history even after you delete it.

Then commit:

```powershell
git commit -m "Bull Stud Genetics Platform - initial commit"
```

Create an **empty private** repository on GitHub — no README, no .gitignore —
then push:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/bull-stud-platform.git
git branch -M main
git push -u origin main
```

> Keep it **private**. It contains your schema, your business logic, and the
> Lactanet parsing rules.

---

## Step 5 — Import the project into Vercel

1. Go to <https://vercel.com/signup> and sign in with GitHub
2. **Add New → Project**
3. Import `bull-stud-platform`
4. Vercel detects Next.js by itself. Leave Build Command, Output Directory and
   Install Command at their defaults — the `build` script in `package.json`
   already runs `prisma generate && next build`, which is exactly what is needed.
5. **Do not deploy yet.** Expand **Environment Variables** and do Step 6 first.

---

## Step 6 — Set the environment variables

Add each of these with **Production, Preview and Development** all ticked:

| Name | Value |
|---|---|
| `DATABASE_URL` | the port-**6543** transaction-pooler URL from Step 3 |
| `DB_CONNECTION_LIMIT` | `1` |
| `SESSION_SECRET` | the 96-character hex string from Step 2 |
| `APP_ENV` | `production` |
| `UPLOAD_DIR` | `/tmp/uploads` |

`DB_CONNECTION_LIMIT=1` is not a typo. Each Vercel function holds its own pool,
so one connection each is how you stay under Supabase's 15.

Now click **Deploy**. The first build takes 2–4 minutes.

---

## Step 7 — Verify the deployment

Open the `https://<project>.vercel.app` URL and check these in order:

1. **Login page** loads (no environment banner — production is unbranded by design)
2. **Sign in** with an admin email and its Step 1 password
3. **Dashboard** reads `TOTAL ANIMALS 935`, and Sires by role shows
   Proven 56 · Genomic 879 · Active 296 · Inactive 639
4. **Animals** — `/animals?role=proven&sort=lpi&dir=desc` puts
   DREWHOLME LOGIC PP first at LPI 3895
5. **Proof Trends** — `/analysis?view=charts` draws the trend line and the
   bull-vs-lineup bars
6. **A bull profile** — Proof Performance and Rollback Resistance tiles both
   show numbers
7. **Sign out**, then confirm a wrong password is rejected

If a page returns 500, open **Vercel → your project → Logs** and read the real
error. The two likeliest causes are a typo in `DATABASE_URL` and a missing
`?pgbouncer=true`.

---

## Step 8 — Lock down access

There is no public sign-up — accounts exist only if you create them — so the
login page is the only exposed surface. Two optional additions:

- **Deployment Protection** (Project → Settings → Deployment Protection) puts
  Vercel's own auth in front of *preview* deployments. Leave production itself
  public, or your team cannot reach the login page.
- **Custom domain** (Project → Settings → Domains) — attaching one is free and
  gives you `genetics.blondinsires.com` instead of a `vercel.app` URL.

---

## Ongoing: importing a new proof round

**This runs from your PC, not from the website.** The importer reads CSVs off the
local disk and writes straight to Supabase, so the deployed site picks up the new
data immediately — no redeploy needed.

```powershell
$env:Path = "C:\Users\Jonathan\nodejs;" + $env:Path
cd C:\Users\Jonathan\WorkflowSR\bull-stud-platform

# 1. Drop the new Lactanet CSVs into imports\cdn\
# 2. Import
npx dotenv -e .env.production -- npx tsx prisma/import-cdn.ts
```

That single command also re-runs, in order:

1. `classify-sires.ts` — recomputes proven/genomic, active/inactive and the April
   rollback tally for every sire
2. `compute-rollback.ts` — rescores Proof Performance and re-bases Rollback
   Resistance against the updated cohorts

Then check it landed:

```powershell
npx dotenv -e .env.production -- npx tsx prisma/verify-class.ts
npx dotenv -e .env.production -- npx tsx prisma/verify-rollback.ts
```

> Run imports against the **local** `.env.production` (port 5432 session pooler),
> not the Vercel one. Bulk writes want the longer-lived connections.

---

## Ongoing: backups

The Supabase free tier does **not** include automatic backups. Take one before
every import:

```powershell
# Needs PostgreSQL client tools: https://www.postgresql.org/download/windows/
pg_dump "postgresql://USER:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" `
  --no-owner --no-acl -f "backup-$(Get-Date -Format yyyy-MM-dd).sql"
```

Keep the last few copies somewhere other than this machine. A backup on the same
disk as the original is not a backup.

---

## Known limitations of the free setup

**Uploaded files do not persist.** `UPLOAD_DIR=/tmp/uploads` works within a single
request, but Vercel wipes `/tmp` between invocations. On the deployed site:

- the Upload Center accepts a file and writes its `SourceCapture` **database**
  record correctly
- the stored **file itself** disappears shortly afterwards

Everything that matters for genetics — animals, identifiers, proofs, evaluations,
ratings — lives in Postgres and is completely unaffected. Only binary attachments
are lost, and the proof-import workflow does not touch this path at all because
it runs from your PC.

To fix it when you need to: add Supabase Storage (1 GB free) and replace the two
`writeFile` calls, in `src/app/(app)/uploads/actions.ts` and
`src/app/api/proof-upload/route.ts`, with uploads to a Storage bucket.

**Cold starts.** The first request after an idle period takes 2–4 seconds while
the function boots and connects. Everything after that is fast. This is inherent
to free serverless tiers.

> **Do not load-test `npm run dev:prod`.** The Next.js dev server is a single
> process and does not survive many simultaneous server-rendered requests — fire
> eight page loads at once and some return 500 with
> `TypeError: Cannot read properties of null (reading 'useContext')`. That is a
> dev-server limitation, not a bug in this app: the same burst against
> `npm run build && npm run start:prod` returns 200 on every route. Always test
> concurrency against a production build.

**Supabase pauses idle projects** after 7 days of no activity on the free tier.
Logging in once a week prevents it. If it does pause, un-pause it from the
Supabase dashboard — no data is lost.

**The demo environment is currently non-functional**, and is not part of this
deployment. `.env.demo` still holds a SQLite URL (`file:./demo.db`) from before
the move to Postgres, while `prisma/schema.prisma` now declares
`provider = "postgresql"`. Any demo script therefore fails immediately with:

```
Error code: P1012
error: Error validating datasource `db`: the URL must start with the protocol
`postgresql://` or `postgres://`.
```

So `dev:demo`, `setup:demo`, `reset:demo` and `seed:demo` are all dead. Production
is entirely unaffected — it has its own `.env.production` and its own database.
If you want the demo environment back, create a second Supabase project (or a
second schema in the same one), put its connection string in `.env.demo`, and run
`npm run setup:demo`. The 1.5 GB `prisma/demo.db` left over from the SQLite era
can be deleted; nothing reads it.

---

## Alternative: one always-on server

Vercel's serverless model is what forces `DB_CONNECTION_LIMIT=1`, the transaction
pooler and the ephemeral filesystem. A single small VM avoids all three:

```powershell
npm run build
npm run start:prod          # serves on port 3100
```

Put a reverse proxy (Caddy or nginx) in front of port 3100 for HTTPS, keep
`DATABASE_URL` on the **5432** session pooler, set `DB_CONNECTION_LIMIT=5`, and
leave `UPLOAD_DIR` pointing at a real disk so uploads persist. Roughly $5/mo on
Hetzner, DigitalOcean or similar.

---

## Quick reference

| Task | Command |
|---|---|
| Run locally against production data | `npm run dev:prod` → <http://localhost:3100> |
| Typecheck | `npx tsc --noEmit` |
| Production build | `npx dotenv -e .env.production -- npx next build` |
| Import a new proof round | `npx dotenv -e .env.production -- npx tsx prisma/import-cdn.ts` |
| Reclassify sires only | `npx dotenv -e .env.production -- npx tsx prisma/classify-sires.ts` |
| Rescore rollback only | `npx dotenv -e .env.production -- npx tsx prisma/compute-rollback.ts` |
| Verify classification | `npx dotenv -e .env.production -- npx tsx prisma/verify-class.ts` |
| Verify rollback ratings | `npx dotenv -e .env.production -- npx tsx prisma/verify-rollback.ts` |
| Reset admin passwords | `npx dotenv -e .env.production -- npx tsx prisma/set-blondin-admins.ts --rotate` |
| Deploy a change | `git add -A; git commit -m "..."; git push` — Vercel rebuilds automatically |

### Applying a schema change to production

There is no Prisma migration history, and `prisma migrate dev` can reset a
database when it detects drift. Use the reviewed-SQL path instead:

```powershell
# 1. See what would change, without touching anything
npx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --script

# 2. Read it. If it only ADDs, save it as prisma/sql/YYYY-MM-description.sql,
#    written with ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS so it is
#    safe to re-run. If it DROPs or ALTERs a column holding data, back up first.

# 3. Apply
npx dotenv -e .env.production -- npx prisma db execute --file prisma/sql/YOUR-FILE.sql --schema prisma/schema.prisma

# 4. Regenerate the client and redeploy
npx prisma generate
git add -A; git commit -m "schema: ..."; git push
```

`prisma/sql/2026-07-sire-classification.sql` and
`prisma/sql/2026-07-rollback-rating.sql` are worked examples of this pattern.
