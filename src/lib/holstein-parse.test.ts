import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHolsteinExtract, type HolsteinRawExtract } from "./holstein-parse";

// Fixtures are the REAL page structures captured from holstein.ca on 2026-07-29
// (BLONDIN DETECTIVE, a proven CAN-GEBV bull; REJO GIGOTTE IPSOS P, a young
// CAN-PA heifer). They exercise both evaluation bases and the blank-lactation case.

const BULL: HolsteinRawExtract = {
  reg: "HOCANM120781841",
  animalId: "15128888",
  name: "BLONDIN DETECTIVE",
  mainText: [
    "Search For Animal", "Careers", "Holstein Canada",
    "BLONDIN DETECTIVE", "HOCANM120781841", "Registration Status: Registered",
    "Purity: PB   Herd #: 1841", "National Id: 124000120781841", "Born: 27 Jun 2021",
    "B&W *A2A2*MWF*CDF*CVF*BYF*BLF*DPF*CNF ET GTSM10.57 %INB 21 %R",
    "Sire:  HO840M3128769279 STANTONS ALLIGATOR-ET    PB VG-85-4YR-CAN",
    "Dam:  HO840F3210276404 MS BLONDIN CRSHBLL DEENA-ET    PB VG-86-2YR-CAN",
    "Genetic Production (KG) CAN-GEBV %RK %Dev %RK %RK",
    "Apr*26 Milk 1025 81% GLPI 3367 95% Pro$ 640",
    "Reliability 96% Fat 2 12% -0.31 Production 503 51% Reproduction 474 37%",
    "Protein 25 38% -0.08 Longevity & Type 782 99% Milkability 484 44%",
    "MR 99 57% Health & Welfare 425 21% Environmental Impact 435 26%",
    "Genetic Conformation CAN-GEBV %RK",
    "Apr*26 Conformation 15 99% Reliability 94% Rump 5 Dairy Strength 10 Mammary System 10 Feet & Legs 15",
  ].join("\n"),
  genText: null,
  genTables: [
    { head: "", rows: [
      ["PRODUCTION", "", "No. Herds 143", "No. Daus. 254", "", "Panel Density: MD"],
      ["Apr*26", "CAN-GEBV", "96% Reliability", "Pro$ 640", "GLPI 3367", "92% Rel", ""],
      ["First Lactation", "Second Lactation", "Third Lactation", "Rating", "%Dev", "Rank"],
      ["Milk (kg)", "1417", "912", "763", "1025", "", "81%"],
      ["Fat (kg)", "19", "-5", "-12", "2", "-0.31", "12%"],
      ["Protein (kg)", "39", "21", "15", "25", "-0.08", "38%"],
      ["Somatic Cell Score", "105", "101", "102", "102", "", "67%"],
      ["Total Test Day Records", "735", "0", "0", "", "", ""],
    ] },
    { head: "FUNCTIONAL TRAITS", rows: [
      ["FUNCTIONAL TRAITS"],
      ["Traits", "", "Rating", "Reliability"],
      ["Herd Life", "GEBV", "97", "91%"],
      ["Daughter Fertility", "GEBV", "99", "86%"],
      ["Mastitis Resistance", "GEBV", "99", "77%"],
      ["Calf Health", "GPA", "104", "83%"],
    ] },
    { head: "CONFORMATION", rows: [
      ["CONFORMATION"],
      ["Apr*26", "CAN-GEBV", "", "94% Reliability", "No. Herds 88", "No. Daus. 158"],
      ["", "Rating", "", "Rank", ""],
      ["Conformation", "15", "", "99%", ""],
      ["", "Rating", "Rank", "", "", "Rating", "Rank"],
      ["Rump", "5", "83", "", "Dairy Strength", "10", "97"],
      ["Rump Angle", "3H", "", "", "Stature", "8T", ""],
      ["Pin Width", "1", "", "", "Height at Front End", "10", ""],
      ["Teat Length", "5L", "", "", "Locomotion", "7", ""],
    ] },
  ],
};

