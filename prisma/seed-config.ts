// ---------------------------------------------------------------------------
// CONFIG / REFERENCE SEED  —  runs for BOTH demo and production.
//
// Populates only reference/configuration data:
//   breeds, trait definitions, sources, source priority rules, roles,
//   status + animal-role vocabularies, environment marker, default admin user.
//
// It contains NO fake animals, proofs, milk, or classification data, so it is
// safe to run against production.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "./seed-utils";
import { HOLSTEIN_ALL_EXTRA } from "./traits-holstein";
import { SIRE_ROLES } from "../src/lib/sire-class";
import {
  ANIMAL_STATUSES,
  ID_TYPES,
  APPROVAL_STATUSES,
  REVIEW_STATUSES,
  COUNTRIES,
} from "../src/lib/constants";

const prisma = new PrismaClient();

const APP_ENV = process.env.APP_ENV === "production" ? "production" : "demo";

// --- Breeds ---------------------------------------------------------------
const BREEDS = [
  { breedCode: "HO", breedName: "Holstein", speciesType: "dairy", breedCategory: "Dairy cattle", registryOrganization: "Holstein Canada" },
  { breedCode: "JE", breedName: "Jersey", speciesType: "dairy", breedCategory: "Dairy cattle", registryOrganization: "Jersey Canada" },
  { breedCode: "AY", breedName: "Ayrshire", speciesType: "dairy", breedCategory: "Dairy cattle", registryOrganization: "Ayrshire Canada" },
  { breedCode: "BS", breedName: "Brown Swiss", speciesType: "dairy", breedCategory: "Dairy cattle", registryOrganization: "Brown Swiss Canada" },
  { breedCode: "MS", breedName: "Milking Shorthorn", speciesType: "dairy", breedCategory: "Dairy cattle", registryOrganization: "Canadian Milking Shorthorn Society" },
  { breedCode: "AN", breedName: "Angus", speciesType: "beef", breedCategory: "Beef cattle", registryOrganization: "Canadian Angus Association" },
];

// --- Sources --------------------------------------------------------------
const SOURCES = [
  { sourceName: "LactanetGen", sourceType: "official_portal", baseUrl: "https://lactanetgen.ca", defaultPriorityRank: 5, notes: "Official Canadian genetic evaluation portal. Link/reference + uploads only — no API, no scraping." },
  { sourceName: "Holstein Canada", sourceType: "official_portal", baseUrl: "https://holstein.ca", defaultPriorityRank: 5, notes: "Official Holstein Canada portal for classification & production. Link/reference + uploads only." },
  { sourceName: "Official Uploaded Genetic Proof File", sourceType: "uploaded_report", defaultPriorityRank: 10, notes: "Official proof file uploaded by staff." },
  { sourceName: "Official Uploaded Classification Report", sourceType: "uploaded_report", defaultPriorityRank: 10, notes: "Official classification report uploaded by staff." },
  { sourceName: "Official Uploaded Production Report", sourceType: "uploaded_report", defaultPriorityRank: 10, notes: "Official production / milk report uploaded by staff." },
  { sourceName: "Breed Association Record", sourceType: "registry", defaultPriorityRank: 15, notes: "Breed association / registry record." },
  { sourceName: "Manual Entry", sourceType: "manual", defaultPriorityRank: 30, notes: "Approved manual data entry by staff." },
  { sourceName: "AI Extracted PDF/Screenshot", sourceType: "ai_extraction", defaultPriorityRank: 40, notes: "Value extracted from PDF/screenshot/catalogue (placeholder workflow)." },
  { sourceName: "Catalogue PDF", sourceType: "catalogue", defaultPriorityRank: 45, notes: "Marketing catalogue PDF." },
];

