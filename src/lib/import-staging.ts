import "server-only";

// ---------------------------------------------------------------------------
// Staged imports — admin approval gate for heavy imports.
//
// Model (chosen with the user): WRITE-NOW, DELETE-IF-DENIED.
//   • A gated import runs and writes to the database immediately, but its new
//     genetic evaluations are marked approvalStatus:"pending" (so they are NOT
//     yet the animal's authoritative/preferred proof — see priority.ts).
//   • One ImportReviewQueue row is created per batch, carrying a MANIFEST of
//     exactly what was written (which animals were newly created, and the id of
//     each pending evaluation), so approve/deny can act precisely.
//   • Approve  → the pending evaluations become "approved" and are recomputed
//                into the preferred proof.
//   • Deny     → newly-created animals are deleted (cascade removes identifiers,
//                evaluations, profile, etc.); pending evaluations added to a
//                PRE-EXISTING animal are deleted; preferred is recomputed.
//
// The one exception is the mass "import ALL bulls" proof job (~99k rows): it is
// far too large to write-then-maybe-delete, so it is HELD as a request — nothing
// is written until approve, which spawns the background importer; deny discards.
// ---------------------------------------------------------------------------

import { spawn } from "child_process";
import { prisma } from "./db";
import { recomputePreferredForAnimal } from "./priority";
import { resolveProofFile, safeProofFileName } from "./lactanet";
import { isBatchImportType } from "./constants";
import type { SessionUser } from "./auth";
import { audit } from "./audit";

export type ImportKind = "proof" | "animal";
export type ImportMode = "reg" | "topN" | "all" | "paste";

/** One animal touched by a staged import, recorded so deny can roll it back. */
export interface ImportAnimalRef {
  reg: string;
  animalId: string;
  created: boolean; // the ANIMAL row was newly created by this import
  evaluationId: string | null; // the pending evaluation this import wrote (if any)
  name?: string | null;
}

export interface ImportManifest {
  kind: ImportKind;
  mode: ImportMode;
  label: string; // human summary shown in the review queue
  fileName?: string; // proof CSV basename — used to re-run the mass job on approve
  animals: ImportAnimalRef[]; // empty for the mass "all" hold-to-start job
  count?: number; // requested size (paste length / top-N limit)
}

export const proposedRecordTypeFor = (kind: ImportKind) =>
  kind === "proof" ? "proof_import" : "animal_import";

export function parseManifest(json: string | null | undefined): ImportManifest | null {
  if (!json) return null;
  try {
    const m = JSON.parse(json);
    if (m && (m.kind === "proof" || m.kind === "animal") && Array.isArray(m.animals)) return m as ImportManifest;
  } catch {
    /* not a batch-import manifest */
  }
  return null;
}

/**
 * Create the review-queue entry for a staged import batch. The records
 * themselves have already been written (pending) by the caller; this records the
 * batch so an admin can approve or deny it.
 */
export async function createImportReview(opts: {
  userId?: string | null;
  kind: ImportKind;
  captureType: string; // "csv" | "lactanet_query"
  sourceName?: string; // e.g. "LactanetGen"
  captureId?: string; // reuse an existing capture instead of creating one
  notes?: string;
  manifest: ImportManifest;
}): Promise<string> {
  let captureId = opts.captureId ?? null;
  if (!captureId) {
    const source = opts.sourceName
      ? await prisma.source.findUnique({ where: { sourceName: opts.sourceName }, select: { sourceId: true } })
      : null;
    const capture = await prisma.sourceCapture.create({
      data: {
        sourceId: source?.sourceId ?? undefined,
        captureType: opts.captureType,
        capturedById: opts.userId ?? undefined,
        extractionStatus: "extracted",
        confidenceScore: 1,
        notes: opts.notes ?? opts.manifest.label,
      },
      select: { captureId: true },
    });
    captureId = capture.captureId;
  }

  const review = await prisma.importReviewQueue.create({
    data: {
      captureId,
      proposedRecordType: proposedRecordTypeFor(opts.kind),
      status: "pending",
      extractedDataJson: JSON.stringify(opts.manifest),
    },
    select: { reviewId: true },
  });
  return review.reviewId;
}

export interface ImportDecisionResult {
  ok: boolean;
  message: string;
  animalsAffected?: number;
}

