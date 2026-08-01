import "server-only";

import { prisma } from "./db";
import { recomputePreferredForAnimal } from "./priority";
import { packTraits } from "./eval-traits";
import type { ParsedBull } from "./lactanet";

// Persistence for one parsed Lactanet bull-proof row. Extracted from the
// import-proofs server actions so it can also be reused by the browser-chunked
// mass-import API route (/api/proof-import/chunk) — the same upsert either way.

export function proofRunLabel(gerun: string | null): { label: string; date: Date } {
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

  // Avoid duplicate evaluations for the same run + source — but NEVER disturb an
  // existing APPROVED evaluation when staging a pending import. A pending write
  // must be a brand-new row so that denying it can't destroy a pre-existing
  // approved proof. Approved writes replace the prior row for the run as before.
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