// --- Source priority rules (per spec) -------------------------------------
// rank 1 = most preferred.
const PRIORITY_RULES: { dataDomain: string; sourceName: string; rank: number }[] = [
  // Genetic evaluations
  { dataDomain: "genetic_evaluation", sourceName: "LactanetGen", rank: 1 },
  { dataDomain: "genetic_evaluation", sourceName: "Official Uploaded Genetic Proof File", rank: 2 },
  { dataDomain: "genetic_evaluation", sourceName: "Breed Association Record", rank: 3 },
  { dataDomain: "genetic_evaluation", sourceName: "Manual Entry", rank: 4 },
  { dataDomain: "genetic_evaluation", sourceName: "AI Extracted PDF/Screenshot", rank: 5 },
  { dataDomain: "genetic_evaluation", sourceName: "Catalogue PDF", rank: 6 },
  // Classification (Holstein-style)
  { dataDomain: "classification", sourceName: "Holstein Canada", rank: 1 },
  { dataDomain: "classification", sourceName: "Official Uploaded Classification Report", rank: 2 },
  { dataDomain: "classification", sourceName: "Manual Entry", rank: 3 },
  { dataDomain: "classification", sourceName: "AI Extracted PDF/Screenshot", rank: 4 },
  // Milk records
  { dataDomain: "milk_record", sourceName: "Holstein Canada", rank: 1 },
  { dataDomain: "milk_record", sourceName: "Official Uploaded Production Report", rank: 2 },
  { dataDomain: "milk_record", sourceName: "Manual Entry", rank: 3 },
  { dataDomain: "milk_record", sourceName: "AI Extracted PDF/Screenshot", rank: 4 },
  // Animal identity
  { dataDomain: "animal_identity", sourceName: "Breed Association Record", rank: 1 },
  { dataDomain: "animal_identity", sourceName: "Holstein Canada", rank: 2 },
  { dataDomain: "animal_identity", sourceName: "LactanetGen", rank: 3 },
  { dataDomain: "animal_identity", sourceName: "Official Uploaded Genetic Proof File", rank: 4 },
  { dataDomain: "animal_identity", sourceName: "Manual Entry", rank: 5 },
  { dataDomain: "animal_identity", sourceName: "AI Extracted PDF/Screenshot", rank: 6 },
  // Pedigree display
  { dataDomain: "pedigree_display", sourceName: "Breed Association Record", rank: 1 },
  { dataDomain: "pedigree_display", sourceName: "Holstein Canada", rank: 2 },
  { dataDomain: "pedigree_display", sourceName: "LactanetGen", rank: 3 },
  { dataDomain: "pedigree_display", sourceName: "Official Uploaded Classification Report", rank: 4 },
  { dataDomain: "pedigree_display", sourceName: "Manual Entry", rank: 5 },
];

// --- Trait definitions ----------------------------------------------------
type TD = { traitCode: string; traitName: string; speciesType: string; domain?: string; category: string; unit?: string; higherIsBetter?: boolean; displayOrder: number };

