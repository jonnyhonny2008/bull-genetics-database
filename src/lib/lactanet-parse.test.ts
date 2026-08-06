import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLactanetAnimal } from "./lactanet-parse";

// Fixture-based guard for the Lactanet HTML parser — the most layout-fragile code
// in the app and, until now, the only untested one. It turns scraped pages into
// the genetic numbers everything downstream trusts, and it has a documented
// history of silent TOTAL data loss (a missing "&ast;" entity once broke run
// detection so every imported animal came back with zero traits). These tests pin
// the exact values parsed from two saved real pages so that class of breakage
// fails loudly here instead of shipping a wrong (or empty) proof.
//
// The fixtures live in imports/lactanet-fixtures/ and are real captured pages.

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "imports", "lactanet-fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

test("bull summary + pedigree parse to the exact expected values", () => {
  const p = parseLactanetAnimal("HOCANM13486161", "M", {
    summary: read("bull-summary.html"),
    pedigree: read("bull-pedigree.html"),
  });
  const t = (code: string) => p.evaluation.traits.find((x) => x.code === code)?.numericValue ?? null;

  // Identity
  assert.equal(p.identity.reg, "HOCANM13486161");
  assert.equal(p.identity.name, "AIJA BELIEVE-P");
  assert.equal(p.identity.naab, "799HO00030");
  assert.equal(p.identity.birthDate, "2019-10-08");

  // THE run date is the historically-fragile field (the "&ast;" incident). If this
  // regresses to null, no evaluation gets written and the import silently no-ops.
  assert.equal(p.evaluation.runDate, "2026-04-01", "proof run date must parse from 'GEBV 26*APR'");
  assert.equal(p.evaluation.runLabel, "April 2026");
  assert.equal(p.evaluation.basis, "GEBV");
  assert.equal(p.evaluation.reliability, 0.95);

  // Trait values — the numbers a wrong parse would silently corrupt.
  assert.equal(t("LPI"), 2727);
  assert.equal(t("PRO$"), -284);
  assert.equal(t("MILK"), -223);
  assert.equal(t("FAT"), -43);
  assert.equal(t("PROT"), -36);
  assert.equal(t("CONF"), 11);
  assert.ok(p.evaluation.traits.length >= 40, `expected a full trait set, got ${p.evaluation.traits.length}`);

  // Pedigree: first ancestor is the sire, generation 1.
  assert.ok(p.profile.familyTree.length >= 10, `expected a populated family tree, got ${p.profile.familyTree.length}`);
  const sire = p.profile.familyTree[0];
  assert.equal(sire.generation, 1);
  assert.equal(sire.side, "sire");
  assert.equal(sire.name, "COOMBOONA ZIPIT MIRAND-PP");
  assert.equal(sire.reg, "HOAUSM1993596");

  // A bull is never classified himself and has no lactations of his own.
  assert.equal(p.profile.classifications.length, 0);
  assert.equal(p.profile.lactations.length, 0);
  assert.deepEqual(p.warnings, []);
});

test("cow summary + classification + lactation parse identity, proof, class'n and milk", () => {
  const p = parseLactanetAnimal("HOCANF121135242", "F", {
    summary: read("pfcow-summary.html"),
    classification: read("pfcow-classification.html"),
    lactation: read("pfcow-lactation.html"),
  });
  const t = (code: string) => p.evaluation.traits.find((x) => x.code === code)?.numericValue ?? null;

  assert.equal(p.identity.reg, "HOCANF121135242");
  assert.equal(p.identity.name, "BLONDIN DESTINATION SPAIN");
  assert.equal(p.identity.birthDate, "2023-01-17");

  assert.equal(p.evaluation.runDate, "2026-07-01", "July proof run must parse");
  assert.equal(p.evaluation.runLabel, "July 2026");
  assert.equal(t("LPI"), 3608);
  assert.equal(t("MILK"), 1103);
  assert.equal(t("FAT"), 67);
  assert.equal(t("PROT"), 38);

  // Females carry their own classification and lactation records.
  assert.equal(p.profile.classifications.length, 2, "two classification events on file");
  // The newest classification carries the linear descriptor grid.
  const bq = p.profile.classifications[0].sections.find((s) => s.code === "BQ");
  assert.equal(bq?.value, "9", "linear descriptor 'Bone Quality' should parse to 9");

  assert.equal(p.profile.lactations.length, 1);
  assert.equal(p.profile.lactations[0].milk, 10249);
  assert.equal(p.profile.lactations[0].calvingDateIso, "2025-02-03");
});
