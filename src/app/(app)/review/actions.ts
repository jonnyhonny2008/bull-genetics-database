"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can, isBatchImportType } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { applyReviewApproval } from "@/lib/review-apply";
import { approveImportReview, denyImportReview, restoreImportReview } from "@/lib/import-staging";
import { revalidatePath } from "next/cache";
import { clearAggregateCache } from "@/lib/aggregate-cache";

// Batch-import review rows (Proof Import / large Animal Import) are managed ONLY
// by approveImport/denyImport (admin, record:approve). The generic per-record
// actions below require only review:write (staff) — they must refuse batch rows,
// otherwise a non-admin could rewrite the batch manifest (updateReview) to make an
// admin's Deny delete arbitrary animals, or flip a batch's status (setReviewStatus/
// approveReview) to bypass the admin gate and strand the pending records.
function assertNotBatchImport(proposedRecordType: string) {
  if (isBatchImportType(proposedRecordType)) {
    throw new Error("This is a batch import — use the Approve / Deny import controls instead.");
  }
}
async function loadNonBatchReview(reviewId: string) {
  const r = await prisma.importReviewQueue.findUnique({ where: { reviewId }, select: { proposedRecordType: true } });
  if (!r) throw new Error("Review item not found");
  assertNotBatchImport(r.proposedRecordType);
}

// Edit the extracted JSON / matched animal / notes before deciding.
export async function updateReview(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) throw new Error("Not authorized");
  const reviewId = String(fd.get("reviewId"));
  await loadNonBatchReview(reviewId); // never let review:write rewrite a batch manifest
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
  await loadNonBatchReview(reviewId); // batch rows may only be approved/denied via the import controls
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
// The materialization itself lives in src/lib/review-apply.ts so the Genetics
// Agent's review tool runs the identical logic.
export async function approveReview(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "review:write")) throw new Error("Not authorized");
  const reviewId = String(fd.get("reviewId"));

  const { targetAnimalId, proposedRecordType } = await applyReviewApproval(reviewId, user);
  await audit(user, "review_item", "approve", reviewId, { proposedRecordType, targetAnimalId });

  revalidatePath("/review");
  revalidatePath("/dashboard");
  if (targetAnimalId) revalidatePath(`/animals/${targetAnimalId}`);
}

// ---------------------------------------------------------------------------
// Batch-import approvals (Proof Import + large Animal Import). Admin-only:
// approve promotes the pending records (or starts the mass job); deny deletes
// the records the import wrote. See src/lib/import-staging.ts.
// ---------------------------------------------------------------------------

export async function approveImport(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:approve")) throw new Error("Only an admin can approve imports.");
  const res = await approveImportReview(String(fd.get("reviewId")), user);
  if (!res.ok) throw new Error(res.message);
  // revalidatePath only clears Next's ROUTE cache; the dashboards' aggregate
  // cache is a plain in-process Map and would keep serving pre-import numbers for
  // up to its TTL. In serverless this only clears THIS warm instance — others
  // still expire on their own — so the TTL remains the real bound, not this call.
  clearAggregateCache();
  revalidatePath("/review");
  revalidatePath("/animals");
  revalidatePath("/dashboard");
}

export async function denyImport(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:approve")) throw new Error("Only an admin can deny imports.");
  const res = await denyImportReview(String(fd.get("reviewId")), user);
  if (!res.ok) throw new Error(res.message);
  // revalidatePath only clears Next's ROUTE cache; the dashboards' aggregate
  // cache is a plain in-process Map and would keep serving pre-import numbers for
  // up to its TTL. In serverless this only clears THIS warm instance — others
  // still expire on their own — so the TTL remains the real bound, not this call.
  clearAggregateCache();
  revalidatePath("/review");
  revalidatePath("/animals");
  revalidatePath("/dashboard");
}

export async function restoreImport(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:approve")) throw new Error("Only an admin can restore imports.");
  const res = await restoreImportReview(String(fd.get("reviewId")), user);
  if (!res.ok) throw new Error(res.message);
  // revalidatePath only clears Next's ROUTE cache; the dashboards' aggregate
  // cache is a plain in-process Map and would keep serving pre-import numbers for
  // up to its TTL. In serverless this only clears THIS warm instance — others
  // still expire on their own — so the TTL remains the real bound, not this call.
  clearAggregateCache();
  revalidatePath("/review");
  revalidatePath("/animals");
  revalidatePath("/dashboard");
}