const DAIRY_GENETIC: TD[] = [
  { traitCode: "LPI", traitName: "LPI", speciesType: "dairy", category: "Index", displayOrder: 1 },
  { traitCode: "PRO$", traitName: "Pro$", speciesType: "dairy", category: "Index", unit: "$", displayOrder: 2 },
  { traitCode: "MILK", traitName: "Milk", speciesType: "dairy", category: "Production", unit: "kg", displayOrder: 10 },
  { traitCode: "FAT", traitName: "Fat", speciesType: "dairy", category: "Production", unit: "kg", displayOrder: 11 },
  { traitCode: "PROT", traitName: "Protein", speciesType: "dairy", category: "Production", unit: "kg", displayOrder: 12 },
  { traitCode: "FATPCT", traitName: "Fat %", speciesType: "dairy", category: "Production", unit: "%", displayOrder: 13 },
  { traitCode: "PROTPCT", traitName: "Protein %", speciesType: "dairy", category: "Production", unit: "%", displayOrder: 14 },
  { traitCode: "CONF", traitName: "Conformation", speciesType: "dairy", category: "Type", displayOrder: 20 },
  { traitCode: "MAMM", traitName: "Mammary System", speciesType: "dairy", category: "Type", displayOrder: 21 },
  { traitCode: "FL", traitName: "Feet & Legs", speciesType: "dairy", category: "Type", displayOrder: 22 },
  { traitCode: "DS", traitName: "Dairy Strength", speciesType: "dairy", category: "Type", displayOrder: 23 },
  { traitCode: "RUMP", traitName: "Rump", speciesType: "dairy", category: "Type", displayOrder: 24 },
  { traitCode: "HL", traitName: "Herd Life", speciesType: "dairy", category: "Health", displayOrder: 30 },
  { traitCode: "DF", traitName: "Daughter Fertility", speciesType: "dairy", category: "Fertility", displayOrder: 31 },
  { traitCode: "MR", traitName: "Mastitis Resistance", speciesType: "dairy", category: "Health", displayOrder: 32 },
  { traitCode: "MDR", traitName: "Metabolic Disease Resistance", speciesType: "dairy", category: "Health", displayOrder: 33 },
  { traitCode: "MSPD", traitName: "Milking Speed", speciesType: "dairy", category: "Workability", displayOrder: 34 },
  { traitCode: "MTMP", traitName: "Milking Temperament", speciesType: "dairy", category: "Workability", displayOrder: 35 },
  { traitCode: "CA", traitName: "Calving Ability", speciesType: "dairy", category: "Health", displayOrder: 36 },
  { traitCode: "DCA", traitName: "Daughter Calving Ability", speciesType: "dairy", category: "Health", displayOrder: 37 },
  { traitCode: "SCS", traitName: "Somatic Cell Score", speciesType: "dairy", category: "Health", higherIsBetter: false, displayOrder: 38 },
  { traitCode: "LP", traitName: "Lactation Persistency", speciesType: "dairy", category: "Production", displayOrder: 39 },
  { traitCode: "FE", traitName: "Feed Efficiency", speciesType: "dairy", category: "Efficiency", displayOrder: 40 },
  { traitCode: "METH", traitName: "Methane Efficiency", speciesType: "dairy", category: "Environmental", displayOrder: 41 },
];

const BEEF_GENETIC: TD[] = [
  { traitCode: "CE", traitName: "Calving Ease", speciesType: "beef", category: "Calving", displayOrder: 1 },
  { traitCode: "BW", traitName: "Birth Weight", speciesType: "beef", category: "Growth", unit: "lb", higherIsBetter: false, displayOrder: 2 },
  { traitCode: "WW", traitName: "Weaning Weight", speciesType: "beef", category: "Growth", unit: "lb", displayOrder: 3 },
  { traitCode: "YW", traitName: "Yearling Weight", speciesType: "beef", category: "Growth", unit: "lb", displayOrder: 4 },
  { traitCode: "GL", traitName: "Gestation Length", speciesType: "beef", category: "Calving", unit: "d", higherIsBetter: false, displayOrder: 5 },
  { traitCode: "MARB", traitName: "Marbling", speciesType: "beef", category: "Carcass", displayOrder: 6 },
  { traitCode: "REA", traitName: "Ribeye Area", speciesType: "beef", category: "Carcass", unit: "sq in", displayOrder: 7 },
  { traitCode: "CW", traitName: "Carcass Weight", speciesType: "beef", category: "Carcass", unit: "lb", displayOrder: 8 },
  { traitCode: "FT", traitName: "Fat Thickness", speciesType: "beef", category: "Carcass", unit: "in", higherIsBetter: false, displayOrder: 9 },
  { traitCode: "TEND", traitName: "Tenderness", speciesType: "beef", category: "Carcass", displayOrder: 10 },
  { traitCode: "BOD", traitName: "Beef-on-Dairy Suitability", speciesType: "beef", category: "Index", displayOrder: 11 },
  { traitCode: "COAT", traitName: "Coat Colour", speciesType: "beef", category: "Descriptive", displayOrder: 12 },
  { traitCode: "POLL", traitName: "Polled Status", speciesType: "beef", category: "Descriptive", displayOrder: 13 },
];

