import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { ingestLactanetReg } from "@/lib/lactanet-ingest";

export const runtime = "nodejs";
export const maxDuration = 300; // split very large lists into batches

// Bulk import from a pasted list / CSV of registration numbers. Each animal is
// fetched and imported sequentially, STREAMING one NDJSON line per animal so the
// UI shows live progress. Body: { regs: string[] } or { text: "..." }.
//
// Sequential on purpose: one animal at a time, and lactanet-web spaces the tab
// requests. This is the polite shape, not an accident.
export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "record:write")) {
    return new Response(JSON.stringify({ error: "Not authorized." }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  }

  let regs: string[] = [];
  try {
    const body = await request.json();
    const raw: string = Array.isArray(body?.regs) ? body.regs.join("\n") : String(body?.regs ?? body?.text ?? "");
    // Full registrations only — breed(2) + country(3) + sex(1) + digits.
    const found: string[] = raw.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{3}[MF]\d{4,}\b/g) ?? [];
    regs = [...new Set(found.map((s) => s.trim()))];
  } catch {
    return new Response(JSON.stringify({ error: "Send JSON { regs: [...] }." }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  if (!regs.length) {
    return new Response(
      JSON.stringify({ error: "No registration numbers found. Expected e.g. HOCANM13486161." }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const uid = user?.uid;
  const stream = new ReadableStream({
    async start(controller) {
      // enqueue() throws once the consumer cancels; latch it so a disconnected
      // client stops the run instead of it grinding on unwatched.
      let cancelled = false;
      const send = (obj: unknown) => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); }
        catch { cancelled = true; }
      };

      let ok = 0, fail = 0, created = 0;
      send({ type: "start", total: regs.length });
      for (let i = 0; i < regs.length && !cancelled; i++) {
        let outcome: Awaited<ReturnType<typeof ingestLactanetReg>>;
        try { outcome = await ingestLactanetReg(regs[i], uid); }
        catch (e) { outcome = { reg: regs[i], ok: false, error: String((e as Error)?.message ?? e) }; }
        if (outcome.ok) { ok++; if (outcome.created) created++; } else { fail++; }
        send({ type: "progress", index: i + 1, total: regs.length, outcome });
      }
      send({ type: "done", total: regs.length, ok, fail, created });
      try { controller.close(); } catch { /* already cancelled */ }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
