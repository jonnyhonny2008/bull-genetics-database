// Apply a .sql file through Prisma, so raw DDL does not depend on psql being
// installed (it is not, on the Windows box this project is run from).
//
// Statements are split on semicolons at end of line and executed one at a time
// via $executeRawUnsafe — NOT wrapped in a transaction, because some of the DDL
// this runs (VACUUM, CREATE INDEX CONCURRENTLY) cannot run inside one.
//
// Usage: npx tsx prisma/apply-sql.ts prisma/sql/<file>.sql
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const file = process.argv[2];
if (!file) { console.error("usage: apply-sql.ts <path-to.sql>"); process.exit(1); }

const prisma = new PrismaClient();

/**
 * Comment text used ONLY to decide whether a fragment carries real SQL. The
 * statement itself is executed verbatim, comments included — Postgres handles
 * those fine, and rewriting the SQL we send risks corrupting it.
 *
 * (An earlier version filtered on the fragment's first characters, which silently
 * dropped every statement that happened to be preceded by a comment block — 2 of
 * the 5 ALTER TABLEs in the tuning file, with no error. Hence executing the
 * original text and testing a stripped copy.)
 */
function withoutComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .trim();
}

/** Split into statements, dropping comment-only and blank fragments. */
function statements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => withoutComments(s).length > 0);
}

async function main() {
  const sql = readFileSync(file, "utf8");
  const stmts = statements(sql);
  console.log(`[apply-sql] ${file}: ${stmts.length} statement(s)`);
  let ok = 0;
  for (const s of stmts) {
    const label = s.replace(/\s+/g, " ").slice(0, 90);
    try {
      await prisma.$executeRawUnsafe(s);
      ok++;
      console.log(`  OK   ${label}`);
    } catch (e) {
      console.error(`  FAIL ${label}\n       ${(e as Error).message.split("\n")[0]}`);
      process.exitCode = 1;
    }
  }
  console.log(`[apply-sql] ${ok}/${stmts.length} applied`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
