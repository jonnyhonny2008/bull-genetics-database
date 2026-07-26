"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { recomputePreferredForAnimal } from "@/lib/priority";
import { parseHolsteinAis, buildAisUrl } from "@/lib/holstein";
import { packTraits } from "@/lib/eval-traits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Parse a Holstein.ca AIS page the user pasted from their own signed-in session,
// then create/update the animal with a genomic evaluation, classification record,
// and pedigree. No automated fetch of Holstein.ca occurs.
export async function importHolsteinPaste(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized to import records.");

  const pasted = String(fd.get("pageText") ?? "").trim();
  const regInput = String(fd.get("regNo") ?? "").trim();
  const animalIdParam = String(fd.get("holsteinAnimalId") ?? "").trim();
  if (!pasted) throw new Error("Paste the Holstein.ca page content first.");

  const parsed = parseHolsteinAis(pasted);
  const regNo = parsed.regNo ?? regInput;
  if (!regNo) throw new Error("Could not find a registration number in the pasted page.");

  const holstein = await prisma.breed.findUnique({ where: { breedCode: "HO" } });
  const lactanet = await prisma.source.findUnique({ where: { sourceName: "LactanetGen" } });
  const holCanada = await prisma.source.findUnique({ where: { sourceName: "Holstein Canada" } });

  // A capture recording the pasted page.
  const capture = await prisma.sourceCapture.create({
    data: {
      sourceId: holCanada?.sourceId, captureType: "browser_lookup", sourceUrl: buildAisUrl(regNo, animalIdParam || undefined),
      capturedById: user?.uid, extractionStatus: "extracted", confidenceScore: 0.9,
      rawExtractedDataJson: JSON.stringify(parsed), notes: `Holstein.ca AIS paste for ${regNo}`,
    },
  });

  // Match or create the animal.
  const existing = await prisma.animalIdentifier.findFirst({ where: { idType: "registration_ca", idValue: regNo }, select: { animalId: true } });
  let animalId = existing?.animalId ?? null;
  const noteBits = [parsed.purity ? `Purity ${parsed.purity}` : null, parsed.herdNo ? `Herd #${parsed.herdNo}` : null, parsed.inbreeding != null ? `${parsed.inbreeding}%INB` : null, parsed.rValue != null ? `${parsed.rValue}%R` : null].filter(Boolean).join(" · ");

  if (!animalId) {
    const created = await prisma.animal.create({
      data: {
        primaryName: parsed.name ?? regNo, sex: parsed.sex, breedId: holstein?.breedId ?? null,
        birthDate: parsed.birthDate ? new Date(parsed.birthDate + "T00:00:00Z") : null,
        countryOfOrigin: "CA", currentStatus: "active", createdById: user?.uid,
        notes: `Imported from Holstein.ca (${regNo}). ${noteBits}`,
      },
    });
    animalId = created.id;
    await prisma.animalIdentifier.create({ data: { animalId, idType: "registration_ca", idValue: regNo, issuingCountry: "CA", issuingOrganization: "Holstein Canada", sourceId: holCanada?.sourceId, isPrimary: true } });
    if (parsed.nationalId) await prisma.animalIdentifier.create({ data: { animalId, idType: "breed_assoc", idValue: parsed.nationalId, issuingOrganization: "Holstein Canada", sourceId: holCanada?.sourceId } });
    await prisma.animalRole.create({ data: { animalId, roleType: parsed.sex === "M" ? "proven_bull" : "cow", active: true } });
    if (parsed.sex === "F") await prisma.animalRole.create({ data: { animalId, roleType: "dam", active: true } });
  }
  await prisma.sourceCapture.update({ where: { captureId: capture.captureId }, data: { animalId } });

  // --- Genomic evaluation (source = LactanetGen; CAN-GEBV surfaced on Holstein.ca) ---
  if (parsed.evaluation && parsed.traits.length) {
    const evExisting = await prisma.geneticEvaluation.findFirst({ where: { animalId, proofRun: parsed.evaluation.runLabel, sourceId: lactanet?.sourceId } });
    if (evExisting) await prisma.geneticEvaluation.delete({ where: { evaluationId: evExisting.evaluationId } });
    const extra = [
      { code: "A2", text: parsed.betaCasein }, { code: "COLOUR", text: parsed.colour },
    ].filter((x) => x.text).map((x) => ({ traitCode: x.code, numericValue: null, textValue: x.text!, reliability: null, percentileRank: null }));
    const packed = packTraits([...parsed.traits.map((t) => ({ traitCode: t.code, numericValue: t.numericValue, textValue: t.textValue, reliability: t.reliability, percentileRank: t.percentileRank })), ...extra]);
    await prisma.geneticEvaluation.create({
      data: {
        animalId, sourceId: lactanet?.sourceId, captureId: capture.captureId,
        evaluationDate: new Date(parsed.evaluation.runDate + "T00:00:00Z"), proofRun: parsed.evaluation.runLabel,
        countrySystem: "CA", breedContext: "Holstein", reliabilityOverall: parsed.evaluation.reliability,
        approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date(), createdById: user?.uid,
        notes: "Genomic evaluation captured from Holstein.ca.",
        traitsJson: packed.traitsJson, ...packed.columns,
      },
    });
  }

  // --- Classification (source = Holstein Canada) ---
  if (parsed.classification) {
    // Estimate classification date from age code (e.g. "2YR") applied to birth date.
    let clsDate = new Date();
    if (parsed.birthDate) {
      const ageYears = parseInt((parsed.classification.age ?? "").match(/(\d+)/)?.[1] ?? "2") || 2;
      clsDate = new Date(parsed.birthDate + "T00:00:00Z");
      clsDate.setUTCFullYear(clsDate.getUTCFullYear() + ageYears);
    }
    const exCls = await prisma.classificationRecord.findFirst({ where: { animalId, finalScore: parsed.classification.score, classificationCode: parsed.classification.code, sourceId: holCanada?.sourceId } });
    if (!exCls) {
      const cls = await prisma.classificationRecord.create({
        data: {
          animalId, sourceId: holCanada?.sourceId, captureId: capture.captureId, classificationDate: clsDate,
          ageAtClassification: parsed.classification.age, finalScore: parsed.classification.score, classificationCode: parsed.classification.code,
          approvalStatus: "approved", approvedById: user?.uid, approvedAt: new Date(), createdById: user?.uid,
          notes: "Classification captured from Holstein.ca.",
        },
      });
      for (const s of parsed.classificationSections) {
        await prisma.classificationTraitValue.create({ data: { classificationId: cls.classificationId, traitCode: s.code, traitName: s.name, traitValue: s.value, displayOrder: 0 } });
      }
    }
  }

  // --- Pedigree reference ---
  if (parsed.pedigree.length) {
    const summary = parsed.pedigree.map((p) => `${p.relation.toUpperCase()}: ${p.name ?? "?"}${p.reg ? ` (${p.reg})` : ""}`).join(" · ");
    await prisma.pedigreeReference.deleteMany({ where: { animalId, source: { sourceName: "Holstein Canada" } } });
    await prisma.pedigreeReference.create({ data: { animalId, sourceId: holCanada?.sourceId, sourceUrl: buildAisUrl(regNo, animalIdParam || undefined), displayStatus: "linked", lastCheckedAt: new Date(), notes: `Pedigree (Holstein.ca): ${summary}` } });
  }

  await recomputePreferredForAnimal(animalId);
  await audit(user, "animal", "import", animalId, { source: "Holstein.ca", regNo, traits: parsed.traits.length, warnings: parsed.warnings });

  revalidatePath("/animals");
  redirect(`/animals/${animalId}`);
}
