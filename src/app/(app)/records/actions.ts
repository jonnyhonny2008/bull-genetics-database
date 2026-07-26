"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { recomputePreferredForAnimal } from "@/lib/priority";
import { packTraits, type RawTrait } from "@/lib/eval-traits";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function num(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}
function date(v: FormDataEntryValue | null): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

// ---- Genetic proof ------------------------------------------------------
export async function saveProof(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  const animalId = String(fd.get("animalId"));
  const evaluationDate = date(fd.get("evaluationDate")) ?? new Date();
  const approvalStatus = String(fd.get("approvalStatus") ?? "approved");

  // Trait values come in as trait_<CODE> fields → pack into JSON + columns.
  const traits: RawTrait[] = [];
  for (const [key, raw] of fd.entries()) {
    if (!key.startsWith("trait_")) continue;
    const val = String(raw).trim();
    if (val === "") continue;
    const asNum = Number(val);
    traits.push({ traitCode: key.slice("trait_".length), numericValue: isNaN(asNum) ? null : asNum, textValue: isNaN(asNum) ? val : null, reliability: null, percentileRank: null });
  }
  const packed = packTraits(traits);

  const evalRec = await prisma.geneticEvaluation.create({
    data: {
      animalId,
      sourceId: String(fd.get("sourceId") ?? "") || null,
      evaluationDate,
      proofRun: String(fd.get("proofRun") ?? "").trim() || null,
      countrySystem: String(fd.get("countrySystem") ?? "") || null,
      reliabilityOverall: num(fd.get("reliability")),
      approvalStatus,
      approvedById: approvalStatus === "approved" ? user?.uid : null,
      approvedAt: approvalStatus === "approved" ? new Date() : null,
      createdById: user?.uid,
      notes: String(fd.get("notes") ?? "").trim() || null,
      traitsJson: packed.traitsJson,
      ...packed.columns,
    },
  });

  await recomputePreferredForAnimal(animalId);
  await audit(user, "genetic_evaluation", "create", evalRec.evaluationId, { animalId, evaluationDate });
  revalidatePath(`/animals/${animalId}`);
  redirect(`/animals/${animalId}`);
}

// ---- Milk record --------------------------------------------------------
export async function saveMilk(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  const animalId = String(fd.get("animalId"));
  const approvalStatus = String(fd.get("approvalStatus") ?? "approved");
  const rec = await prisma.milkRecord.create({
    data: {
      animalId,
      sourceId: String(fd.get("sourceId") ?? "") || null,
      recordDate: date(fd.get("recordDate")) ?? new Date(),
      lactationNumber: num(fd.get("lactationNumber")),
      calvingDate: date(fd.get("calvingDate")),
      daysInMilk: num(fd.get("daysInMilk")),
      milkAmount: num(fd.get("milkAmount")),
      milkUnit: String(fd.get("milkUnit") ?? "kg"),
      fatAmount: num(fd.get("fatAmount")),
      fatPercent: num(fd.get("fatPercent")),
      proteinAmount: num(fd.get("proteinAmount")),
      proteinPercent: num(fd.get("proteinPercent")),
      recordType: String(fd.get("recordType") ?? "") || null,
      completionStatus: String(fd.get("completionStatus") ?? "") || null,
      approvalStatus,
      approvedById: approvalStatus === "approved" ? user?.uid : null,
      approvedAt: approvalStatus === "approved" ? new Date() : null,
      createdById: user?.uid,
      notes: String(fd.get("notes") ?? "").trim() || null,
    },
  });
  await recomputePreferredForAnimal(animalId);
  await audit(user, "milk_record", "create", rec.milkRecordId, { animalId });
  revalidatePath(`/animals/${animalId}`);
  redirect(`/animals/${animalId}`);
}

// ---- Classification record ---------------------------------------------
export async function saveClassification(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "record:write")) throw new Error("Not authorized");
  const animalId = String(fd.get("animalId"));
  const approvalStatus = String(fd.get("approvalStatus") ?? "approved");
  const rec = await prisma.classificationRecord.create({
    data: {
      animalId,
      sourceId: String(fd.get("sourceId") ?? "") || null,
      classificationDate: date(fd.get("classificationDate")) ?? new Date(),
      lactationNumber: num(fd.get("lactationNumber")),
      ageAtClassification: String(fd.get("ageAtClassification") ?? "").trim() || null,
      finalScore: num(fd.get("finalScore")),
      classificationCode: String(fd.get("classificationCode") ?? "").trim() || null,
      approvalStatus,
      approvedById: approvalStatus === "approved" ? user?.uid : null,
      approvedAt: approvalStatus === "approved" ? new Date() : null,
      createdById: user?.uid,
      notes: String(fd.get("notes") ?? "").trim() || null,
    },
  });

  const defs = new Map((await prisma.traitDefinition.findMany({ where: { domain: "classification" } })).map((t) => [t.traitCode, t]));
  for (const [key, raw] of fd.entries()) {
    if (!key.startsWith("ctrait_")) continue;
    const val = String(raw).trim();
    if (val === "") continue;
    const code = key.slice("ctrait_".length);
    const def = defs.get(code);
    await prisma.classificationTraitValue.create({
      data: { classificationId: rec.classificationId, traitCode: code, traitName: def?.traitName ?? code, traitValue: val, displayOrder: def?.displayOrder ?? 0 },
    });
  }

  await recomputePreferredForAnimal(animalId);
  await audit(user, "classification", "create", rec.classificationId, { animalId });
  revalidatePath(`/animals/${animalId}`);
  redirect(`/animals/${animalId}`);
}
