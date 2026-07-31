import { getSessionUser } from "@/lib/auth";
import { can, LARGE_ANIMAL_IMPORT } from "@/lib/constants";
import { ingestLactanetReg } from "@/lib/lactanet-ingest";
import { createImportReview, type ImportAnimalRef } from "@/lib/import-staging";

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
  let review = false;
  try {
    const body = await request.json();
    review = body?.review === true;
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

  // Large imports ALWAYS go through the review queue, even if the client didn't
  // request it — this is the real gate, so no direct caller can bypass approval.
  const doReview = review || regs.length > LARGE_ANIMAL_IMPORT;

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
      const manifest: ImportAnimalRef[] = [];
      send({ type: "start", total: regs.length, review: doReview });
      for (let i = 0; i < regs.length && !cancelled; i++) {
        let outcome: Awaited<ReturnType<typeof ingestLactanetReg>>;
        try { outcome = await ingestLactanetReg(regs[i], uid, { pending: doReview }); }
        catch (e) { outcome = { reg: regs[i], ok: false, error: String((e as Error)?.message ?? e) }; }
        if (outcome.ok) {
          ok++;
          if (outcome.created) created++;
          if (doReview && outcome.animalId) {
            manifest.push({ reg: outcome.reg, animalId: outcome.animalId, created: !!outcome.created, evaluationId: outcome.evaluationId ?? null, name: outcome.name ?? null });
          }
        } else { fail++; }
        send({ type: "progress", index: i + 1, total: regs.length, outcome });
      }

      // Stage the batch for admin approval (records were written as pending).
      let reviewId: string | null = null;
      let reviewError: string | null = null;
      if (doReview && manifest.length && !cancelled) {
        try {
          reviewId = await createImportReview({
            userId: uid, kind: "animal", captureType: "lactanet_query", sourceName: "LactanetGen",
            manifest: { kind: "animal", mode: "paste", label: `Animal import: ${manifest.length} animal(s) from Lactanet`, count: manifest.length, animals: manifest },
          });
        } catch (e) {
          // Records stay pending even if the queue row fails; surface it so the
          // client doesn't claim "sent to review queue" when there's nothing there.
          reviewError = String((e as Error)?.message ?? e);
          console.error("createImportReview failed for animal_import batch:", e);
        }
      }
      send({ type: "done", total: regs.length, ok, fail, created, review: doReview, reviewId, reviewError });
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