const CLASSIFICATION_TRAITS: TD[] = [
  { traitCode: "FINAL", traitName: "Final Score", speciesType: "both", domain: "classification", category: "Overall", displayOrder: 1 },
  { traitCode: "C_MAMM", traitName: "Mammary System", speciesType: "both", domain: "classification", category: "Section", displayOrder: 2 },
  { traitCode: "C_FL", traitName: "Feet & Legs", speciesType: "both", domain: "classification", category: "Section", displayOrder: 3 },
  { traitCode: "C_DS", traitName: "Dairy Strength", speciesType: "both", domain: "classification", category: "Section", displayOrder: 4 },
  { traitCode: "C_RUMP", traitName: "Rump", speciesType: "both", domain: "classification", category: "Section", displayOrder: 5 },
  { traitCode: "C_FRAME", traitName: "Frame / Capacity", speciesType: "both", domain: "classification", category: "Section", displayOrder: 6 },
  { traitCode: "C_GA", traitName: "General Appearance", speciesType: "both", domain: "classification", category: "Section", displayOrder: 7 },
  { traitCode: "L_STAT", traitName: "Stature (linear)", speciesType: "both", domain: "classification", category: "Linear", displayOrder: 20 },
  { traitCode: "L_UDEPTH", traitName: "Udder Depth (linear)", speciesType: "both", domain: "classification", category: "Linear", displayOrder: 21 },
  { traitCode: "L_TEAT", traitName: "Teat Placement (linear)", speciesType: "both", domain: "classification", category: "Linear", displayOrder: 22 },
];

