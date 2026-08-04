// ---------------------------------------------------------------------------
// Shared Holstein.ca upsert. Turns one ParsedHolstein into DB rows: match or
// create the Animal + identifiers + roles, write the genomic evaluation,
// classification, and a pedigree reference. PURE w.r.t. persistence — the
// caller passes a PrismaClient and pre-resolved breed/source ids, and is
// responsible for recomputing `isPreferred` afterwards. Used by both the
// paste server action and the tsx bulk importer.
// ---------------------------------------------------------------------------

import type { PrismaClient } from "@prisma/client";
import { packTraits } from "./eval-traits";
import { pedigreeNotesFromFamilyTree } from "./pedigree";
import { buildAisUrl, type ParsedHolstein, type HolsteinProfile } from "./holstein-parse";

export interface HolsteinImportDeps {
  breedId: string | null;        // Holstein breed id
  lactanetSourceId: string | null; // source for the genomic evaluation (LactanetGen)
  holCanadaSourceId: string | null; // source for identity / classification / pedigree
  userId?: string | null;
  captureId?: string | null;
  animalIdParam?: string | null; // Holstein.ca animalId (for the source URL)
  approve?: boolean;             // default true — write as approved
}

export interface HolsteinImportResult {
  regNo: string;
  animalId: string;
  created: boolean;
  evaluationWritten: boolean;
  classificationWritten: boolean;
  traitCount: number;
  warnings: string[];
}

