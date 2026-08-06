import "server-only";
import { prisma } from "@/lib/db";
import type { AgentTurn } from "@/lib/agent/agent";

// ---------------------------------------------------------------------------
// Persistent per-user memory for Dann.ai.
//
// Each user's conversation is stored as a JSON array in the EnvironmentConfig
// row `chat.history.<userId>` (the same key/value table the API key and report
// schedules use) — so there's NO database migration. It holds a rolling 30-DAY
// window: on every write, turns older than 30 days are dropped, and a daily cron
// (purge-denied) deletes whole rows untouched for 30 days. So a user's chat
// self-deletes after 30 days, and Dann.ai only ever sees the last 30 days.
// ---------------------------------------------------------------------------

const PREFIX = "chat.history.";
export const CHAT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_MESSAGES = 200; // hard cap per user so one blob can't grow unbounded
const MAX_CONTENT = 8000; // clamp any single message

interface StoredTurn { role: "user" | "assistant"; content: string; at: string }

const keyFor = (userId: string) => PREFIX + userId;

async function readRaw(userId: string): Promise<StoredTurn[]> {
  const row = await prisma.environmentConfig.findUnique({ where: { key: keyFor(userId) } });
  if (!row?.value) return [];
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? (arr as StoredTurn[]).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string") : [];
  } catch {
    return [];
  }
}

/** Turns from within the window (undated turns are kept defensively). */
function withinWindow(t: StoredTurn, cutoffMs: number): boolean {
  const ms = Date.parse(t.at);
  return isNaN(ms) ? true : ms >= cutoffMs;
}

/** The user's conversation from the last 30 days, oldest→newest, as agent turns. */
export async function loadChatHistory(userId: string, nowMs: number): Promise<AgentTurn[]> {
  if (!userId) return [];
  const cutoff = nowMs - CHAT_WINDOW_DAYS * DAY_MS;
  return (await readRaw(userId))
    .filter((t) => withinWindow(t, cutoff))
    .map((t) => ({ role: t.role, content: t.content }));
}

/** Append the latest exchange, trim to the 30-day window + message cap, persist. */
export async function appendChatTurns(userId: string, turns: AgentTurn[], nowIso: string): Promise<void> {
  if (!userId || !turns.length) return;
  const nowMs = Date.parse(nowIso);
  const cutoff = nowMs - CHAT_WINDOW_DAYS * DAY_MS;
  const existing = (await readRaw(userId)).filter((t) => withinWindow(t, cutoff));
  const added: StoredTurn[] = turns
    .filter((t) => t && t.content && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CONTENT), at: nowIso }));
  const next = [...existing, ...added].slice(-MAX_MESSAGES);
  await prisma.environmentConfig.upsert({
    where: { key: keyFor(userId) },
    update: { value: JSON.stringify(next) },
    create: { key: keyFor(userId), value: JSON.stringify(next), notes: "Dann.ai chat history — 30-day rolling window, auto-purged" },
  });
}

/** Daily cleanup: delete whole chat rows untouched for more than 30 days. */
export async function purgeOldChat(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - CHAT_WINDOW_DAYS * DAY_MS);
  const res = await prisma.environmentConfig.deleteMany({ where: { key: { startsWith: PREFIX }, updatedAt: { lt: cutoff } } });
  return res.count;
}