const HEIFER: HolsteinRawExtract = {
  reg: "HOCANF121517751",
  animalId: "15884225",
  name: "REJO GIGOTTE IPSOS P",
  mainText: [
    "Holstein Canada", "REJO GIGOTTE IPSOS P", "HOCANF121517751", "Registration Status: Registered",
    "Purity: PB   Herd #: 7751", "National Id: 124000121517751", "Born: 01 Dec 2023",
    "R&W *POR*VRR*BKC11.11 %INB 18 %R",
    "Genetic Production (KG) CAN-PA %RK %Dev %RK %RK",
    "Jul*26 Milk -17 38% PA LPI 2894 46% Pro$ 280",
    "Reliability 30% Fat 11 40% 0.11 Production 454 33% Reproduction 487 55%",
    "Protein 0 30% 0.01 Longevity & Type 572 63% Milkability 554 75%",
    "Health & Welfare 529 80% Environmental Impact 417 13%",
  ].join("\n"),
  genText: null,
  genTables: [
    { head: "", rows: [
      ["PRODUCTION", "Panel Density:"],
      ["Jul*26", "CAN-PA", "30% Reliability", "Pro$ 280", "PA LPI 2894", "29% Rel", ""],
      ["First Lactation", "Second Lactation", "Third Lactation", "Rating", "%Dev", "Rank"],
      ["Milk (kg)", "", "", "", "-17", "", "38%"],
      ["Fat (kg)", "", "", "", "11", "0.11", "40%"],
      ["Protein (kg)", "", "", "", "0", "0.01", "30%"],
      ["Somatic Cell Score", "", "", "", "99", "", "44%"],
    ] },
    { head: "FUNCTIONAL TRAITS", rows: [
      ["FUNCTIONAL TRAITS"],
      ["Traits", "", "Rating", "Reliability"],
      ["Herd Life", "PA", "101", "30%"],
      ["Daughter Fertility", "PA", "99", "28%"],
    ] },
  ],
};

function byCode(traits: { code: string; numericValue: number | null; textValue: string | null; percentileRank: number | null }[], code: string) {
  return traits.find((t) => t.code === code);
}

test("proven bull (CAN-GEBV) parses identity, evaluation, and all trait groups", () => {
  const p = parseHolsteinExtract(BULL);
  assert.equal(p.regNo, "HOCANM120781841");
  assert.equal(p.sex, "M");
  assert.equal(p.name, "BLONDIN DETECTIVE");
  assert.equal(p.birthDate, "2021-06-27");
  assert.equal(p.betaCasein, "A2A2");
  assert.equal(p.colour, "B&W");
  assert.equal(p.inbreeding, 10.57);
  assert.ok(p.evaluation, "has evaluation");
  assert.equal(p.evaluation!.runLabel, "April 2026");
  assert.equal(p.evaluation!.basis, "GEBV");
  assert.equal(p.evaluation!.reliability, 0.96);

  // indexes
  assert.equal(byCode(p.traits, "LPI")?.numericValue, 3367);
  assert.equal(byCode(p.traits, "LPI")?.percentileRank, 95);
  assert.equal(byCode(p.traits, "PRO$")?.numericValue, 640);
  assert.equal(byCode(p.traits, "PI")?.numericValue, 503);
  assert.equal(byCode(p.traits, "RI")?.numericValue, 474);
  assert.equal(byCode(p.traits, "LTI")?.numericValue, 782);
  assert.equal(byCode(p.traits, "MI")?.numericValue, 484);
  assert.equal(byCode(p.traits, "HWI")?.numericValue, 425);
  assert.equal(byCode(p.traits, "EI")?.numericValue, 435);
  // composites
  assert.equal(byCode(p.traits, "CONF")?.numericValue, 15);
  assert.equal(byCode(p.traits, "CONF")?.percentileRank, 99);
  assert.equal(byCode(p.traits, "RUMP")?.numericValue, 5);
  assert.equal(byCode(p.traits, "DS")?.numericValue, 10);
  assert.equal(byCode(p.traits, "MAMM")?.numericValue, 10);
  assert.equal(byCode(p.traits, "FL")?.numericValue, 15);
  // production
  assert.equal(byCode(p.traits, "MILK")?.numericValue, 1025);
  assert.equal(byCode(p.traits, "MILK")?.percentileRank, 81);
  assert.equal(byCode(p.traits, "FAT")?.numericValue, 2);
  assert.equal(byCode(p.traits, "FATPCT")?.numericValue, -0.31);
  assert.equal(byCode(p.traits, "PROT")?.numericValue, 25);
  assert.equal(byCode(p.traits, "SCS")?.numericValue, 102);
  // functional
  assert.equal(byCode(p.traits, "HL")?.numericValue, 97);
  assert.equal(byCode(p.traits, "DF")?.numericValue, 99);
  assert.equal(byCode(p.traits, "MR")?.numericValue, 99);
  assert.equal(byCode(p.traits, "CH")?.numericValue, 104);
  // linear (value + descriptor letter)
  assert.equal(byCode(p.traits, "STA")?.numericValue, 8);
  assert.equal(byCode(p.traits, "STA")?.textValue, "T");
  assert.equal(byCode(p.traits, "RA")?.numericValue, 3);
  assert.equal(byCode(p.traits, "RA")?.textValue, "H");
  assert.equal(byCode(p.traits, "TL")?.numericValue, 5);
  assert.equal(byCode(p.traits, "LOCO")?.numericValue, 7);
  // pedigree
  assert.equal(p.pedigree.find((x) => x.relation === "sire")?.reg, "HO840M3128769279");
  assert.equal(p.pedigree.find((x) => x.relation === "dam")?.reg, "HO840F3210276404");
});