/** Approve a staged import: promote its pending records (or start the mass job). */
export async function approveImportReview(reviewId: string, user: SessionUser | null): Promise<ImportDecisionResult> {
  const review = await prisma.importReviewQueue.findUnique({ where: { reviewId } });
  if (!review) return { ok: false, message: "Review item not found." };
  // proposedRecordType is AUTHORITATIVE for batch identity: only createImportReview
  // (called from the trusted import code paths) ever sets it to a batch type, so the
  // manifest on such a row is always system-generated, never user input. A row with a
  // non-batch type but a manifest-shaped extractedDataJson (e.g. forged via an upload)
  // is refused here — this is what actually closes the confused-deputy delete.
  if (!isBatchImportType(review.proposedRecordType)) return { ok: false, message: "This item is not a batch import." };
  const manifest = parseManifest(review.extractedDataJson);
  if (!manifest) return { ok: false, message: "This item is not a batch import." };

  // For the mass job, validate the file BEFORE claiming the row, so a missing file
  // doesn't leave the review marked approved with nothing actually started.
  let safeName: string | null = null;
  if (manifest.mode === "all") {
    safeName = manifest.fileName && resolveProofFile(manifest.fileName) ? safeProofFileName(manifest.fileName) : null;
    if (!safeName) return { ok: false, message: "The proof file for this job is no longer available." };
  }

  // Atomically claim the row (pending -> approved). Only the request that wins the
  // transition proceeds; a concurrent double-approve or an approve-after-deny gets
  // count 0 here and stops — this closes the check-then-act TOCTOU (e.g. a double-
  // clicked Approve on a mass job would otherwise spawn two importers).
  const claim = await prisma.importReviewQueue.updateMany({
    where: { reviewId, status: "pending" },
    data: { status: "approved", reviewedById: user?.uid, reviewedAt: new Date() },
  });
  if (claim.count !== 1) return { ok: false, message: "This import is no longer pending." };

  let message = "";
  if (manifest.mode === "all") {
    // Hold-to-start mass job — nothing was written yet; kick it off now.
    const child = spawn("cmd", ["/c", "npm", "run", "import:all", "--", safeName as string], {
      cwd: process.cwd(), env: process.env, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    message = `Mass import of ${safeName} started in the background.`;
  } else {
    // Promote every pending evaluation this batch wrote, then recompute preferred.
    const evalIds = manifest.animals.map((a) => a.evaluationId).filter((x): x is string => !!x);
    if (evalIds.length) {
      await prisma.geneticEvaluation.updateMany({
        where: { evaluationId: { in: evalIds }, approvalStatus: "pending" },
        data: { approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date() },
      });
      // Now that the fresh import is approved, drop any PRIOR approved evaluation
      // it supersedes (same animal + proof round + source). Staging deliberately
      // left the old approved row untouched so deny could roll back safely; on
      // approve we replace it, so the round isn't double-counted.
      const promoted = await prisma.geneticEvaluation.findMany({
        where: { evaluationId: { in: evalIds } },
        select: { evaluationId: true, animalId: true, evaluationDate: true, sourceId: true },
      });
      for (const p of promoted) {
        await prisma.geneticEvaluation.deleteMany({
          // Exclude ALL just-promoted ids (notIn evalIds), so the batch can never
          // delete one of its own newly-approved rows.
          where: { animalId: p.animalId, evaluationDate: p.evaluationDate, sourceId: p.sourceId, approvalStatus: "approved", evaluationId: { notIn: evalIds } },
        });
      }
    }
    const animalIds = [...new Set(manifest.animals.map((a) => a.animalId))];
    for (const id of animalIds) await recomputePreferredForAnimal(id);
    message = `Approved ${animalIds.length} animal${animalIds.length === 1 ? "" : "s"} (${evalIds.length} evaluation${evalIds.length === 1 ? "" : "s"}).`;
  }

  // status was already set to "approved" by the atomic claim above.
  await audit(user, "import_batch", "approve", reviewId, { kind: manifest.kind, mode: manifest.mode, animals: manifest.animals.length });
  return { ok: true, message, animalsAffected: manifest.animals.length };
}

/** Deny a staged import: delete created animals + pending evaluations it wrote. */
export async function denyImportReview(reviewId: string, user: SessionUser | null): Promise<ImportDecisionResult> {
  const review = await prisma.importReviewQueue.findUnique({ where: { reviewId } });
  if (!review) return { ok: false, message: "Review item not found." };
  // proposedRecordType is AUTHORITATIVE for batch identity: only createImportReview
  // (called from the trusted import code paths) ever sets it to a batch type, so the
  // manifest on such a row is always system-generated, never user input. A row with a
  // non-batch type but a manifest-shaped extractedDataJson (e.g. forged via an upload)
  // is refused here — this is what actually closes the confused-deputy delete.
  if (!isBatchImportType(review.proposedRecordType)) return { ok: false, message: "This item is not a batch import." };
  const manifest = parseManifest(review.extractedDataJson);
  if (!manifest) return { ok: false, message: "This item is not a batch import." };

  // Atomically claim the row (pending -> rejected). Blocks a re-run of the
  // destructive deletes and any concurrent approve+deny interleave.
  const claim = await prisma.importReviewQueue.updateMany({
    where: { reviewId, status: "pending" },
    data: { status: "rejected", reviewedById: user?.uid, reviewedAt: new Date() },
  });
  if (claim.count !== 1) return { ok: false, message: "This import is no longer pending." };

  let deletedAnimals = 0;
  let deletedEvals = 0;
  if (manifest.mode !== "all") {
    const createdIds = [...new Set(manifest.animals.filter((a) => a.created).map((a) => a.animalId))];
    const allEvalIds = manifest.animals.map((a) => a.evaluationId).filter((x): x is string => !!x);

    // 1) Delete only THIS batch's own PENDING evaluations (for created AND
    //    pre-existing animals). The approvalStatus:"pending" filter guarantees we
    //    never delete an approved eval — even one a later batch promoted onto a
    //    shared row.
    if (allEvalIds.length) {
      const res = await prisma.geneticEvaluation.deleteMany({ where: { evaluationId: { in: allEvalIds }, approvalStatus: "pending" } });
      deletedEvals = res.count;
    }
    // 2) Delete a batch-CREATED animal only if it now carries NO approved
    //    evaluation. A later, independently-approved batch can attach an
    //    authoritative proof to the same animal; deleting the animal would
    //    cascade-destroy that approved proof — so keep those animals. The
    //    `evaluations: { none: approved }` filter is evaluated INSIDE the DELETE
    //    statement, which closes the wide SELECT-then-DELETE race a separate
    //    lookup would leave open. (A tiny residual remains: under READ COMMITTED a
    //    concurrent approve committing DURING this DELETE could still slip an
    //    approved eval past the snapshot; fully closing that needs SERIALIZABLE or
    //    a row lock. Low risk — it needs two admins acting on the same animal in
    //    the same instant, and every sequential/single-admin path is safe.)
    if (createdIds.length) {
      const res = await prisma.animal.deleteMany({
        where: { id: { in: createdIds }, evaluations: { none: { approvalStatus: "approved" } } },
      });
      deletedAnimals = res.count;
      // Any created animal that SURVIVED (it now carries approved data) needs a
      // recompute, since we removed its pending eval in step 1.
      const kept = await prisma.animal.findMany({ where: { id: { in: createdIds } }, select: { id: true } });
      for (const a of kept) await recomputePreferredForAnimal(a.id);
    }
    // 3) Recompute pre-existing animals whose pending eval we removed.
    const survivors = [...new Set(manifest.animals.filter((a) => !a.created && a.evaluationId).map((a) => a.animalId))];
    for (const id of survivors) await recomputePreferredForAnimal(id);
  }

  // status was already set to "rejected" by the atomic claim above.
  await audit(user, "import_batch", "deny", reviewId, { kind: manifest.kind, mode: manifest.mode, deletedAnimals, deletedEvals });
  const message =
    manifest.mode === "all"
      ? "Mass import request discarded (nothing was written)."
      : `Denied — deleted ${deletedAnimals} new animal${deletedAnimals === 1 ? "" : "s"} and ${deletedEvals} pending evaluation${deletedEvals === 1 ? "" : "s"}.`;
  return { ok: true, message, animalsAffected: manifest.animals.length };
}
