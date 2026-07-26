// ---------------------------------------------------------------------------
// DEMO SEED  —  runs for the DEMO environment ONLY.
//
// HARD GUARD: refuses to run when APP_ENV=production, so fake animals can never
// contaminate production data.
//
// Creates realistic fake animals across multiple breeds (dairy + Angus/beef),
// with multiple identifiers/roles, historical proofs, milk & classification
// records, a conflicting-source example, a possible-duplicate pair, source
// captures, and pending review-queue items. Assumes the config seed already ran.
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { hashPassword, iso } from "./seed-utils";
import { packTraits } from "../src/lib/eval-traits";

const prisma = new PrismaClient();
const APP_ENV = process.env.APP_ENV === "production" ? "production" : "demo";

if (APP_ENV === "production") {
  console.error("[seed-demo] REFUSING to seed demo animals into PRODUCTION. Aborting.");
  process.exit(1);
}

async function main() {
  console.log("[seed-demo] seeding demo animals…");

  // Clean out any previous demo animal data (keep config/reference data intact).
  await prisma.importReviewQueue.deleteMany({});
  await prisma.fileAttachment.deleteMany({});
  await prisma.sourceCapture.deleteMany({});
  await prisma.geneticEvaluation.deleteMany({});
  await prisma.classificationTraitValue.deleteMany({});
  await prisma.classificationRecord.deleteMany({});
  await prisma.milkRecord.deleteMany({});
  await prisma.animalNote.deleteMany({});
  await prisma.pedigreeReference.deleteMany({});
  await prisma.pedigreeIndexResult.deleteMany({});
  await prisma.animalIdentifier.deleteMany({});
  await prisma.animalRole.deleteMany({});
  await prisma.animal.deleteMany({});

  // ---- Lookups -----------------------------------------------------------
  const breeds = new Map((await prisma.breed.findMany()).map((b) => [b.breedCode, b]));
  const sources = new Map((await prisma.source.findMany()).map((s) => [s.sourceName, s]));
  const geneticTraits = new Map(
    (await prisma.traitDefinition.findMany({ where: { domain: "genetic" } })).map((t) => [t.traitCode, t]),
  );
  const classTraits = new Map(
    (await prisma.traitDefinition.findMany({ where: { domain: "classification" } })).map((t) => [t.traitCode, t]),
  );

  const S = (name: string) => sources.get(name)!.sourceId;
  const B = (code: string) => breeds.get(code)!.breedId;

  // ---- Demo users (per role) --------------------------------------------
  const demoUsers = [
    { email: "staff@studgenetics.local", name: "Sam Staff", role: "staff", pw: "Staff#12345" },
    { email: "sales@studgenetics.local", name: "Riley Sales", role: "sales", pw: "Sales#12345" },
    { email: "consultant@studgenetics.local", name: "Dr. Gene Consultant", role: "consultant", pw: "Consult#12345" },
  ];
  for (const u of demoUsers) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (!existing) {
      await prisma.user.create({
        data: { email: u.email, name: u.name, role: u.role, passwordHash: hashPassword(u.pw) },
      });
    }
  }
  const adminId = (await prisma.user.findFirst({ where: { role: "admin" } }))?.id ?? null;

  // ---- Helpers -----------------------------------------------------------
  async function createAnimal(data: {
    primaryName: string; shortName?: string; sex: string; breedCode?: string;
    birthDate?: string; country?: string; status?: string; notes?: string;
    roles?: string[];
    identifiers?: { idType: string; idValue: string; sourceName?: string; country?: string; org?: string; primary?: boolean }[];
  }) {
    const animal = await prisma.animal.create({
      data: {
        primaryName: data.primaryName,
        shortName: data.shortName,
        sex: data.sex,
        breedId: data.breedCode ? B(data.breedCode) : null,
        birthDate: data.birthDate ? iso(data.birthDate) : null,
        countryOfOrigin: data.country ?? "CA",
        currentStatus: data.status ?? "active",
        notes: data.notes,
        createdById: adminId,
      },
    });
    for (const r of data.roles ?? []) {
      await prisma.animalRole.create({ data: { animalId: animal.id, roleType: r, active: true, startDate: data.birthDate ? iso(data.birthDate) : null } });
    }
    for (const id of data.identifiers ?? []) {
      await prisma.animalIdentifier.create({
        data: {
          animalId: animal.id, idType: id.idType, idValue: id.idValue,
          issuingCountry: id.country, issuingOrganization: id.org,
          sourceId: id.sourceName ? S(id.sourceName) : null,
          isPrimary: id.primary ?? false,
        },
      });
    }
    return animal;
  }

  async function addProof(animalId: string, o: {
    date: string; run: string; sourceName: string; country?: string; rel?: number;
    preferred?: boolean; approval?: string; notes?: string;
    traits: Record<string, number | string>;
  }) {
    const packed = packTraits(Object.entries(o.traits).map(([code, value]) => ({
      traitCode: code,
      numericValue: typeof value === "number" ? value : null,
      textValue: typeof value === "string" ? value : null,
      reliability: null, percentileRank: null,
    })));
    const evalRec = await prisma.geneticEvaluation.create({
      data: {
        animalId, sourceId: S(o.sourceName), evaluationDate: iso(o.date), proofRun: o.run,
        countrySystem: o.country ?? "CA", reliabilityOverall: o.rel ?? null,
        isPreferred: o.preferred ?? false, approvalStatus: o.approval ?? "approved",
        approvedById: adminId, approvedAt: iso(o.date), createdById: adminId, notes: o.notes,
        traitsJson: packed.traitsJson, ...packed.columns,
      },
    });
    return evalRec;
  }

  async function addMilk(animalId: string, o: {
    date: string; sourceName: string; lactation: number; calving?: string; dim?: number;
    milk: number; fat: number; fatPct: number; protein: number; protPct: number;
    recordType?: string; preferred?: boolean; approval?: string;
  }) {
    return prisma.milkRecord.create({
      data: {
        animalId, sourceId: S(o.sourceName), recordDate: iso(o.date), lactationNumber: o.lactation,
        calvingDate: o.calving ? iso(o.calving) : null, daysInMilk: o.dim ?? 305,
        milkAmount: o.milk, milkUnit: "kg", fatAmount: o.fat, fatPercent: o.fatPct,
        proteinAmount: o.protein, proteinPercent: o.protPct, recordType: o.recordType ?? "305d",
        completionStatus: "complete", isPreferred: o.preferred ?? false,
        approvalStatus: o.approval ?? "approved", approvedById: adminId, approvedAt: iso(o.date), createdById: adminId,
      },
    });
  }

  async function addClassification(animalId: string, o: {
    date: string; sourceName: string; lactation?: number; age?: string; final: number; code: string;
    preferred?: boolean; approval?: string; traits: Record<string, string | number>;
  }) {
    const rec = await prisma.classificationRecord.create({
      data: {
        animalId, sourceId: S(o.sourceName), classificationDate: iso(o.date),
        lactationNumber: o.lactation ?? null, ageAtClassification: o.age ?? null,
        finalScore: o.final, classificationCode: o.code, isPreferred: o.preferred ?? false,
        approvalStatus: o.approval ?? "approved", approvedById: adminId, approvedAt: iso(o.date), createdById: adminId,
      },
    });
    for (const [code, value] of Object.entries(o.traits)) {
      const def = classTraits.get(code);
      await prisma.classificationTraitValue.create({
        data: {
          classificationId: rec.classificationId, traitCode: code,
          traitName: def?.traitName ?? code, traitValue: String(value), displayOrder: def?.displayOrder ?? 0,
        },
      });
    }
    return rec;
  }

  async function addPedigree(animalId: string, sourceName: string, url: string, status = "linked") {
    await prisma.pedigreeReference.create({
      data: { animalId, sourceId: S(sourceName), sourceUrl: url, displayStatus: status, lastCheckedAt: iso("2026-06-01"),
        notes: "Pedigree displayed from official source (link/reference only — Phase 1)." },
    });
  }
  async function addNote(animalId: string, body: string, type = "general") {
    await prisma.animalNote.create({ data: { animalId, body, noteType: type, createdById: adminId } });
  }

  // =======================================================================
  // 1) Holstein active stud bull — multiple identifiers + multiple proofs
  // =======================================================================
  const thunder = await createAnimal({
    primaryName: "MAPLE-CREST THUNDER", shortName: "Thunder", sex: "M", breedCode: "HO",
    birthDate: "2021-03-14", country: "CA", status: "proven",
    notes: "Flagship active stud bull. High LPI with strong type and health.",
    roles: ["active_stud_bull", "proven_bull", "reference_sire"],
    identifiers: [
      { idType: "registration_ca", idValue: "HOCAN0109876543", sourceName: "Holstein Canada", country: "CA", org: "Holstein Canada", primary: true },
      { idType: "naab", idValue: "007HO16123", sourceName: "Breed Association Record", country: "CA" },
      { idType: "semen_code", idValue: "MC-THUNDER", sourceName: "Manual Entry" },
      { idType: "internal_stud", idValue: "BS-0001", sourceName: "Manual Entry" },
      { idType: "lactanetgen", idValue: "LG-THUNDER-01", sourceName: "LactanetGen" },
    ],
  });
  await addProof(thunder.id, {
    date: "2025-12-01", run: "December 2025", sourceName: "LactanetGen", rel: 0.91,
    traits: { LPI: 3380, "PRO$": 2650, MILK: 1450, FAT: 82, PROT: 61, FATPCT: 0.28, PROTPCT: 0.15, CONF: 12, MAMM: 14, FL: 11, DS: 10, HL: 108, DF: 104, MR: 106, SCS: 2.75, MSPD: 103, LP: 105, FE: 102, METH: 101 },
  });
  await addProof(thunder.id, {
    date: "2026-04-01", run: "April 2026", sourceName: "LactanetGen", rel: 0.94, preferred: true,
    notes: "Latest official proof run.",
    traits: { LPI: 3500, "PRO$": 2780, MILK: 1520, FAT: 88, PROT: 65, FATPCT: 0.30, PROTPCT: 0.16, CONF: 13, MAMM: 15, FL: 12, DS: 11, RUMP: 8, HL: 110, DF: 106, MR: 108, MDR: 104, SCS: 2.70, MSPD: 104, MTMP: 103, CA: 105, DCA: 104, LP: 106, FE: 103, METH: 102 },
  });
  await addPedigree(thunder.id, "Holstein Canada", "https://www.holstein.ca/PublicContent/AnimalProfile?id=HOCAN0109876543");
  await addNote(thunder.id, "Primary marketing bull for 2026. Semen available.", "general");
  await prisma.pedigreeIndexResult.create({
    data: { animalId: thunder.id, algorithmVersion: "placeholder-v0", notes: "Future pedigree index — not yet calculated (Phase 1 placeholder)." },
  });

  // =======================================================================
  // 2) Jersey bull — proof + source history
  // =======================================================================
  const rocket = await createAnimal({
    primaryName: "SUNNYVALE ROCKET", shortName: "Rocket", sex: "M", breedCode: "JE",
    birthDate: "2023-05-02", country: "CA", status: "genomic",
    roles: ["young_genomic_bull", "reference_sire"],
    identifiers: [
      { idType: "registration_ca", idValue: "JECAN0044556677", sourceName: "Breed Association Record", country: "CA", primary: true },
      { idType: "naab", idValue: "236JE00450", sourceName: "Breed Association Record" },
      { idType: "internal_stud", idValue: "BS-0002" },
    ],
  });
  await addProof(rocket.id, {
    date: "2026-04-01", run: "April 2026", sourceName: "LactanetGen", rel: 0.72, preferred: true,
    traits: { LPI: 2980, "PRO$": 2510, MILK: 780, FAT: 64, PROT: 44, FATPCT: 0.42, PROTPCT: 0.18, CONF: 10, MAMM: 11, HL: 106, DF: 103, SCS: 2.9 },
  });
  await addPedigree(rocket.id, "LactanetGen", "https://lactanetgen.ca/animal/JECAN0044556677");

  // =======================================================================
  // 3) Ayrshire dam — milk + classification
  // =======================================================================
  const ayrRose = await createAnimal({
    primaryName: "RIVERSIDE AYR ROSE", shortName: "Rose", sex: "F", breedCode: "AY",
    birthDate: "2020-02-20", country: "CA", status: "active",
    roles: ["cow", "dam"],
    identifiers: [
      { idType: "registration_ca", idValue: "AYCAN0033221100", sourceName: "Breed Association Record", country: "CA", primary: true },
      { idType: "tattoo", idValue: "RVR ROSE", sourceName: "Manual Entry" },
    ],
  });
  await addMilk(ayrRose.id, { date: "2024-06-15", sourceName: "Official Uploaded Production Report", lactation: 2, calving: "2023-08-10", dim: 305, milk: 8200, fat: 340, fatPct: 4.15, protein: 285, protPct: 3.48, preferred: true });
  await addClassification(ayrRose.id, { date: "2024-07-01", sourceName: "Official Uploaded Classification Report", lactation: 2, age: "4-01", final: 85, code: "VG", preferred: true, traits: { FINAL: 85, C_MAMM: 86, C_FL: 84, C_DS: 85, C_RUMP: 83, C_GA: 85, L_STAT: 6, L_UDEPTH: 5 } });
  await addPedigree(ayrRose.id, "Breed Association Record", "https://ayrshire.ca/animal/AYCAN0033221100");

  // =======================================================================
  // 4) Brown Swiss cow — milk history + classification history
  // =======================================================================
  const belle = await createAnimal({
    primaryName: "ALPINE BROWN BELLE", shortName: "Belle", sex: "F", breedCode: "BS",
    birthDate: "2019-01-11", country: "CA", status: "active",
    roles: ["cow", "dam", "reference_animal"],
    identifiers: [
      { idType: "registration_ca", idValue: "BSCAN0011223344", sourceName: "Breed Association Record", country: "CA", primary: true },
      { idType: "ear_tag", idValue: "BS-114", sourceName: "Manual Entry" },
    ],
  });
  await addMilk(belle.id, { date: "2022-05-01", sourceName: "Official Uploaded Production Report", lactation: 1, calving: "2021-07-01", milk: 9100, fat: 385, fatPct: 4.23, protein: 320, protPct: 3.52, preferred: true });
  await addMilk(belle.id, { date: "2023-06-01", sourceName: "Official Uploaded Production Report", lactation: 2, calving: "2022-08-01", milk: 10200, fat: 430, fatPct: 4.22, protein: 356, protPct: 3.49, preferred: true });
  await addMilk(belle.id, { date: "2024-06-10", sourceName: "Official Uploaded Production Report", lactation: 3, calving: "2023-08-05", milk: 11050, fat: 470, fatPct: 4.25, protein: 388, protPct: 3.51, preferred: true });
  await addClassification(belle.id, { date: "2022-06-01", sourceName: "Official Uploaded Classification Report", lactation: 1, age: "3-05", final: 84, code: "VG", traits: { FINAL: 84, C_MAMM: 85, C_FL: 83, C_DS: 84 } });
  await addClassification(belle.id, { date: "2024-06-20", sourceName: "Official Uploaded Classification Report", lactation: 3, age: "5-05", final: 88, code: "VG", preferred: true, traits: { FINAL: 88, C_MAMM: 89, C_FL: 87, C_DS: 88, C_RUMP: 86, C_GA: 88 } });
  await addPedigree(belle.id, "Breed Association Record", "https://brownswiss.ca/animal/BSCAN0011223344");

  // =======================================================================
  // 5) Milking Shorthorn — basic proof + classification
  // =======================================================================
  const may = await createAnimal({
    primaryName: "HERITAGE SHORTHORN MAY", shortName: "May", sex: "F", breedCode: "MS",
    birthDate: "2021-04-09", country: "CA", status: "active",
    roles: ["cow"],
    identifiers: [{ idType: "registration_ca", idValue: "MSCAN0009988776", sourceName: "Breed Association Record", country: "CA", primary: true }],
  });
  await addProof(may.id, { date: "2026-04-01", run: "April 2026", sourceName: "Manual Entry", rel: 0.55, preferred: true, traits: { LPI: 2100, MILK: 6200, FAT: 250, PROT: 210, CONF: 7 } });
  await addClassification(may.id, { date: "2025-05-01", sourceName: "Manual Entry", lactation: 1, final: 80, code: "GP", preferred: true, traits: { FINAL: 80, C_MAMM: 80, C_FL: 79 } });

  // =======================================================================
  // 6) Angus bull — beef traits
  // =======================================================================
  const titan = await createAnimal({
    primaryName: "BLACKWOOD ANGUS TITAN", shortName: "Titan", sex: "M", breedCode: "AN",
    birthDate: "2022-02-01", country: "CA", status: "active",
    notes: "Beef sire with beef-on-dairy suitability for the dairy customer base.",
    roles: ["active_stud_bull", "reference_sire"],
    identifiers: [
      { idType: "registration_ca", idValue: "ANCAN2200110", sourceName: "Breed Association Record", country: "CA", org: "Canadian Angus Association", primary: true },
      { idType: "naab", idValue: "014AN00777", sourceName: "Breed Association Record" },
      { idType: "internal_stud", idValue: "BS-0006" },
    ],
  });
  await addProof(titan.id, {
    date: "2026-03-01", run: "Spring 2026 EPD", sourceName: "Breed Association Record", rel: 0.80, preferred: true,
    notes: "Beef EPD-style evaluation.",
    traits: { CE: 8, BW: 1.2, WW: 62, YW: 108, GL: -1.5, MARB: 0.65, REA: 0.55, CW: 38, FT: 0.02, TEND: 0.3, BOD: 112, COAT: "Black", POLL: "Homozygous Polled" },
  });
  await addPedigree(titan.id, "Breed Association Record", "https://www.cdnangus.ca/animal/ANCAN2200110");

  // =======================================================================
  // 7) Donor cow / dam — multi-role, milk + classification + proof
  // =======================================================================
  const diamond = await createAnimal({
    primaryName: "GOLDEN OAKS DIAMOND", shortName: "Diamond", sex: "F", breedCode: "HO",
    birthDate: "2018-09-30", country: "CA", status: "active",
    notes: "Elite donor and brood cow; dam of several stud bulls.",
    roles: ["cow", "donor_cow", "dam", "granddam", "reference_animal"],
    identifiers: [
      { idType: "registration_ca", idValue: "HOCAN0107654321", sourceName: "Holstein Canada", country: "CA", org: "Holstein Canada", primary: true },
      { idType: "holstein_ca", idValue: "HC-DIAMOND", sourceName: "Holstein Canada" },
      { idType: "ear_tag", idValue: "GO-302", sourceName: "Manual Entry" },
    ],
  });
  await addProof(diamond.id, { date: "2026-04-01", run: "April 2026", sourceName: "LactanetGen", rel: 0.88, preferred: true, traits: { LPI: 3320, "PRO$": 2600, MILK: 1200, FAT: 70, PROT: 55, CONF: 14, MAMM: 15, HL: 109, DF: 107, SCS: 2.6 } });
  await addMilk(diamond.id, { date: "2023-06-01", sourceName: "Holstein Canada", lactation: 3, calving: "2022-08-01", milk: 13200, fat: 520, fatPct: 3.94, protein: 430, protPct: 3.26, preferred: true });
  await addMilk(diamond.id, { date: "2024-06-01", sourceName: "Holstein Canada", lactation: 4, calving: "2023-08-01", milk: 14100, fat: 560, fatPct: 3.97, protein: 461, protPct: 3.27, preferred: true });
  await addClassification(diamond.id, { date: "2024-06-15", sourceName: "Holstein Canada", lactation: 4, age: "5-09", final: 92, code: "EX", preferred: true, traits: { FINAL: 92, C_MAMM: 93, C_FL: 90, C_DS: 92, C_RUMP: 90, C_GA: 92, L_STAT: 7, L_UDEPTH: 4 } });
  await addPedigree(diamond.id, "Holstein Canada", "https://www.holstein.ca/PublicContent/AnimalProfile?id=HOCAN0107654321");
  await addNote(diamond.id, "Flush scheduled Q3 2026. Embryos reserved.", "general");

  // =======================================================================
  // 8) Conflicting-source animal — preferred resolved by source priority
  // =======================================================================
  const conflictLady = await createAnimal({
    primaryName: "CONFLICT-VIEW LADY", shortName: "Lady", sex: "F", breedCode: "HO",
    birthDate: "2020-11-05", country: "CA", status: "active",
    notes: "Demonstrates conflicting values from different sources for the SAME proof run. Preferred value follows source priority (LactanetGen > AI-extracted).",
    roles: ["cow", "dam"],
    identifiers: [
      { idType: "registration_ca", idValue: "HOCAN0108001122", sourceName: "Holstein Canada", country: "CA", primary: true },
      { idType: "semen_code", idValue: "CV-LADY", sourceName: "Catalogue PDF" },
    ],
  });
  // Higher-priority source (LactanetGen) — this one wins.
  await addProof(conflictLady.id, {
    date: "2026-04-01", run: "April 2026", sourceName: "LactanetGen", rel: 0.85, preferred: true,
    notes: "Official LactanetGen value — highest priority.",
    traits: { LPI: 3400, "PRO$": 2700, MILK: 1300, FAT: 75, PROT: 58, CONF: 12, MAMM: 13, HL: 107 },
  });
  // Lower-priority conflicting source (AI extracted from catalogue) — kept in history.
  await addProof(conflictLady.id, {
    date: "2026-04-01", run: "April 2026 (catalogue)", sourceName: "AI Extracted PDF/Screenshot", rel: 0.85, preferred: false,
    notes: "Conflicting value extracted from a marketing catalogue — retained for audit, NOT preferred.",
    traits: { LPI: 3520, "PRO$": 2760, MILK: 1360, FAT: 79, PROT: 60, CONF: 12, MAMM: 13 },
  });

  // =======================================================================
  // 9) Possible-duplicate pair (shared NAAB code) for duplicate warnings
  // =======================================================================
  const dupA = await createAnimal({
    primaryName: "NORTHWIND ECLIPSE", shortName: "Eclipse", sex: "M", breedCode: "HO",
    birthDate: "2021-01-20", country: "CA", status: "proven", roles: ["proven_bull", "active_stud_bull"],
    identifiers: [
      { idType: "registration_ca", idValue: "HOCAN0109001001", sourceName: "Holstein Canada", country: "CA", primary: true },
      { idType: "naab", idValue: "007HO16777", sourceName: "Breed Association Record" },
      { idType: "internal_stud", idValue: "BS-0009" },
    ],
  });
  await addProof(dupA.id, { date: "2026-04-01", run: "April 2026", sourceName: "LactanetGen", rel: 0.93, preferred: true, traits: { LPI: 3460, "PRO$": 2720, MILK: 1490, FAT: 85, PROT: 63, CONF: 12, MAMM: 13, HL: 109, DF: 105, SCS: 2.72 } });
  await addPedigree(dupA.id, "Holstein Canada", "https://www.holstein.ca/PublicContent/AnimalProfile?id=HOCAN0109001001");

  const dupB = await createAnimal({
    primaryName: "NORTHWIND ECLIPSE (import)", shortName: "Eclipse2", sex: "M", breedCode: "HO",
    birthDate: "2021-01-20", country: "US", status: "reference",
    notes: "Possible duplicate of NORTHWIND ECLIPSE — shares NAAB code. Flagged for review, not merged.",
    roles: ["reference_sire", "international_animal"],
    identifiers: [
      { idType: "registration_us", idValue: "USA0074001001", sourceName: "Breed Association Record", country: "US", primary: true },
      { idType: "naab", idValue: "007HO16777", sourceName: "AI Extracted PDF/Screenshot" },
    ],
  });

  // A heifer with a missing primary identifier (data-quality demo)
  await createAnimal({
    primaryName: "YOUNGSTOCK HEIFER 512", shortName: "H512", sex: "F", breedCode: "HO",
    birthDate: "2025-01-15", country: "CA", status: "active", roles: ["heifer"],
    identifiers: [{ idType: "ear_tag", idValue: "512", sourceName: "Manual Entry" }], // no primary, no registration
  });

  // =======================================================================
  // 10) Source captures + pending review-queue items
  // =======================================================================
  // (a) A capture that proposes a NEW proof for an existing animal (Thunder)
  const cap1 = await prisma.sourceCapture.create({
    data: {
      sourceId: S("Official Uploaded Genetic Proof File"), animalId: thunder.id, captureType: "pdf",
      originalFileName: "thunder_official_proof_2026-08.pdf", storedFileUrl: "/uploads/demo/sample-thunder-proof.pdf",
      capturedById: adminId, extractionStatus: "simulated", confidenceScore: 0.88,
      rawExtractedDataJson: JSON.stringify({ animal: "MAPLE-CREST THUNDER", proofRun: "August 2026", LPI: 3555, "PRO$": 2810, MILK: 1560, FAT: 90, PROT: 66 }),
      notes: "Simulated extraction from an official proof PDF.",
    },
  });
  await prisma.importReviewQueue.create({
    data: {
      captureId: cap1.captureId, proposedRecordType: "genetic_evaluation", matchedAnimalId: thunder.id, matchConfidence: 0.98,
      extractedDataJson: JSON.stringify({ evaluationDate: "2026-08-01", proofRun: "August 2026", traits: { LPI: 3555, "PRO$": 2810, MILK: 1560, FAT: 90, PROT: 66 } }),
      status: "pending",
    },
  });

  // (b) A capture that proposes a brand-new animal (no match)
  const cap2 = await prisma.sourceCapture.create({
    data: {
      sourceId: S("Catalogue PDF"), captureType: "image", originalFileName: "new_bull_screenshot.png",
      storedFileUrl: "/uploads/demo/sample-new-bull.png", capturedById: adminId, extractionStatus: "simulated", confidenceScore: 0.6,
      rawExtractedDataJson: JSON.stringify({ animal: "WESTVIEW COMET", breed: "Holstein", naab: "007HO16999", LPI: 3210 }),
      notes: "Simulated extraction — appears to be a new animal not yet in the database.",
    },
  });
  await prisma.importReviewQueue.create({
    data: {
      captureId: cap2.captureId, proposedRecordType: "animal", matchConfidence: 0.2,
      extractedDataJson: JSON.stringify({ primaryName: "WESTVIEW COMET", breedCode: "HO", sex: "M", identifiers: [{ idType: "naab", idValue: "007HO16999" }], proof: { LPI: 3210 } }),
      status: "pending", reviewNotes: "No confident match — review to create new animal or link.",
    },
  });

  // (c) A capture flagged as a conflict for the review queue
  const cap3 = await prisma.sourceCapture.create({
    data: {
      sourceId: S("AI Extracted PDF/Screenshot"), animalId: conflictLady.id, captureType: "image",
      originalFileName: "lady_catalogue.png", storedFileUrl: "/uploads/demo/sample-lady.png", capturedById: adminId,
      extractionStatus: "simulated", confidenceScore: 0.5,
      rawExtractedDataJson: JSON.stringify({ animal: "CONFLICT-VIEW LADY", LPI: 3520 }),
      notes: "Value conflicts with the official LactanetGen proof already on file.",
    },
  });
  await prisma.importReviewQueue.create({
    data: {
      captureId: cap3.captureId, proposedRecordType: "genetic_evaluation", matchedAnimalId: conflictLady.id, matchConfidence: 0.9,
      extractedDataJson: JSON.stringify({ proofRun: "April 2026", traits: { LPI: 3520 } }),
      status: "conflict_review", reviewNotes: "Conflicts with higher-priority LactanetGen value (3400).",
    },
  });

  const counts = {
    animals: await prisma.animal.count(),
    proofs: await prisma.geneticEvaluation.count(),
    milk: await prisma.milkRecord.count(),
    classifications: await prisma.classificationRecord.count(),
    reviews: await prisma.importReviewQueue.count(),
    captures: await prisma.sourceCapture.count(),
  };
  await prisma.auditLog.create({ data: { entityType: "system", action: "seed", notes: "Demo seed applied", changesJson: JSON.stringify(counts) } });
  console.log("[seed-demo] done:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
