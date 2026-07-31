"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { recomputePreferredForAnimal } from "@/lib/priority";
import { findBull, topBulls, resolveProofFile, safeProofFileName, type ParsedBull } from "@/lib/lactanet";
import { packTraits } from "@/lib/eval-traits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createImportReview, type ImportAnimalRef } from "@/lib/import-staging";

// Mass import of every bull in a file (~99k rows). Far too large to write-then-
// maybe-delete, so it is HELD as a request in the review queue: nothing is
// written until an admin approves it, which spawns the background importer
// (see approveImportReview in src/lib/import-staging.ts). Denying just discards.
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

function proofRunLabel(gerun: string | null): { label: string; date: Date } {
  // GERUN is YYMM (e.g. "2604" = April 2026).
  const m = (gerun ?? "").match(/^(\d{2})(\d{2})$/);
  const now = new Date();
  if (!m) return { label: "Imported proof", date: now };
  const yy = parseInt(m[1]);
  const year = yy > 50 ? 1900 + yy : 2000 + yy;
  const month = Math.min(12, Math.max(1, parseInt(m[2])));
  const monthName = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month];
  return { label: `${monthName} ${year}`, date: new Date(Date.UTC(year, month - 1, 1)) };
}

// Persist one parsed bull: upsert animal + identifiers + roles + a dated genetic
// evaluation with all trait values + a pedigree reference. Returns the animal id.
export async function persistBull(
  bull: ParsedBull,
  ctx: { sourceId: string | null; captureId: string | null; userId?: string; fileName: string; approvalStatus?: "approved" | "pending" },
): Promise<{ animalId: string; created: boolean; evaluationId: string }> {
  const holstein = await prisma.breed.findUnique({ where: { breedCode: "HO" } });
  const approvalStatus = ctx.approvalStatus ?? "approved";
  const isApproved = approvalStatus === "approved";

  // Match existing by registration or NAAB identifier.
  const idMatches = await prisma.animalIdentifier.findMany({
    where: { idValue: { in: [bull.registrationNumber, bull.naabCode ?? "__none__"] } },
    select: { animalId: true },
  });
  let animalId = idMatches[0]?.animalId ?? null;
  let wasCreated = false;

  const { label: runLabel, date: runDate } = proofRunLabel(bull.proofRun);

  if (!animalId) {
    wasCreated = true;
    const created = await prisma.animal.create({
      data: {
        primaryName: bull.registeredName,
        shortName: bull.shortName,
        sex: "M",
        breedId: holstein?.breedId ?? null,
        birthDate: bull.birthDate ? new Date(bull.birthDate + "T00:00:00Z") : null,
        countryOfOrigin: bull.country,
        currentStatus: "proven",
        createdById: ctx.userId,
        notes: `Imported from Lactanet proof file (${ctx.fileName}).`,
      },
    });
    animalId = created.id;
    // Identifiers
    await prisma.animalIdentifier.create({ data: { animalId, idType: bull.regIdType, idValue: bull.registrationNumber, issuingCountry: bull.country, sourceId: ctx.sourceId, isPrimary: true } });
    if (bull.naabCode) await prisma.animalIdentifier.create({ data: { animalId, idType: "naab", idValue: bull.naabCode, sourceId: ctx.sourceId } });
    if (bull.naabMarketingCode) await prisma.animalIdentifier.create({ data: { animalId, idType: "marketing_code", idValue: bull.naabMarketingCode, sourceId: ctx.sourceId } });
    // Role
    await prisma.animalRole.create({ data: { animalId, roleType: "proven_bull", active: true } });
    await prisma.animalRole.create({ data: { animalId, roleType: "reference_sire", active: true } });
  }

  // Descriptive genomics as text trait values.
  const descriptive: { code: string; text: string | null }[] = [
    { code: "A2", text: bull.betaCasein },
    { code: "POLLED", text: bull.polled },
    { code: "COLOUR", text: bull.colourCode },
  ];

  // Trait definition lookup for names/categories/units.

  // Avoid duplicate evaluations for the same run + source — but NEVER disturb an
  // existing APPROVED evaluation when staging a pending import. A pending write
  // must be a brand-new row so that denying it (which deletes only pending rows)
  // can't destroy a pre-existing approved proof. Approved writes replace the
  // prior row for the run as before; the superseded approved row is instead
  // removed at approval time (see approveImportReview's dedupe).
  const existingEval = await prisma.geneticEvaluation.findFirst({
    where: { animalId, proofRun: runLabel, sourceId: ctx.sourceId, ...(isApproved ? {} : { approvalStatus: "pending" }) },
  });
  if (existingEval) {
    await prisma.geneticEvaluation.delete({ where: { evaluationId: existingEval.evaluationId } });
  }

  const lpiRel = bull.traits.find((t) => t.traitCode === "LPI")?.reliability ?? null;
  const packed = packTraits([
    ...bull.traits,
    ...descriptive.filter((d) => d.text).map((d) => ({ traitCode: d.code, numericValue: null, textValue: d.text!, reliability: null, percentileRank: null })),
  ]);
  const evalRec = await prisma.geneticEvaluation.create({
    data: {
      animalId, sourceId: ctx.sourceId, captureId: ctx.captureId, evaluationDate: runDate,
      proofRun: runLabel, countrySystem: "CA", breedContext: "Holstein",
      reliabilityOverall: lpiRel != null ? lpiRel / 100 : null,
      isPreferred: false,
      approvalStatus,
      approvedById: isApproved ? ctx.userId : undefined,
      approvedAt: isApproved ? new Date() : undefined,
      createdById: ctx.userId, notes: `Imported from ${ctx.fileName}.`,
      traitsJson: packed.traitsJson, ...packed.columns,
    },
  });

  // Pedigree reference (immediate 3-gen summary from the proof).
  if (bull.pedigree.length) {
    const summary = bull.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
    await prisma.pedigreeReference.deleteMany({ where: { animalId, source: { sourceName: "LactanetGen" } } });
    await prisma.pedigreeReference.create({
      data: {
        animalId, sourceId: ctx.sourceId, displayStatus: "linked", lastCheckedAt: new Date(),
        notes: `Pedigree (from proof): ${summary}`,
      },
    });
  }

  await recomputePreferredForAnimal(animalId);
  return { animalId, created: wasCreated, evaluationId: evalRec.evaluationId };
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
