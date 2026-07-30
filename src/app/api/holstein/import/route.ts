import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { ingestHolsteinReg } from "@/lib/holstein-ingest";
import { HOLSTEIN_REMOTE, closeHolsteinBrowser } from "@/lib/holstein-browser";

export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Pro cap; large lists should be split into batches

// Bulk CSV/list import: scrape + import each animal sequentially, STREAMING one
// NDJSON line per animal so the UI shows live progress (scraping many is slow —
// ~10s/animal through the real browser). Body: { regs: string[] }.
export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "record:write")) {
    return new Response(JSON.stringify({ error: "Not authorized." }), { status: 403, headers: { "content-type": "application/json" } });
  }

  let regs: string[] = [];
  try {
    const body = await request.json();
    const raw: string = Array.isArray(body?.regs) ? body.regs.join("\n") : String(body?.regs ?? body?.text ?? "");
    const found: string[] = raw.toUpperCase().match(/HOCAN[FM]?\d{4,}|HO\d{6,}/g) ?? [];
    regs = [...new Set(found.map((s) => s.trim()))];
  } catch {
    return new Response(JSON.stringify({ error: "Send JSON { regs: [...] }." }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!regs.length) {
    return new Response(JSON.stringify({ error: "No valid registration numbers found." }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const encoder = new TextEncoder();
  const uid = user?.uid;
  const stream = new ReadableStream({
    async start(controller) {
      // enqueue() throws once the consumer cancels the stream. Latch that instead
      // of letting it escape, so the `finally` below always releases the browser
      // and a disconnect stops the scrape rather than grinding on unwatched.
      let cancelled = false;
      const send = (obj: unknown) => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); }
        catch { cancelled = true; }
      };
      let ok = 0, fail = 0, created = 0;
      try {
        send({ type: "start", total: regs.length });
        for (let i = 0; i < regs.length && !cancelled; i++) {
          // ingestHolsteinReg swallows scrape/import failures, but resolveIngestDeps
          // and prisma.sourceCapture.create (holstein-ingest.ts:58-66) are outside
          // its try — a DB error throws straight out. Turn that into a failed row
          // rather than killing the whole stream.
          let outcome: Awaited<ReturnType<typeof ingestHolsteinReg>>;
          try { outcome = await ingestHolsteinReg(regs[i], uid); }
          catch (e) { outcome = { reg: regs[i], ok: false, error: String((e as Error)?.message ?? e) }; }
          if (outcome.ok) { ok++; if (outcome.created) created++; } else { fail++; }
          send({ type: "progress", index: i + 1, total: regs.length, outcome });
        }
        send({ type: "done", total: regs.length, ok, fail, created });
        try { controller.close(); } catch { /* already cancelled */ }
      } finally {
        // ALWAYS release the metered remote session, even on client disconnect.
        if (HOLSTEIN_REMOTE) await closeHolsteinBrowser();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