test("classified cow: own classification is the score before the Sire: block", () => {
  const COW: HolsteinRawExtract = {
    reg: "HOCANF111576042",
    mainText: [
      "Holstein Canada", "SOME COW NAME", "HOCANF111576042", "Registration Status: Registered",
      "Purity: PB   Herd #: 6042", "National Id: 124000111576042", "Born: 01 Jan 2018",
      "B&W *A2A2* 6.5 %INB 20 %R",
      "EX-94-5YR-CAN",
      "Genetic Production (KG) CAN-GEBV %RK Jul*26 Milk 500 50% GLPI 3000 90% Pro$ 500 Reliability 99%",
      "Sire:  HO840M0000111 SOME SIRE    PB VG-87-6YR-CAN",
      "Dam:  HO840F0000222 SOME DAM    PB EX-97-4E-CAN",
    ].join("\n"),
    genText: null, genTables: [],
  };
  const p = parseHolsteinExtract(COW);
  assert.ok(p.classification, "cow has own classification");
  assert.equal(p.classification!.code, "EX");
  assert.equal(p.classification!.score, 94);
  assert.equal(p.classification!.age, "5YR");
  // sire/dam captured separately, not confused with the animal's own score
  assert.equal(p.pedigree.find((x) => x.relation === "sire")?.reg, "HO840M0000111");
});

test("young heifer (CAN-PA) parses with blank lactations and PA basis", () => {
  const p = parseHolsteinExtract(HEIFER);
  assert.equal(p.regNo, "HOCANF121517751");
  assert.equal(p.sex, "F");
  assert.equal(p.evaluation!.basis, "PA");
  assert.equal(p.evaluation!.reliability, 0.30);
  assert.equal(byCode(p.traits, "LPI")?.numericValue, 2894);
  assert.equal(byCode(p.traits, "PRO$")?.numericValue, 280);
  // rating comes from col 4 even when the lactation columns are blank
  assert.equal(byCode(p.traits, "MILK")?.numericValue, -17);
  assert.equal(byCode(p.traits, "FAT")?.numericValue, 11);
  assert.equal(byCode(p.traits, "FATPCT")?.numericValue, 0.11);
  assert.equal(byCode(p.traits, "SCS")?.numericValue, 99);
  assert.equal(byCode(p.traits, "HL")?.numericValue, 101);
});
