"use server";

import { prisma } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { hashPassword } from "@/lib/auth";
import { can, ROLES } from "@/lib/constants";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

function guard() {
  const user = currentUser();
  if (!can(user?.role, "config:write")) throw new Error("Not authorized");
  return user;
}
const b = (v: FormDataEntryValue | null) => String(v ?? "") === "on" || String(v ?? "") === "true" || String(v ?? "") === "1";
const n = (v: FormDataEntryValue | null) => { const s = String(v ?? "").trim(); return s === "" ? null : Number(s); };

// ---- Genetics Intelligence Agent -----------------------------------------
// Saves the Anthropic API key that turns the assistant live. The key is stored
// in EnvironmentConfig (server-read only) and never echoed back to the browser.
export async function saveAgentSettings(fd: FormData) {
  const user = guard();
  const key = String(fd.get("anthropicApiKey") ?? "").trim();
  const model = String(fd.get("model") ?? "").trim();

  if (key && key !== "__unchanged__") {
    if (key.length < 20) throw new Error("That does not look like a valid Anthropic API key.");
    await prisma.environmentConfig.upsert({
      where: { key: "agent.anthropicApiKey" },
      update: { value: key, notes: "Anthropic API key for the Genetics Intelligence Agent" },
      create: { key: "agent.anthropicApiKey", value: key, notes: "Anthropic API key for the Genetics Intelligence Agent" },
    });
    await audit(user, "config", "update", "agent.anthropicApiKey", { set: true });
  }
  if (model) {
    await prisma.environmentConfig.upsert({
      where: { key: "agent.model" }, update: { value: model }, create: { key: "agent.model", value: model, notes: "Model id for the Genetics Intelligence Agent" },
    });
  }
  revalidatePath("/admin");
}

// Clears the stored key — turns the assistant back off.
export async function clearAgentKey() {
  const user = guard();
  await prisma.environmentConfig.deleteMany({ where: { key: "agent.anthropicApiKey" } });
  await audit(user, "config", "update", "agent.anthropicApiKey", { cleared: true });
  revalidatePath("/admin");
}

// ---- Breeds -------------------------------------------------------------
export async function saveBreed(fd: FormData) {
  const user = guard();
  const breedId = String(fd.get("breedId") ?? "");
  const data = {
    breedCode: String(fd.get("breedCode") ?? "").trim().toUpperCase(),
    breedName: String(fd.get("breedName") ?? "").trim(),
    speciesType: String(fd.get("speciesType") ?? "dairy"),
    breedCategory: String(fd.get("breedCategory") ?? "").trim() || null,
    registryOrganization: String(fd.get("registryOrganization") ?? "").trim() || null,
    active: b(fd.get("active")),
    notes: String(fd.get("notes") ?? "").trim() || null,
  };
  if (!data.breedCode || !data.breedName) throw new Error("Breed code and name are required");
  if (breedId) await prisma.breed.update({ where: { breedId }, data });
  else await prisma.breed.create({ data });
  await audit(user, "breed", breedId ? "update" : "create", breedId || data.breedCode, data);
  revalidatePath("/breeds");
}

// ---- Traits -------------------------------------------------------------
export async function saveTrait(fd: FormData) {
  const user = guard();
  const traitId = String(fd.get("traitId") ?? "");
  const data = {
    traitCode: String(fd.get("traitCode") ?? "").trim().toUpperCase(),
    traitName: String(fd.get("traitName") ?? "").trim(),
    speciesType: String(fd.get("speciesType") ?? "dairy"),
    domain: String(fd.get("domain") ?? "genetic"),
    category: String(fd.get("category") ?? "").trim() || null,
    unit: String(fd.get("unit") ?? "").trim() || null,
    higherIsBetter: b(fd.get("higherIsBetter")),
    description: String(fd.get("description") ?? "").trim() || null,
    displayOrder: n(fd.get("displayOrder")) ?? 0,
    active: b(fd.get("active")),
  };
  if (!data.traitCode || !data.traitName) throw new Error("Trait code and name are required");
  if (traitId) await prisma.traitDefinition.update({ where: { traitId }, data });
  else await prisma.traitDefinition.create({ data });
  await audit(user, "trait_definition", traitId ? "update" : "create", traitId || data.traitCode, data);
  revalidatePath("/traits");
}

