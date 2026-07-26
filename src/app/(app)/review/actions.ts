"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { recomputePreferredForAnimal } from "@/lib/priority";
import { packTraits } from "@/lib/eval-traits";
import { revalidatePath } from "next/cache";

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s.length <= 10 ? s + "T00:00:00.000Z" : s);
  return isNaN(d.getTime()) ? null : d;
}

// Edit the extracted JSON / matched animal / notes before deciding.
export async function updateReview(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) throw new Error("Not authorized");
  const reviewId = String(fd.get("reviewId"));
  const extractedDataJson = String(fd.get("extractedDataJson") ?? "").trim();
  const matchedAnimalId = String(fd.get("matchedAnimalId") ?? "") || null;
  const reviewNotes = String(fd.get("reviewNotes") ?? "").trim() || null;
  if (extractedDataJson) {
    try { JSON.parse(extractedDataJson); } catch { throw new Error("Extracted data must be valid JSON."); }
  }
  await prisma.importReviewQueue.update({
    where: { reviewId },
    data: { extractedDataJson: extractedDataJson || undefined, matchedAnimalId, reviewNotes },
  });
  revalidatePath("/review");
}

export async function setReviewStatus(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) throw new Error("Not authorized");
  const reviewId = String(fd.get("reviewId"));
  const status = String(fd.get("status"));
  await prisma.importReviewQueue.update({
    where: { reviewId },
    data: { status, reviewedById: user?.uid, reviewedAt: new Date(), reviewNotes: String(fd.get("reviewNotes") ?? "").trim() || undefined },
  });
  await audit(user, "review_item", status, reviewId);
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

// Approve → materialize the real record and link it to the capture/source.
export async function approveReview(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) throw new Error("Not authorized");
  const reviewId = String(fd.get("reviewId"));

  const review = await prisma.importReviewQueue.findUnique({ where: { reviewId }, include: { capture: true } });
  if (!review) throw new Error("Review item not found");

  const sourceId = review.capture.sourceId ?? null;
  const captureId = review.captureId;
  let data: any = {};
  try { data = JSON.parse(review.extractedDataJson ?? "{}"); } catch { data = {}; }

  let targetAnimalId = review.matchedAnimalId ?? review.capture.animalId ?? null;

  const classDefs = new Map((await prisma.traitDefinition.findMany({ where: { domain: "classification" } })).map((t) => [t.traitCode, t]));

  async function createProof(animalId: string) {
    const traitsIn: Record<string, any> = data.traits ?? {};
    const raw = Object.entries(traitsIn).map(([code, value]) => {
      const asNum = Number(value);
      return { traitCode: code, numericValue: isNaN(asNum) ? null : asNum, textValue: isNaN(asNum) ? String(value) : null, reliability: null, percentileRank: null };
    });
    const packed = packTraits(raw);
    await prisma.geneticEvaluation.create({
      data: {
        animalId, sourceId, captureId, evaluationDate: parseDate(data.evaluationDate) ?? new Date(),
        proofRun: data.proofRun ?? null, countrySystem: data.countrySystem ?? null,
        approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date(), createdById: user?.uid,
        notes: "Created from approved review item.",
        traitsJson: packed.traitsJson, ...packed.columns,
      },
    });
  }

  if (review.proposedRecordType === "genetic_evaluation") {
    if (!targetAnimalId) throw new Error("Match an animal before approving a proof.");
    await createProof(targetAnimalId);
  } else if (review.proposedRecordType === "milk_record") {
    if (!targetAnimalId) throw new Error("Match an animal before approving a milk record.");
    await prisma.milkRecord.create({
      data: {
        animalId: targetAnimalId, sourceId, captureId, recordDate: parseDate(data.recordDate) ?? new Date(),
        lactationNumber: data.lactationNumber ?? null, milkAmount: data.milk ?? data.milkAmount ?? null,
        fatAmount: data.fat ?? data.fatAmount ?? null, fatPercent: data.fatPercent ?? null,
        proteinAmount: data.protein ?? data.proteinAmount ?? null, proteinPercent: data.proteinPercent ?? null,
        approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date(), createdById: user?.uid,
        notes: "Created from approved review item.",
      },
    });
  } else if (review.proposedRecordType === "classification") {
    if (!targetAnimalId) throw new Error("Match an animal before approving a classification.");
    const rec = await prisma.classificationRecord.create({
      data: {
        animalId: targetAnimalId, sourceId, captureId, classificationDate: parseDate(data.classificationDate) ?? new Date(),
        finalScore: data.finalScore ?? data.final ?? null, classificationCode: data.classificationCode ?? data.code ?? null,
        lactationNumber: data.lactationNumber ?? null, approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date(), createdById: user?.uid,
        notes: "Created from approved review item.",
      },
    });
    const traits: Record<string, any> = data.traits ?? {};
    for (const [code, value] of Object.entries(traits)) {
      const def = classDefs.get(code);
      await prisma.classificationTraitValue.create({
        data: { classificationId: rec.classificationId, traitCode: code, traitName: def?.traitName ?? code, traitValue: String(value), displayOrder: def?.displayOrder ?? 0 },
      });
    }
  } else if (review.proposedRecordType === "animal") {
    const breed = data.breedCode ? await prisma.breed.findUnique({ where: { breedCode: data.breedCode } }) : null;
    const created = await prisma.animal.create({
      data: {
        primaryName: data.primaryName ?? data.animal ?? "Imported animal",
        shortName: data.shortName ?? null, sex: data.sex ?? "M", breedId: breed?.breedId ?? null,
        countryOfOrigin: data.country ?? "CA", currentStatus: "active", createdById: user?.uid,
        notes: "Created from approved review item.",
      },
    });
    targetAnimalId = created.id;
    const ids: any[] = Array.isArray(data.identifiers) ? data.identifiers : [];
    for (let i = 0; i < ids.length; i++) {
      await prisma.animalIdentifier.create({
        data: { animalId: created.id, idType: ids[i].idType ?? "internal_stud", idValue: String(ids[i].idValue), sourceId, isPrimary: i === 0 },
      });
    }
    // Link the capture to the new animal and optionally create a proof.
    await prisma.sourceCapture.update({ where: { captureId }, data: { animalId: created.id } });
    if (data.proof || data.traits) {
      if (data.proof && typeof data.proof === "object") data = { ...data, ...data.proof };
      await createProof(created.id);
    }
  } else if (review.proposedRecordType === "identifier") {
    if (!targetAnimalId) throw new Error("Match an animal before approving an identifier.");
    await prisma.animalIdentifier.create({
      data: { animalId: targetAnimalId, idType: data.idType ?? "internal_stud", idValue: String(data.idValue ?? ""), sourceId },
    });
  }

  await prisma.importReviewQueue.update({
    where: { reviewId },
    data: { status: "approved", matchedAnimalId: targetAnimalId, reviewedById: user?.uid, reviewedAt: new Date() },
  });
  if (targetAnimalId) await recomputePreferredForAnimal(targetAnimalId);
  await audit(user, "review_item", "approve", reviewId, { proposedRecordType: review.proposedRecordType, targetAnimalId });

  revalidatePath("/review");
  revalidatePath("/dashboard");
  if (targetAnimalId) revalidatePath(`/animals/${targetAnimalId}`);
}