export async function importParsedHolstein(
  prisma: PrismaClient,
  parsed: ParsedHolstein,
  regNoInput: string,
  deps: HolsteinImportDeps,
): Promise<HolsteinImportResult> {
  const regNo = (parsed.regNo ?? regNoInput ?? "").trim();
  if (!regNo) throw new Error("No registration number to import.");
  const approve = deps.approve !== false;
  const now = new Date();

  // --- Match or create the animal ---
  const existing = await prisma.animalIdentifier.findFirst({
    where: { idType: "registration_ca", idValue: regNo },
    select: { animalId: true },
  });
  let animalId = existing?.animalId ?? null;
  const created = !animalId;

  const noteBits = [
    parsed.purity ? `Purity ${parsed.purity}` : null,
    parsed.herdNo ? `Herd #${parsed.herdNo}` : null,
    parsed.inbreeding != null ? `${parsed.inbreeding}%INB` : null,
    parsed.rValue != null ? `${parsed.rValue}%R` : null,
  ].filter(Boolean).join(" · ");

  if (!animalId) {
    const animal = await prisma.animal.create({
      data: {
        primaryName: parsed.name ?? regNo,
        sex: parsed.sex,
        breedId: deps.breedId ?? null,
        birthDate: parsed.birthDate ? new Date(parsed.birthDate + "T00:00:00Z") : null,
        countryOfOrigin: "CA",
        currentStatus: "active",
        createdById: deps.userId ?? undefined,
        notes: `Imported from Holstein.ca (${regNo}). ${noteBits}`.trim(),
      },
    });
    animalId = animal.id;
    await prisma.animalIdentifier.create({
      data: { animalId, idType: "registration_ca", idValue: regNo, issuingCountry: "CA", issuingOrganization: "Holstein Canada", sourceId: deps.holCanadaSourceId ?? undefined, isPrimary: true },
    });
    if (parsed.nationalId) {
      await prisma.animalIdentifier.create({
        data: { animalId, idType: "breed_assoc", idValue: parsed.nationalId, issuingOrganization: "Holstein Canada", sourceId: deps.holCanadaSourceId ?? undefined },
      });
    }
    await prisma.animalRole.create({ data: { animalId, roleType: parsed.sex === "M" ? "proven_bull" : "cow", active: true } });
    if (parsed.sex === "F") await prisma.animalRole.create({ data: { animalId, roleType: "dam", active: true } });
  }

  if (deps.captureId) {
    await prisma.sourceCapture.update({ where: { captureId: deps.captureId }, data: { animalId } }).catch(() => {});
  }

  // --- Genomic evaluation (source = LactanetGen; CAN-GEBV/PA surfaced on Holstein.ca) ---
  let evaluationWritten = false;
  if (parsed.evaluation && parsed.traits.length) {
    const ev = await prisma.geneticEvaluation.findFirst({
      where: { animalId, proofRun: parsed.evaluation.runLabel, sourceId: deps.lactanetSourceId ?? undefined },
      select: { evaluationId: true },
    });
    if (ev) await prisma.geneticEvaluation.delete({ where: { evaluationId: ev.evaluationId } });

    const descriptive = [
      { code: "A2", text: parsed.betaCasein },
      { code: "COLOUR", text: parsed.colour },
    ].filter((x) => x.text).map((x) => ({ traitCode: x.code, numericValue: null, textValue: x.text!, reliability: null, percentileRank: null }));

    const packed = packTraits([
      ...parsed.traits.map((t) => ({ traitCode: t.code, numericValue: t.numericValue, textValue: t.textValue, reliability: t.reliability, percentileRank: t.percentileRank })),
      ...descriptive,
    ]);

    await prisma.geneticEvaluation.create({
      data: {
        animalId, sourceId: deps.lactanetSourceId ?? undefined, captureId: deps.captureId ?? undefined,
        evaluationDate: new Date(parsed.evaluation.runDate + "T00:00:00Z"),
        proofRun: parsed.evaluation.runLabel, countrySystem: "CA", breedContext: "Holstein",
        reliabilityOverall: parsed.evaluation.reliability,
        approvalStatus: approve ? "approved" : "pending",
        approvedById: approve ? deps.userId ?? undefined : undefined,
        approvedAt: approve ? now : undefined,
        createdById: deps.userId ?? undefined,
        notes: `Genomic evaluation captured from Holstein.ca${parsed.evaluation.basis ? ` (CAN-${parsed.evaluation.basis})` : ""}.`,
        traitsJson: packed.traitsJson, ...packed.columns,
      },
    });
    evaluationWritten = true;
  }

  // --- Classification (source = Holstein Canada); only when the animal itself is classified ---
  let classificationWritten = false;
  if (parsed.classification) {
    let clsDate = new Date();
    if (parsed.birthDate) {
      const ageYears = parseInt((parsed.classification.age ?? "").match(/(\d+)/)?.[1] ?? "2") || 2;
      clsDate = new Date(parsed.birthDate + "T00:00:00Z");
      clsDate.setUTCFullYear(clsDate.getUTCFullYear() + ageYears);
    }
    const exCls = await prisma.classificationRecord.findFirst({
      where: { animalId, finalScore: parsed.classification.score, classificationCode: parsed.classification.code, sourceId: deps.holCanadaSourceId ?? undefined },
      select: { classificationId: true },
    });
    if (!exCls) {
      const cls = await prisma.classificationRecord.create({
        data: {
          animalId, sourceId: deps.holCanadaSourceId ?? undefined, captureId: deps.captureId ?? undefined, classificationDate: clsDate,
          ageAtClassification: parsed.classification.age, finalScore: parsed.classification.score, classificationCode: parsed.classification.code,
          approvalStatus: approve ? "approved" : "pending",
          approvedById: approve ? deps.userId ?? undefined : undefined,
          approvedAt: approve ? now : undefined,
          createdById: deps.userId ?? undefined,
          notes: "Classification captured from Holstein.ca.",
        },
      });
      for (const s of parsed.classificationSections) {
        await prisma.classificationTraitValue.create({ data: { classificationId: cls.classificationId, traitCode: s.code, traitName: s.name, traitValue: s.value, displayOrder: 0 } });
      }
      classificationWritten = true;
    }
  }

  // --- Pedigree reference ---
  if (parsed.pedigree.length) {
    const summary = parsed.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
    if (deps.holCanadaSourceId) {
      await prisma.pedigreeReference.deleteMany({ where: { animalId, sourceId: deps.holCanadaSourceId } });
    }
    await prisma.pedigreeReference.create({
      data: {
        animalId, sourceId: deps.holCanadaSourceId ?? undefined,
        sourceUrl: buildAisUrl(regNo, deps.animalIdParam || undefined),
        displayStatus: "linked", lastCheckedAt: now,
        notes: `Pedigree (Holstein.ca): ${summary}`,
      },
    });
  }

  return {
    regNo, animalId: animalId!, created,
    evaluationWritten, classificationWritten,
    traitCount: parsed.traits.length, warnings: parsed.warnings,
  };
}

