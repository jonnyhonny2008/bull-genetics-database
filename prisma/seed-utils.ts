// Standalone helpers usable from seed scripts (no Next.js / server-only imports).
import crypto from "crypto";

// Must match the scheme in src/lib/auth.ts so verifyPassword() accepts it.
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function iso(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00.000Z");
}
