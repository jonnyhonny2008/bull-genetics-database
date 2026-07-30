import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { askGeneticsAgent, AgentNotConfiguredError, type AgentTurn } from "@/lib/agent/agent";
import { isAgentConfigured } from "@/lib/agent/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Bounds so an authenticated user can't run up unbounded token cost.
const MAX_QUESTION = 4000;   // characters
const MAX_TURN = 6000;       // characters per history turn
const RATE_LIMIT = 20;       // requests
const RATE_WINDOW_MS = 60_000;

// Best-effort per-user throttle (in-memory; per instance). Defence in depth —
// the model call itself is the real cost, this just caps a runaway client.
const hits = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(userId, recent);
  return recent.length > RATE_LIMIT;
}

// GET → is the assistant live? (drives the panel's "configure me" state)
export async function GET() {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ configured: await isAgentConfigured() });
}

// POST { question, history } → { answer, toolCalls, records, ... }
export async function POST(request: Request) {
  const user = currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (rateLimited(user.uid)) {
    return NextResponse.json({ error: "rate_limited", message: "Too many questions in a row — give it a moment and try again." }, { status: 429 });
  }

  let body: { question?: string; history?: AgentTurn[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid body" }, { status: 400 }); }

  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "empty question" }, { status: 400 });
  if (question.length > MAX_QUESTION) return NextResponse.json({ error: "too_long", message: "That question is too long — please shorten it." }, { status: 400 });

  // Keep only valid, length-bounded turns from recent history.
  const history: AgentTurn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string")
    .slice(-12)
    .map((h) => ({ role: h.role, content: h.content.slice(0, MAX_TURN) }));

  // Stream the run as newline-delimited JSON: {type:"status"|"delta"} while it
  // works, then one {type:"done", result} (or {type:"error"}). The client renders
  // deltas live and swaps in the fully-parsed answer (charts, sources) on done.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await askGeneticsAgent(question, history, {
          userId: user.uid, userName: user.name,
          onEvent: (e) => send(e),
        });
        send({ type: "done", result });
      } catch (e) {
        if (e instanceof AgentNotConfiguredError) send({ type: "error", code: "not_configured", message: e.message });
        else { console.error("[agent] error", e); send({ type: "error", message: "The assistant hit an error. Check the API key and try again." }); }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
