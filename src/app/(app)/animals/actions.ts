"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function parseDate(v: FormDataEntryValue | null): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

function collectIdentifiers(fd: FormData) {
  const types = fd.getAll("idType").map(String);
  const values = fd.getAll("idValue").map(String);
  const countries = fd.getAll("idCountry").map(String);
  const orgs = fd.getAll("idOrg").map(String);
  const srcs = fd.getAll("idSource").map(String);
  const primaryIndex = String(fd.get("primaryIndex") ?? "");
  const out: {
    idType: string; idValue: string; issuingCountry: string | null;
    issuingOrganization: string | null; sourceId: string | null; isPrimary: boolean;
  }[] = [];
  for (let i = 0; i < values.length; i++) {
    const val = (values[i] ?? "").trim();
    if (!val) continue;
    out.push({
      idType: types[i] || "internal_stud",
      idValue: val,
      issuingCountry: countries[i]?.trim() || null,
      issuingOrganization: orgs[i]?.trim() || null,
      sourceId: srcs[i] || null,
      isPrimary: String(i) === primaryIndex,
    });
  }
  // If nothing marked primary, make the first identifier primary.
  if (out.length && !out.some((o) => o.isPrimary)) out[0].isPrimary = true;
  return out;
}

export async function saveAnimal(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "animal:write")) throw new Error("Not authorized");

  const id = String(fd.get("id") ?? "").trim();
  const data = {
    primaryName: String(fd.get("primaryName") ?? "").trim(),
    shortName: String(fd.get("shortName") ?? "").trim() || null,
    sex: String(fd.get("sex") ?? "F"),
    breedId: String(fd.get("breedId") ?? "") || null,
    birthDate: parseDate(fd.get("birthDate")),
    countryOfOrigin: String(fd.get("countryOfOrigin") ?? "") || null,
    currentStatus: String(fd.get("currentStatus") ?? "active"),
    notes: String(fd.get("notes") ?? "").trim() || null,
  };
  if (!data.primaryName) throw new Error("Primary name is required");

  const identifiers = collectIdentifiers(fd);

  let animalId = id;
  if (id) {
    await prisma.animal.update({ where: { id }, data: { ...data, updatedById: user?.uid } });
    // Replace identifiers (simple, explicit editing model).
    //
    // AnimalRole is deliberately untouched. The hand-assigned 14-role vocabulary
    // was replaced by the derived sire roles (proven/genomic + active/inactive)
    // computed from the Lactanet proof codes in prisma/classify-sires.ts. Any
    // legacy rows are left alone rather than silently deleted on every save.
    await prisma.animalIdentifier.deleteMany({ where: { animalId: id } });
    await audit(user, "animal", "update", id, data);
  } else {
    const created = await prisma.animal.create({ data: { ...data, createdById: user?.uid } });
    animalId = created.id;
    await audit(user, "animal", "create", created.id, data);
  }

  for (const idf of identifiers) {
    await prisma.animalIdentifier.create({ data: { animalId, ...idf } });
  }
  revalidatePath("/animals");
  revalidatePath(`/animals/${animalId}`);
  redirect(`/animals/${animalId}`);
}

export async function archiveAnimal(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "animal:write")) throw new Error("Not authorized");
  const id = String(fd.get("id"));
  await prisma.animal.update({ where: { id }, data: { archived: true, currentStatus: "archived", updatedById: user?.uid } });
  await audit(user, "animal", "archive", id);
  revalidatePath("/animals");
  redirect("/animals");
}

export async function addNote(fd: FormData) {
  const user = currentUser();
  if (!can(user?.role, "animal:write")) throw new Error("Not authorized");
  const animalId = String(fd.get("animalId"));
  const body = String(fd.get("body") ?? "").trim();
  const noteType = String(fd.get("noteType") ?? "general");
  if (body) {
    await prisma.animalNote.create({ data: { animalId, body, noteType, createdById: user?.uid } });
    await audit(user, "animal_note", "create", animalId);
  }
  revalidatePath(`/animals/${animalId}`);
}
