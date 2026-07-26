import "server-only";
import { cookies } from "next/headers";
import crypto from "crypto";
import { prisma } from "./db";

// ---------------------------------------------------------------------------
// Password hashing (scrypt — built into Node, no native dependency)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, derived] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !derived) return false;
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(check, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Signed session cookie (HMAC — tamper proof, no DB hit per render)
// ---------------------------------------------------------------------------

// Environment-specific cookie name so demo (3000) and production (3100) can be used
// in the same browser at once — cookies are not port-specific, so a shared name would
// let one environment's login clobber the other's.
const COOKIE = `bsg_session_${process.env.APP_ENV === "production" ? "prod" : "demo"}`;

// The HMAC key that signs every session cookie. In production this MUST be a
// strong secret — if it is missing (or left at the dev placeholder), anyone who
// knows the placeholder could forge an admin cookie, so we fail closed instead
// of silently signing with a public key.
const DEV_SECRET = "insecure-dev-secret-local-only";
function secret(): string {
  const s = process.env.SESSION_SECRET;
  const weak = !s || s.length < 16 || s === "insecure-dev-secret" || s === DEV_SECRET;
  if (weak) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SESSION_SECRET is missing or too weak. Set SESSION_SECRET to a random value of at least 16 characters (e.g. `openssl rand -base64 48`) before running in production.",
      );
    }
    return DEV_SECRET; // local dev only
  }
  return s;
}

export interface SessionUser {
  uid: string;
  email: string;
  name: string;
  role: string;
}

interface SessionToken extends SessionUser {
  iat: number; // issued-at (unix seconds)
  exp: number; // expiry (unix seconds) — verified server-side, not just via cookie maxAge
}

const SESSION_TTL_SEC = 60 * 60 * 12; // 12 hours

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(user: SessionUser): string {
  const now = Math.floor(Date.now() / 1000);
  const token: SessionToken = { ...user, iat: now, exp: now + SESSION_TTL_SEC };
  const body = Buffer.from(JSON.stringify(token)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionToken>;
    // Reject expired tokens server-side (a stolen cookie can't outlive its exp).
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (!parsed.uid || !parsed.email || !parsed.role) return null;
    return { uid: parsed.uid, email: parsed.email, name: parsed.name ?? "", role: parsed.role };
  } catch {
    return null;
  }
}

// Must be called inside a Server Action or Route Handler (cookies are writable there).
export function createSession(user: SessionUser) {
  cookies().set(COOKIE, encode(user), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 12, // 12 hours
  });
}

export function destroySession() {
  cookies().delete(COOKIE);
}

export function getSessionUser(): SessionUser | null {
  return decode(cookies().get(COOKIE)?.value);
}

// ---------------------------------------------------------------------------
// Login + guards
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Best-effort brute-force throttle (in-memory). scrypt already makes each guess
// expensive; this caps sustained guessing per email. On serverless each instance
// has its own map, so treat it as defence-in-depth, not a hard guarantee.
// ---------------------------------------------------------------------------
const MAX_FAILS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 1000;
const failLog = new Map<string, { count: number; first: number; lockedUntil: number }>();

function throttleAllows(key: string): boolean {
  const now = Date.now();
  const rec = failLog.get(key);
  if (!rec) return true;
  if (rec.lockedUntil > now) return false;
  if (now - rec.first > WINDOW_MS) { failLog.delete(key); return true; }
  return rec.count < MAX_FAILS;
}
function noteFailure(key: string) {
  const now = Date.now();
  const rec = failLog.get(key);
  if (!rec || now - rec.first > WINDOW_MS) { failLog.set(key, { count: 1, first: now, lockedUntil: 0 }); return; }
  rec.count++;
  if (rec.count >= MAX_FAILS) rec.lockedUntil = now + LOCK_MS;
}

export type LoginResult = SessionUser | "invalid" | "throttled";

export async function login(email: string, password: string): Promise<LoginResult> {
  const key = email.trim().toLowerCase();
  if (!throttleAllows(key)) return "throttled";
  const user = await prisma.user.findUnique({ where: { email: key } });
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    noteFailure(key);
    return "invalid";
  }
  failLog.delete(key);
  const session: SessionUser = { uid: user.id, email: user.email, name: user.name, role: user.role };
  createSession(session);
  await prisma.auditLog.create({
    data: { entityType: "auth", action: "login", userId: user.id, userName: user.name },
  });
  return session;
}

export class AuthError extends Error {}

// For use in server components: returns null if not logged in (caller redirects).
export function currentUser(): SessionUser | null {
  return getSessionUser();
}