// Store the rich Holstein.ca profile (owners, family tree, progeny, awards) as
// JSON on the animal, and make the scraped classification HISTORY authoritative
// for Holstein-Canada-sourced classifications (real dates + section scores,
// replacing the single estimated record importParsedHolstein may have written).
export async function storeHolsteinProfile(
  prisma: PrismaClient,
  animalId: string,
  profile: HolsteinProfile,
  deps: Pick<HolsteinImportDeps, "holCanadaSourceId" | "userId" | "approve">,
): Promise<{ classifications: number; lactations: number }> {
  await prisma.animal.update({ where: { id: animalId }, data: { holsteinProfileJson: JSON.stringify(profile) } });

  // --- Pedigree reference -------------------------------------------------
  // The proof-file importer writes this row; a live profile fetch did not, so
  // an animal pulled in specifically to close a pedigree gap arrived with no
  // readable pedigree and left the gap open. The relatedness engine only ever
  // reads PedigreeReference.notes, so without this the familyTree above is
  // invisible to it.
  if (profile.familyTree.length && deps.holCanadaSourceId) {
    const summary = pedigreeNotesFromFamilyTree(profile.familyTree);
    if (summary) {
      await prisma.pedigreeReference.deleteMany({ where: { animalId, sourceId: deps.holCanadaSourceId } });
      await prisma.pedigreeReference.create({
        data: {
          animalId, sourceId: deps.holCanadaSourceId,
          displayStatus: "linked", lastCheckedAt: new Date(), notes: summary,
        },
      });
    }
  }

  // --- Lactation / milk records (305-day standardized rows) ---
  let lactationsWritten = 0;
  if (profile.lactations.length && deps.holCanadaSourceId) {
    const approve = deps.approve !== false;
    const now = new Date();
    await prisma.milkRecord.deleteMany({ where: { animalId, sourceId: deps.holCanadaSourceId } });
    for (const l of profile.lactations) {
      const recordDate = l.calvingDateIso ? new Date(l.calvingDateIso + "T00:00:00Z") : now;
      const bca = [l.bca.milk != null ? `Milk ${l.bca.milk}` : null, l.bca.fat != null ? `Fat ${l.bca.fat}` : null, l.bca.prot != null ? `Prot ${l.bca.prot}` : null, l.bca.comp != null ? `Comp ${l.bca.comp}` : null].filter(Boolean).join(" / ");
      await prisma.milkRecord.create({
        data: {
          animalId, sourceId: deps.holCanadaSourceId, recordDate,
          lactationNumber: l.lactationNumber, calvingDate: l.calvingDateIso ? recordDate : undefined,
          daysInMilk: l.dim ?? undefined, milkAmount: l.milk ?? undefined, milkUnit: "kg",
          fatAmount: l.fat ?? undefined, fatPercent: l.fatPct ?? undefined,
          proteinAmount: l.prot ?? undefined, proteinPercent: l.protPct ?? undefined,
          recordType: "305d", completionStatus: "complete",
          approvalStatus: approve ? "approved" : "pending", approvedById: approve ? deps.userId ?? undefined : undefined,
          approvedAt: approve ? now : undefined, createdById: deps.userId ?? undefined,
          notes: `Lactation ${l.lactationNumber}${l.ageAtCalving ? ` @ ${l.ageAtCalving}` : ""}${l.milkingFreq ? ` (${l.milkingFreq})` : ""}${bca ? ` · BCA ${bca}` : ""}.`,
        },
      });
      lactationsWritten++;
    }
  }

  if (profile.classifications.length && deps.holCanadaSourceId) {
    const approve = deps.approve !== false;
    const now = new Date();
    // History is authoritative — replace prior Holstein-source classifications
    // (ClassificationTraitValue rows cascade-delete with their record).
    await prisma.classificationRecord.deleteMany({ where: { animalId, sourceId: deps.holCanadaSourceId } });
    for (const c of profile.classifications) {
      const rec = await prisma.classificationRecord.create({
        data: {
          animalId, sourceId: deps.holCanadaSourceId, classificationDate: c.date ? new Date(c.date + "T00:00:00Z") : now,
          lactationNumber: c.lactation ?? undefined, finalScore: c.score ?? undefined, classificationCode: c.code ?? undefined,
          approvalStatus: approve ? "approved" : "pending", approvedById: approve ? deps.userId ?? undefined : undefined,
          approvedAt: approve ? now : undefined, createdById: deps.userId ?? undefined,
          notes: `Classification history from Holstein.ca${c.daysFresh ? ` (DIM ${c.daysFresh})` : ""}.`,
        },
      });
      for (const s of c.sections) {
        await prisma.classificationTraitValue.create({ data: { classificationId: rec.classificationId, traitCode: s.code, traitName: s.name, traitValue: s.value, displayOrder: 0 } });
      }
    }
  }
  return { classifications: profile.classifications.length, lactations: lactationsWritten };
}
