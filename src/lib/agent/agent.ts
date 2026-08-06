// ---------------------------------------------------------------------------
// Genetics Intelligence Agent — the reasoning loop.
//
// A manual tool-use loop (robust across SDK versions): ask Claude Sonnet 5,
// execute any tools it requests against the real database, feed the records
// back, and repeat until it answers. Every tool call and the rows it examined
// are captured so the UI can show supporting records and every run is logged.
//
// Goes live only when an admin has saved an Anthropic API key in Admin Settings
// (see src/lib/agent/config.ts). Until then askGeneticsAgent throws
// AgentNotConfiguredError, which the API route turns into a clear message.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getAgentConfig, type AgentConfig } from "./config";
import { AGENT_SYSTEM_PROMPT } from "./instructions";
import { AGENT_TOOLS, AGENT_TOOL_MAP, type AgentTool, type AgentActor, type AgentContext } from "./tools";

export class AgentNotConfiguredError extends Error {
  constructor() { super("The Genetics Intelligence Agent is not configured. An administrator must add an Anthropic API key in Admin Settings."); this.name = "AgentNotConfiguredError"; }
}

export interface AgentTurn { role: "user" | "assistant"; content: string }

/** A streaming handle (subset of the SDK's MessageStream) the loop can await. */
export interface AgentStream {
  on(event: "text", cb: (text: string) => void): AgentStream;
  finalMessage(): Promise<Anthropic.Message>;
}

/** Minimal shape of the Anthropic client the loop needs — lets tests inject a fake. */
export interface MessagesClient {
  messages: {
    create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
    stream?: (params: Anthropic.MessageCreateParamsNonStreaming) => AgentStream;
  };
}

/** Progress events emitted while streaming (text deltas + tool status lines). */
export type AgentEvent = { type: "delta" | "status"; text: string };

/** Options + optional test seams. In production the route passes `actor`. */
export interface AgentDeps {
  userId?: string;
  userName?: string;
  /**
   * The signed-in user the agent acts as. Write tools gate on this — the agent
   * can do only what this person's role allows. When absent (or role is blank),
   * every write tool refuses. Read tools work regardless.
   */
  actor?: AgentActor;
  /** Test seam: skip the database config lookup and use this config. */
  config?: AgentConfig;
  /** Test seam: build a fake Anthropic client. Defaults to the real SDK client. */
  createClient?: (apiKey: string) => MessagesClient;
  /** Test seam: override the tool set. Defaults to the real database tools. */
  tools?: AgentTool[];
  /** Write a run to the audit log (default true; tests pass false). */
  log?: boolean;
  /** When set, the loop streams: text deltas + tool-status lines are pushed here. */
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentResult {
  answer: string;
  toolCalls: { name: string; input: unknown; summary: string }[];
  records: { tool: string; records: unknown }[];
  iterations: number;
  refused: boolean;
  model: string;
}

const MAX_ITERATIONS = 8; // hard stop so a loop can never run forever

/** Ask the analyst a question. `history` carries prior turns for follow-ups. */
export async function askGeneticsAgent(
  question: string,
  history: AgentTurn[] = [],
  opts: AgentDeps = {},
): Promise<AgentResult> {
  const cfg = opts.config ?? await getAgentConfig();
  if (!cfg.configured || !cfg.apiKey) throw new AgentNotConfiguredError();

  const client = (opts.createClient ?? ((apiKey: string) => new Anthropic({ apiKey })))(cfg.apiKey);
  const activeTools = opts.tools ?? AGENT_TOOLS;
  const toolMap = opts.tools ? new Map(opts.tools.map((t) => [t.name, t])) : AGENT_TOOL_MAP;
  const tools = activeTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));

  const messages: Anthropic.MessageParam[] = [
    // Recent memory: the last ~20 turns of this user's 30-day history.
    ...history.slice(-20).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: question },
  ];

  // The acting user, threaded into every tool call. Prefer the explicit actor;
  // fall back to userId/userName with a blank role (which denies every write).
  const ctx: AgentContext = {
    actor: opts.actor ?? (opts.userId ? { uid: opts.userId, name: opts.userName ?? "", role: "" } : null),
  };

  const toolCalls: AgentResult["toolCalls"] = [];
  const records: AgentResult["records"] = [];
  let answer = "";
  let refused = false;
  let iterations = 0;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      // Sonnet 5 rejects non-default temperature, so it is never sent.
      thinking: { type: "disabled" },
      system: AGENT_SYSTEM_PROMPT,
      messages,
      tools,
    };
    // Stream token-by-token when a listener is attached and the client supports
    // it; otherwise fall back to a single blocking call (used by tests).
    let response: Anthropic.Message;
    if (opts.onEvent && typeof client.messages.stream === "function") {
      const s = client.messages.stream(params);
      s.on("text", (t) => opts.onEvent!({ type: "delta", text: t }));
      response = await s.finalMessage();
    } else {
      response = await client.messages.create(params);
    }

    if (response.stop_reason === "refusal") { refused = true; answer = "I can't help with that request."; break; }

    // Preserve the assistant turn verbatim (needed for the tool loop).
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) answer = text;

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    if (toolUses.length) opts.onEvent?.({ type: "status", text: `Working — ${toolUses.map((t) => t.name.replace(/_/g, " ")).join(", ")}…` });

    // Execute every requested tool and return all results in one user message.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const tool = toolMap.get(call.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true });
        continue;
      }
      try {
        const out = await tool.run((call.input ?? {}) as Record<string, unknown>, ctx);
        toolCalls.push({ name: call.name, input: call.input, summary: out.summary });
        records.push({ tool: call.name, records: out.records });
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ summary: out.summary, records: out.records }).slice(0, 60000) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Tool error: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  // Best-effort run log — request, tools called, rows examined, response.
  const rowsExamined = records.reduce((n, r) => n + (Array.isArray(r.records) ? r.records.length : r.records ? 1 : 0), 0);
  if (opts.log ?? true) try {
    await prisma.auditLog.create({
      data: {
        entityType: "agent", action: "query", userId: opts.actor?.uid ?? opts.userId, userName: opts.actor?.name ?? opts.userName,
        notes: JSON.stringify({ question: question.slice(0, 500), tools: toolCalls.map((t) => t.name), rowsExamined, iterations, refused, answerPreview: answer.slice(0, 300) }).slice(0, 4000),
      },
    });
  } catch { /* logging must never break a response */ }

  return { answer: answer || "I couldn't produce an answer for that.", toolCalls, records, iterations, refused, model: cfg.model };
}

/** Names of the tools the agent can use — for docs / UI. */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);
