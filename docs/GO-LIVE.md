# Go Live — From Demo Approval to Real Production Use

Once the demo is approved, the same app is ready for real records. The demo and
production databases are already separate, so nothing from the demo carries over.

## 1. Initialise the production database (once)

```bash
cd bull-stud-platform
npm run setup:prod
```

This applies migrations and seeds **only** reference/configuration data (breeds, traits,
sources, priority rules, roles, vocabularies) plus the default admin login. It creates
**no** fake animals.

## 2. Secure the production login

The default admin (`admin@studgenetics.local` / `Admin#12345`) exists so you can log in.
**Before real use:**

1. Set a strong `SESSION_SECRET` in `.env.production`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
   Paste the output as `SESSION_SECRET=...`.
2. Start production, log in as admin, go to **Admin → Users & Roles**, and either:
   - edit the admin user and set a new password, and/or
   - create your own admin account and deactivate the default one.
3. Create real Staff / Sales / Consultant users as needed (demo users do **not** exist in
   production).

## 3. Run production

```bash
npm run build          # once, for the optimized server
npm run start:prod     # http://localhost:3100  (red PRODUCTION banner)
```

For day-to-day local use you can also run `npm run dev:prod`.

## 4. Start entering real data

- **Animals** → New animal (add identifiers + roles)
- Add **genetic proofs**, **milk records**, **classification records**
- Use the **Upload Center** for official reports / catalogues / screenshots, then
  approve them in the **Review Queue**
- Confirm **preferred values** resolve as expected under your source priority rules

The red banner and Admin → Settings confirm you are in production. The demo seed is
permanently blocked here.

## 5. (Recommended) Move to PostgreSQL + a host

SQLite is perfect for a single-box internal tool. For a hosted, multi-user deployment
(e.g. Manus, a VM, or a container):

1. In `prisma/schema.prisma` set `provider = "postgresql"`.
2. In `.env.production` set `DATABASE_URL` to your Postgres URL and a strong
   `SESSION_SECRET`.
3. `npm run db:generate && npm run migrate:prod`.
4. Ensure `UPLOAD_DIR` points at durable storage (a mounted volume or object-storage
   path); the app writes uploaded files there.
5. Serve behind HTTPS (session cookies are set `secure` in production).

Model shapes are unchanged between SQLite and Postgres.

## Deployment notes

- The app is a standard Next.js 14 project — deployable to any Node host or platform that
  runs `npm run build` + `npm run start` (Vercel, a container, or Manus).
- Set `APP_ENV`, `DATABASE_URL`, `SESSION_SECRET`, and `UPLOAD_DIR` as environment
  variables on the host (the `.env.*` files are for local use and are git-ignored).
- Run `prisma migrate deploy` on release to apply committed migrations.
