"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { findBull, topBulls, resolveProofFile, safeProofFileName } from "@/lib/lactanet";
import { persistBull } from "@/lib/proof-import";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createImportReview, type ImportAnimalRef } from "@/lib/import-staging";

// Mass import of every bull in a file (~99k rows). On a local/self-hosted server
// this may still be HELD as a request in the review queue and spawned in the
// background; on Vercel the browser-chunked flow (MassImport + /api/proof-import/
// chunk) is used instead, so nothing here depends on a persistent imports dir.
export async function startBulkImport(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  // Validate to a bare CSV basename now so the queued request is runnable later
  // (prevents any shell metacharacter / path component reaching the spawn).
  const safeName = resolveProofFile(String(fd.get("fileName") ?? "")) ? safeProofFileName(String(fd.get("fileName") ?? "")) : null;
  if (!safeName) throw new Error("Choose a valid proof file from the list.");

  const reviewId = await createImportReview({
    userId: user?.uid,
    kind: "proof",
    captureType: "csv",
    sourceName: "LactanetGen",
    notes: `Mass proof import request: ALL bulls in ${safeName}`,
    manifest: { kind: "proof", mode: "all", label: `Mass import — ALL bulls in ${safeName} (~99,000)`, fileName: safeName, animals: [] },
  });
  await audit(user, "import_batch", "stage", reviewId, { mass: safeName, requestedBy: user?.name });
  revalidatePath("/import-proofs");
  redirect("/import-proofs?queued=all");
}

export async function importByReg(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  const fileName = safeProofFileName(String(fd.get("fileName") ?? ""));
  const query = String(fd.get("query") ?? "").trim();
  if (!fileName || !query) throw new Error("Choose a valid file and enter a registration or NAAB code.");

  const bull = await findBull(fileName, query);
  if (!bull) throw new Error(`No bull found for "${query}" in ${fileName}.`);

  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });
  const capture = await prisma.sourceCapture.create({
    data: { sourceId: source?.sourceId, captureType: "csv", originalFileName: fileName, capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 1, notes: `Proof import (pending review): ${bull.registrationNumber} from ${fileName}` },
  });
  // Write NOW as pending; an admin approves (keep) or denies (delete) in /review.
  const { animalId, created, evaluationId } = await persistBull(bull, { sourceId: source?.sourceId ?? null, captureId: capture.captureId, userId: user?.uid, fileName, approvalStatus: "pending" });
  await prisma.sourceCapture.update({ where: { captureId: capture.captureId }, data: { animalId } });
  const reviewId = await createImportReview({
    userId: user?.uid, kind: "proof", captureType: "csv", captureId: capture.captureId,
    manifest: { kind: "proof", mode: "reg", label: `Proof import: ${bull.registeredName} (${bull.registrationNumber}) from ${fileName}`, fileName, count: 1, animals: [{ reg: bull.registrationNumber, animalId, created, evaluationId, name: bull.registeredName }] },
  });
  await audit(user, "import_batch", "stage", reviewId, { kind: "proof", reg: bull.registrationNumber, traits: bull.traits.length });

  revalidatePath("/animals");
  redirect(`/import-proofs?queued=1`);
}

export async function importBulk(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  const fileName = safeProofFileName(String(fd.get("fileName") ?? ""));
  const sortCol = String(fd.get("sortCol") ?? "LPI").replace(/[^A-Za-z0-9$%_ -]/g, "").slice(0, 40);
  const limit = Math.min(200, Math.max(1, parseInt(String(fd.get("limit") ?? "10")) || 10));
  if (!fileName) throw new Error("Choose a valid proof file from the list.");

  const bulls = await topBulls(fileName, sortCol, limit);
  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });
  const capture = await prisma.sourceCapture.create({
    data: { sourceId: source?.sourceId, captureType: "csv", originalFileName: fileName, capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 1, notes: `Proof import (pending review): top ${limit} by ${sortCol} from ${fileName}` },
  });
  // Write each NOW as pending; an admin approves/denies the batch in /review.
  const animals: ImportAnimalRef[] = [];
  for (const bull of bulls) {
    const { animalId, created, evaluationId } = await persistBull(bull, { sourceId: source?.sourceId ?? null, captureId: capture.captureId, userId: user?.uid, fileName, approvalStatus: "pending" });
    animals.push({ reg: bull.registrationNumber, animalId, created, evaluationId, name: bull.registeredName });
  }
  const reviewId = await createImportReview({
    userId: user?.uid, kind: "proof", captureType: "csv", captureId: capture.captureId,
    manifest: { kind: "proof", mode: "topN", label: `Proof import: top ${animals.length} by ${sortCol} from ${fileName}`, fileName, count: animals.length, animals },
  });
  await audit(user, "import_batch", "stage", reviewId, { bulk: animals.length, sortCol });
  revalidatePath("/animals");
  redirect(`/import-proofs?queued=${animals.length}`);
}
