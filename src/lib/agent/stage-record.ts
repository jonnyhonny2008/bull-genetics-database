import "server-only";
import { prisma } from "@/lib/db";

// ---------------------------------------------------------------------------
// Stage a Genetics Agent data-write into the admin review queue instead of
// committing it immediately.
//
// The agent can propose new proofs / milk records / classifications / animals,
// but a human must confirm them in the Review Queue before they become real —
// so a misread instruction (e.g. the wrong animal resolved by a fuzzy name
// match) can never silently write a wrong number to the lineup. This reuses the
// EXACT same ImportReviewQueue + applyReviewApproval machinery that extracted-data
// reviews use, so an approved agent request is materialised by the identical,
// already-tested code path — no second write implementation to keep in sync.
//
// `summary` is the plain-language, thorough description shown to the admin.
// `data` must match the shape applyReviewApproval() reads for the record type.
// ---------------------------------------------------------------------------

export type AgentRecordType = "genetic_evaluation" | "milk_record" | "classification" | "animal";

export async function stageAgentRecord(opts: {
  userId: string;
  proposedRecordType: AgentRecordType;
  matchedAnimalId: string | null;
  data: Record<string, unknown>;
  summary: string;
}): Promise<{ reviewId: string }> {
  const source = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" }, select: { sourceId: true } });
  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId: source?.sourceId ?? undefined,
      captureType: "agent_write",
      capturedById: opts.userId,
      extractionStatus: "extracted",
      confidenceScore: 1,
      animalId: opts.matchedAnimalId ?? undefined,
      notes: `Genetics Agent change request: ${opts.summary}`.slice(0, 500),
    },
    select: { captureId: true },
  });
  const review = await prisma.importReviewQueue.create({
    data: {
      captureId: capture.captureId,
      proposedRecordType: opts.proposedRecordType,
      matchedAnimalId: opts.matchedAnimalId ?? undefined,
      extractedDataJson: JSON.stringify(opts.data),
      reviewNotes: opts.summary,
      status: "pending",
    },
    select: { reviewId: true },
  });
  return { reviewId: review.reviewId };
}
