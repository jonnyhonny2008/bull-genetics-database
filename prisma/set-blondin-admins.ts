// Production accounts: keep ONLY the two Blondin admins. Removes any other user
// account. Run against the production (Supabase) DATABASE_URL.
//
// Passwords are NOT stored in this file. Supply them at run time so a repository
// checkout never contains working production credentials:
//
//   $env:ADMIN_PW_JHONCOOP = "..."      # PowerShell
//   $env:ADMIN_PW_DBRADY   = "..."
//   npx dotenv -e .env.production -- npx tsx prisma/set-blondin-admins.ts
//
// Omit a variable and that account's password is left exactly as it is — so this
// script is also safe to re-run just to prune extra users.
//
// Passing --rotate with no variables set generates a strong random password for
// each admin and prints it once. Copy it immediately; it is not stored anywhere.

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { hashPassword } from "./seed-utils";

const prisma = new PrismaClient();

const ADMINS = [
  { email: "jhoncoop@blondinsires.com", name: "Jhon Coop", envVar: "ADMIN_PW_JHONCOOP" },
  { email: "dbrady@blondinsires.com", name: "D Brady", envVar: "ADMIN_PW_DBRADY" },
];

const ROTATE = process.argv.includes("--rotate");

/** 20 chars from a 64-char alphabet ≈ 120 bits of entropy. */
function strongPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*";
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
}

async function main() {
  const generated: { email: string; password: string }[] = [];

  for (const a of ADMINS) {
    const supplied = process.env[a.envVar];
    const password = supplied || (ROTATE ? strongPassword() : null);

    if (password) {
      if (password.length < 12) {
        throw new Error(`${a.envVar} is shorter than 12 characters — refusing to set a weak production password.`);
      }
      await prisma.user.upsert({
        where: { email: a.email },
        update: { name: a.name, role: "admin", active: true, passwordHash: hashPassword(password) },
        create: { email: a.email, name: a.name, role: "admin", active: true, passwordHash: hashPassword(password) },
      });
      if (!supplied) generated.push({ email: a.email, password });
      console.log(`[admins] ${supplied ? "set password from " + a.envVar : "generated new password"}: ${a.email}`);
    } else {
      const existing = await prisma.user.findUnique({ where: { email: a.email } });
      if (!existing) {
        throw new Error(
          `${a.email} does not exist and ${a.envVar} is not set. ` +
          `Set ${a.envVar}, or run with --rotate to generate one.`,
        );
      }
      await prisma.user.update({ where: { email: a.email }, data: { name: a.name, role: "admin", active: true } });
      console.log(`[admins] left password unchanged: ${a.email}`);
    }
  }

  const keep = ADMINS.map((a) => a.email);
  const removed = await prisma.user.deleteMany({ where: { email: { notIn: keep } } });
  console.log(`[admins] removed ${removed.count} other user account(s). Only the two Blondin admins remain.`);

  const remaining = await prisma.user.findMany({ select: { email: true, role: true, active: true } });
  console.log("[admins] final users:", remaining);

  if (generated.length) {
    console.log("\n" + "=".repeat(64));
    console.log("NEW PASSWORDS — shown once, not stored anywhere. Copy them now:");
    for (const g of generated) console.log(`  ${g.email}\n    ${g.password}`);
    console.log("=".repeat(64));
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
