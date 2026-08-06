import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseHeader, parseRow, safeProofFileName } from "@/lib/lactanet";
import { persistBull } from "@/lib/proof-import";
import { logAppError } from "@/lib/error-log";

export const runtime = "nodejs";
export const maxDuration = 120;

// Browser-chunked mass proof import — the Vercel-native replacement for the
// local `npm run import:all` spawn. The client reads the Lactanet CSV locally and
// streams it here one header + a batch of data rows at a time; each row is parsed
// and persisted as an APPROVED evaluation (mass import is an admin-only power, so
// the acting admin IS the approver). Small per-request work stays well under the
// serverless timeout, and nothing depends on a persistent server-side imports dir.
export async function POST(request: Request) {
  const user = getSessionUser();
  if (!can(user?.role, "record:approve")) {
    return NextResponse.json({ error: "Only an admin can run the mass import." }, { status: 403 });
  }

  let body: { header?: string; rows?: unknown; fileName?: string; captureId?: string } = {};
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Send JSON." }, { status: 400 }); }

  const header = String(body.header ?? "").trim();
  const rows = Array.isArray(body.rows) ? (body.rows as unknown[]).map((r) => String(r)) : [];
  const fileName = safeProofFileName(String(body.fileName ?? "")) ?? "mass-import.csv";
  if (!header || !rows.length) return NextResponse.json({ error: "Provide a header line and at least one data row." }, { status: 400 });
  if (rows.length > 1000) return NextResponse.json({ error: "Chunk too large (max 1000 rows)." }, { status: 400 });

  const idx = parseHeader(header);
  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });

  // One capture per import run — created on the first chunk and echoed back so the
  // client threads it through subsequent chunks (keeps provenance to one row).
  let captureId = typeof body.captureId === "string" && body.captureId ? body.captureId : null;
  if (!captureId) {
    const cap = await prisma.sourceCapture.create({
      data: { sourceId: source?.sourceId, captureType: "csv", originalFileName: fileName, capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 1, notes: `Mass proof import (browser): ${fileName}` },
      select: { captureId: true },
    });
    captureId = cap.captureId;
  }

  let imported = 0, created = 0, failed = 0;
  // Capture WHY rows failed instead of swallowing them into a bare counter. A
  // file with a shifted header or a changed layout fails every row, and returning
  // a silent `imported: 0` used to read as success — the exact "wrong-shaped file
  // accepted as a good run" failure a data-correctness tool must not have.
  const failures: string[] = [];
  const noteFailure = (line: string, reason: string) => {
    failed++;
    if (failures.length < 20) failures.push(`${(line.split(",")[0] ?? "").trim() || "(row)"}: ${reason}`);
  };
  for (const line of rows) {
    if (!line.trim()) continue;
    try {
      const bull = parseRow(line.split(","), idx);
      if (!bull) { noteFailure(line, "could not parse row (unexpected layout or missing key columns)"); continue; }
      const res = await persistBull(bull, { sourceId: source?.sourceId ?? null, captureId, userId: user?.uid, fileName, approvalStatus: "approved" });
      imported++;
      if (res.created) created++;
    } catch (e) { noteFailure(line, (e as Error)?.message ?? "unknown error"); }
  }

  // A chunk where NOTHING imported but rows failed is almost always a layout
  // problem, not many individually-bad bulls — surface it loudly.
  const fatal = imported === 0 && failed > 0;
  if (failed > 0) {
    await logAppError("proof-import/chunk", `${failed} of ${rows.length} rows failed to import from ${fileName}`, {
      userId: user?.uid,
      fileName,
      failedCount: failed,
      importedCount: imported,
      samples: failures.slice(0, 10),
    });
  }
  return NextResponse.json({ ok: true, captureId, imported, created, failed, failures, fatal });
}
