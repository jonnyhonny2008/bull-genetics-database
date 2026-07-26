import { PrismaClient } from "@prisma/client";

/**
 * Cap the Prisma connection pool for Postgres.
 *
 * Supabase's Session pooler (port 5432) caps a project at `pool_size: 15`.
 * Prisma's default pool is `num_cpus * 2 + 1`, which on an 8-core box is 17 —
 * over the limit before a second app instance even starts. The failure is not
 * graceful; a burst of concurrent page loads returns
 *
 *   FATAL: (EMAXCONNSESSION) max clients reached in session mode
 *
 * and the page 500s. With an explicit `connection_limit`, Prisma queues the
 * excess queries instead of opening connections it cannot have.
 *
 * Override per environment with DB_CONNECTION_LIMIT. On a serverless host
 * (Vercel), use Supabase's Transaction pooler (port 6543) and set
 * DB_CONNECTION_LIMIT=1, since every warm lambda holds its own pool.
 */
function withPoolLimits(url: string | undefined): string | undefined {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return url; // SQLite/demo: leave alone
  try {
    const u = new URL(url);
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", process.env.DB_CONNECTION_LIMIT ?? "5");
    }
    // Wait for a free connection rather than failing instantly under burst.
    if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "20");
    return u.toString();
  } catch {
    return url; // unparseable URL — let Prisma report it
  }
}

// Prisma client singleton (avoids exhausting connections during dev HMR).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: withPoolLimits(process.env.DATABASE_URL) } },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