async function main() {
  console.log(`[seed-config] APP_ENV=${APP_ENV}`);

  // Environment marker
  await prisma.environmentConfig.upsert({
    where: { key: "APP_ENV" },
    update: { value: APP_ENV },
    create: { key: "APP_ENV", value: APP_ENV, notes: "Environment marker" },
  });
  await prisma.environmentConfig.upsert({
    where: { key: "PHASE" },
    update: { value: "1 — Historical Genetic Proof Database" },
    create: { key: "PHASE", value: "1 — Historical Genetic Proof Database" },
  });

  // Roles (reference)
  const ROLE_ROWS = [
    { roleKey: "admin", roleName: "Admin", description: "Full access: create, edit, archive, approve, import, configure, manage users/breeds/traits/sources/rules.", displayOrder: 1 },
    { roleKey: "staff", roleName: "Staff", description: "Create/edit animals, upload source files, enter manual records, submit for review.", displayOrder: 2 },
    { roleKey: "sales", roleName: "Sales", description: "Search animals, view profiles, compare. Read-only on approved core data.", displayOrder: 3 },
    { roleKey: "consultant", roleName: "Genetic Consultant", description: "Deep search/filter, compare, view full proof/milk/classification/source history.", displayOrder: 4 },
  ];
  for (const r of ROLE_ROWS) {
    await prisma.role.upsert({ where: { roleKey: r.roleKey }, update: r, create: r });
  }

  // Vocabulary (ConfigValue): statuses, animal-roles, id types, approval/review statuses, countries
  const vocab: { category: string; code: string; label: string; displayOrder: number }[] = [];
  ANIMAL_STATUSES.forEach((x, i) => vocab.push({ category: "animal_status", code: x.code, label: x.label, displayOrder: i }));
  // The old hand-assigned animal_role vocabulary is retired; the four derived
  // sire roles take its place. Legacy animal_role ConfigValue rows are left
  // alone rather than deleted.
  SIRE_ROLES.forEach((x, i) => vocab.push({ category: "sire_role", code: x.code, label: x.label, displayOrder: i }));
  ID_TYPES.forEach((x, i) => vocab.push({ category: "id_type", code: x.code, label: x.label, displayOrder: i }));
  APPROVAL_STATUSES.forEach((x, i) => vocab.push({ category: "approval_status", code: x.code, label: x.label, displayOrder: i }));
  REVIEW_STATUSES.forEach((x, i) => vocab.push({ category: "review_status", code: x.code, label: x.label, displayOrder: i }));
  COUNTRIES.forEach((x, i) => vocab.push({ category: "country", code: x.code, label: x.label, displayOrder: i }));
  for (const v of vocab) {
    await prisma.configValue.upsert({
      where: { category_code: { category: v.category, code: v.code } },
      update: { label: v.label, displayOrder: v.displayOrder },
      create: v,
    });
  }

  // Breeds
  for (const b of BREEDS) {
    await prisma.breed.upsert({ where: { breedCode: b.breedCode }, update: b, create: b });
  }

  // Trait definitions
  const allTraits = [
    ...DAIRY_GENETIC.map((t) => ({ ...t, domain: "genetic" as const })),
    ...BEEF_GENETIC.map((t) => ({ ...t, domain: "genetic" as const })),
    ...CLASSIFICATION_TRAITS,
  ];
  for (const t of allTraits) {
    const domain = t.domain ?? "genetic";
    await prisma.traitDefinition.upsert({
      where: { traitCode_domain: { traitCode: t.traitCode, domain } },
      update: {
        traitName: t.traitName, speciesType: t.speciesType, category: t.category,
        unit: t.unit ?? null, higherIsBetter: t.higherIsBetter ?? true, displayOrder: t.displayOrder,
      },
      create: {
        traitCode: t.traitCode, traitName: t.traitName, speciesType: t.speciesType, domain,
        category: t.category, unit: t.unit ?? null, higherIsBetter: t.higherIsBetter ?? true, displayOrder: t.displayOrder,
      },
    });
  }

  // Extended Holstein genetic traits (indexes, functional, and LINEAR type traits).
  for (const t of HOLSTEIN_ALL_EXTRA) {
    await prisma.traitDefinition.upsert({
      where: { traitCode_domain: { traitCode: t.traitCode, domain: "genetic" } },
      update: {
        traitName: t.traitName, speciesType: "dairy", category: t.category ?? null,
        unit: t.unit ?? null, higherIsBetter: t.higherIsBetter ?? true, displayOrder: t.displayOrder,
        isLinear: t.isLinear ?? false, graphMin: t.graphMin ?? null, graphMax: t.graphMax ?? null,
        leftLabel: t.leftLabel ?? null, rightLabel: t.rightLabel ?? null, graphGroup: t.graphGroup ?? null,
      },
      create: {
        traitCode: t.traitCode, traitName: t.traitName, speciesType: "dairy", domain: "genetic",
        category: t.category, unit: t.unit ?? null, higherIsBetter: t.higherIsBetter ?? true, displayOrder: t.displayOrder,
        isLinear: t.isLinear ?? false, graphMin: t.graphMin ?? null, graphMax: t.graphMax ?? null,
        leftLabel: t.leftLabel ?? null, rightLabel: t.rightLabel ?? null, graphGroup: t.graphGroup ?? null,
      },
    });
  }

  // Sources
  for (const s of SOURCES) {
    await prisma.source.upsert({ where: { sourceName: s.sourceName }, update: s, create: s });
  }

  // Source priority rules — rebuild cleanly each run (no inbound FKs).
  await prisma.sourcePriorityRule.deleteMany({});
  const sourcesByName = new Map((await prisma.source.findMany()).map((s) => [s.sourceName, s.sourceId]));
  for (const r of PRIORITY_RULES) {
    const sourceId = sourcesByName.get(r.sourceName);
    if (!sourceId) continue;
    await prisma.sourcePriorityRule.create({
      data: { dataDomain: r.dataDomain, sourceId, priorityRank: r.rank, active: true },
    });
  }

  // Default admin user (needed so production has a working login).
  const adminEmail = "admin@studgenetics.local";
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: "System Administrator",
        role: "admin",
        passwordHash: hashPassword("Admin#12345"),
      },
    });
    console.log(`[seed-config] created default admin: ${adminEmail} / Admin#12345 (CHANGE THIS)`);
  }

  await prisma.auditLog.create({
    data: { entityType: "system", action: "seed", notes: `Config seed applied (APP_ENV=${APP_ENV})` },
  });

  console.log(`[seed-config] done — breeds:${BREEDS.length} sources:${SOURCES.length} traits:${allTraits.length} rules:${PRIORITY_RULES.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