// ---- Sources ------------------------------------------------------------
export async function saveSource(fd: FormData) {
  const user = guard();
  const sourceId = String(fd.get("sourceId") ?? "");
  const data = {
    sourceName: String(fd.get("sourceName") ?? "").trim(),
    sourceType: String(fd.get("sourceType") ?? "manual"),
    baseUrl: String(fd.get("baseUrl") ?? "").trim() || null,
    defaultPriorityRank: n(fd.get("defaultPriorityRank")) ?? 50,
    active: b(fd.get("active")),
    notes: String(fd.get("notes") ?? "").trim() || null,
  };
  if (!data.sourceName) throw new Error("Source name is required");
  if (sourceId) await prisma.source.update({ where: { sourceId }, data });
  else await prisma.source.create({ data });
  await audit(user, "source", sourceId ? "update" : "create", sourceId || data.sourceName, data);
  revalidatePath("/sources");
}

// ---- Source priority rules ---------------------------------------------
export async function savePriorityRule(fd: FormData) {
  const user = guard();
  const ruleId = String(fd.get("ruleId") ?? "");
  const data = {
    dataDomain: String(fd.get("dataDomain") ?? "genetic_evaluation"),
    sourceId: String(fd.get("sourceId") ?? ""),
    priorityRank: n(fd.get("priorityRank")) ?? 99,
    breedId: String(fd.get("breedId") ?? "") || null,
    countrySystem: String(fd.get("countrySystem") ?? "").trim() || null,
    active: b(fd.get("active")),
  };
  if (!data.sourceId) throw new Error("Source is required");
  if (ruleId) await prisma.sourcePriorityRule.update({ where: { ruleId }, data });
  else await prisma.sourcePriorityRule.create({ data });
  await audit(user, "priority_rule", ruleId ? "update" : "create", ruleId, data);
  revalidatePath("/sources");
}

export async function deletePriorityRule(fd: FormData) {
  const user = guard();
  const ruleId = String(fd.get("ruleId"));
  await prisma.sourcePriorityRule.delete({ where: { ruleId } });
  await audit(user, "priority_rule", "delete", ruleId);
  revalidatePath("/sources");
}

// ---- Users --------------------------------------------------------------
export async function saveUser(fd: FormData) {
  const user = guard();
  const id = String(fd.get("id") ?? "");
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const name = String(fd.get("name") ?? "").trim();
  const role = String(fd.get("role") ?? "sales");
  if (!(role in ROLES)) throw new Error("Invalid role.");
  const active = b(fd.get("active"));
  const password = String(fd.get("password") ?? "");
  if (password && password.length < 8) throw new Error("Password must be at least 8 characters.");

  if (id) {
    const data: any = { name, role, active };
    if (password) data.passwordHash = hashPassword(password);
    await prisma.user.update({ where: { id }, data });
  } else {
    if (!email || !name || !password) throw new Error("Email, name, and password are required for a new user");
    await prisma.user.create({ data: { email, name, role, active, passwordHash: hashPassword(password) } });
  }
  await audit(user, "user", id ? "update" : "create", id || email, { email, name, role, active });
  revalidatePath("/admin/users");
}

// Remove a user account entirely. Guards against deleting your own login, and
// gives a clear message when the account owns records (FK) — deactivate instead.
export async function deleteUser(fd: FormData) {
  const user = guard();
  const id = String(fd.get("id") ?? "");
  if (!id) throw new Error("No user selected.");
  if (user?.uid === id) throw new Error("You can't remove the account you're signed in as.");
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return;
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    throw new Error("This user has linked records and can't be deleted. Set them inactive instead.");
  }
  await audit(user, "user", "delete", id, { email: target.email, name: target.name });
  revalidatePath("/admin/users");
}
