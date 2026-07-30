// ---------------------------------------------------------------------------
// Genetics Intelligence Agent — configuration.
//
// The agent goes LIVE the moment an admin saves an Anthropic API key in
// Admin Settings (stored in EnvironmentConfig, key `agent.anthropicApiKey`).
// Until then every entry point reports "not configured" rather than failing.
//
// Model / token limits are configurable via env; the key lives in the database
// so a non-technical admin can turn the assistant on without a redeploy.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/db";

export const AGENT_KEY_CONFIG = "agent.anthropicApiKey";
export const AGENT_MODEL_CONFIG = "agent.model";

export interface AgentConfig {
  apiKey: string | null;
  model: string;
  maxTokens: number;
  /** Kept for future models; NOT sent to claude-sonnet-5, which rejects non-default sampling. */
  temperature: number | null;
  configured: boolean;
  source: "settings" | "env" | null;
}

/** Read the live agent configuration. Key comes from settings, then env. */
export async function getAgentConfig(): Promise<AgentConfig> {
  const rows = await prisma.environmentConfig.findMany({
    where: { key: { in: [AGENT_KEY_CONFIG, AGENT_MODEL_CONFIG] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const settingsKey = (map.get(AGENT_KEY_CONFIG) ?? "").trim();
  const envKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  const apiKey = settingsKey || envKey || null;

  return {
    apiKey,
    // The user's spec pins the agent to Claude Sonnet 5; overridable via env.
    model: map.get(AGENT_MODEL_CONFIG) || process.env.GENETICS_AGENT_MODEL || "claude-sonnet-5",
    maxTokens: Number(process.env.GENETICS_AGENT_MAX_TOKENS ?? 4096) || 4096,
    temperature: process.env.GENETICS_AGENT_TEMPERATURE ? Number(process.env.GENETICS_AGENT_TEMPERATURE) : null,
    configured: !!apiKey,
    source: settingsKey ? "settings" : envKey ? "env" : null,
  };
}

/** Cheap check for UI gating — does an admin still need to paste a key? */
export async function isAgentConfigured(): Promise<boolean> {
  if ((process.env.ANTHROPIC_API_KEY ?? "").trim()) return true;
  const row = await prisma.environmentConfig.findUnique({ where: { key: AGENT_KEY_CONFIG } });
  return !!(row?.value ?? "").trim();
}

/** Masked hint for the settings UI — never returns the full key. */
export function maskKey(key: string | null | undefined): string {
  const k = (key ?? "").trim();
  if (!k) return "not set";
  if (k.length <= 10) return "set";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
