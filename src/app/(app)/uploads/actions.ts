"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, isBatchImportType } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { matchExistingAnimals } from "@/lib/quality";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { revalidatePath } from "next/cache";

// Upload a source file (or record a browser-assisted/manual capture), store it,
// create a SourceCapture, and open an ImportReviewQueue item.
export async function uploadCapture(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "upload:write")) throw new Error("Not authorized");

  const sourceId = String(fd.get("sourceId") ?? "") || null;
  const captureType = String(fd.get("captureType") ?? "pdf");
  const notes = String(fd.get("notes") ?? "").trim() || null;
  const sourceUrl = String(fd.get("sourceUrl") ?? "").trim() || null;
  const linkedAnimalId = String(fd.get("animalId") ?? "") || null;
  const proposedRecordType = String(fd.get("proposedRecordType") ?? "genetic_evaluation");
  // Batch-import rows are created ONLY by the Proof Import / Animal Import tools
  // (which write a trusted manifest). Forbid forging one here: a crafted manifest
  // could otherwise drive an admin's "Deny" into cascade-deleting arbitrary animals.
  if (isBatchImportType(proposedRecordType)) throw new Error("Import batches are created by the Proof Import / Animal Import tools, not from an upload.");
  const extractedRaw = String(fd.get("extractedDataJson") ?? "").trim();

  // Persist the uploaded file (if any) to durable storage.
  let storedFileUrl: string | null = null;
  let originalFileName: string | null = null;
  let sizeBytes: number | null = null;
  let contentType: string | null = null;

  const file = fd.get("file");
  if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
    const f = file as File;
    const dir = process.env.UPLOAD_DIR || "./uploads";
    await mkdir(dir, { recursive: true });
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stored = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safe}`;
    const full = path.join(dir, stored);
    await writeFile(full, Buffer.from(await f.arrayBuffer()));
    storedFileUrl = full.replace(/\\/g, "/");
    originalFileName = f.name;
    sizeBytes = f.size;
    contentType = f.type || null;
  }

  // Validate / default the extracted JSON.
  let extractedDataJson = extractedRaw;
  if (extractedRaw) {
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(extractedRaw); } catch { throw new Error("Extracted data must be valid JSON (or leave it blank)."); }
    // Defence in depth: reject anything shaped like an import-batch manifest. Batch
    // review rows are created only by the import tools (which build a trusted
    // manifest); a forged manifest here could trick an admin's "Deny" into
    // cascade-deleting the animals it names.
    const j = parsedJson as { kind?: unknown; animals?: unknown };
    if (j && (j.kind === "proof" || j.kind === "animal") && Array.isArray(j.animals)) {
      throw new Error("This looks like an import-batch manifest — imports are created by the Proof Import / Animal Import tools, not from an upload.");
    }
  } else {
    extractedDataJson = JSON.stringify({ note: "Placeholder — no extraction yet. Map fields manually in review." });
  }

  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId, animalId: linkedAnimalId, captureType, originalFileName, storedFileUrl, sourceUrl,
      capturedById: user?.uid, extractionStatus: extractedRaw ? "simulated" : "not_extracted",
      confidenceScore: extractedRaw ? 0.6 : null, rawExtractedDataJson: extractedDataJson, notes,
    },
  });

  if (storedFileUrl && originalFileName) {
    await prisma.fileAttachment.create({
      data: { captureId: capture.captureId, animalId: linkedAnimalId, fileName: originalFileName, storedUrl: storedFileUrl, contentType, sizeBytes, uploadedById: user?.uid },
    });
  }

  // Try to auto-match an animal for the review item.
  let matchedAnimalId = linkedAnimalId;
  let matchConfidence: number | null = linkedAnimalId ? 1 : null;
  if (!matchedAnimalId) {
    let parsed: any = {};
    try { parsed = JSON.parse(extractedDataJson); } catch { /* ignore */ }
    const ids: { idType: string; idValue: string }[] = Array.isArray(parsed.identifiers)
      ? parsed.identifiers
      : parsed.naab ? [{ idType: "naab", idValue: String(parsed.naab) }] : [];
    const matches = await matchExistingAnimals({ name: parsed.animal || parsed.primaryName, identifiers: ids });
    if (matches.length) { matchedAnimalId = matches[0].id; matchConfidence = matches[0].confidence; }
  }

  await prisma.importReviewQueue.create({
    data: {
      captureId: capture.captureId, proposedRecordType, matchedAnimalId, matchConfidence,
      extractedDataJson, status: "pending",
    },
  });

  await audit(user, "source_capture", "import", capture.captureId, { proposedRecordType, sourceId });
  revalidatePath("/uploads");
  revalidatePath("/review");
}
