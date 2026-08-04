import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeader, parseRow } from "./lactanet";

// Lactanet ships the same measurements under two different column layouts.
// These tests pin BOTH so a file in either layout is read completely — the gap
// that left every official proof (gealltraits layout) with a blank Milk / Fat /
// Protein / Conformation while the interim proofs (detail layout) were fine.

const val = (bull: ReturnType<typeof parseRow>, code: string) =>
  bull?.traits.find((t) => t.traitCode === code)?.numericValue ?? null;

test("the DETAIL layout (EBV … KG / … RATING) parses production, conf and health", () => {
  const header = "REGISTRATION NUMBER,REGISTERED NAME,LPI,EBV MILK KG,EBV FAT KG,EBV PROTEIN KG,EBV FAT PERCENT,EBV CONFORMATION,LP RATING,SCS RATING,CA RATING";
  const row = "HOCANM100000001,TEST DETAIL,3000,-232,-4,-1,.05,17,102,96,93";
  const b = parseRow(row.split(","), parseHeader(header));
  assert.equal(val(b, "MILK"), -232);
  assert.equal(val(b, "FAT"), -4);
  assert.equal(val(b, "PROT"), -1);
  assert.equal(val(b, "CONF"), 17);
  assert.equal(val(b, "LP"), 102);
  assert.equal(val(b, "CA"), 93);
});

test("the GEALLTRAITS layout (plain MILK / CONFORMATION / bare codes) parses the same", () => {
  // The real official-file column order: a RELIABILITY column precedes each value,
  // and MILKABILITY INDEX (MI) appears earlier — the alias must pick the exact
  // "MILK" value column, not "MILKABILITY INDEX (MI)" or "MILK RELIABILITY".
  const header = "REGISTRATION NUMBER,REGISTERED NAME,LPI,MILKABILITY INDEX (MI),MILK RELIABILITY,MILK,FAT RELIABILITY,FAT,PROTEIN RELIABILITY,PROTEIN,FAT PERCENT,CONFORMATION RELIABILITY,CONFORMATION,LP RELIABILITY,LP,CA RELIABILITY,CA";
  const row = "HOCANM100000002,SWEETVIEW GRINCH P,3309,500,90,-232,90,-4,90,-1,.05,95,17,80,102,80,93";
  const b = parseRow(row.split(","), parseHeader(header));
  assert.equal(val(b, "MILK"), -232, "MILK must come from the value column, not MILKABILITY/reliability");
  assert.equal(val(b, "FAT"), -4);
  assert.equal(val(b, "PROT"), -1);
  assert.equal(val(b, "FATPCT"), 0.05);
  assert.equal(val(b, "CONF"), 17);
  assert.equal(val(b, "LP"), 102);
  assert.equal(val(b, "CA"), 93);
});

test("AFS is not aliased across layouts — the gealltraits 'AFS' is Age at First Service", () => {
  // The detail layout's AFS is Average Final Score; the gealltraits layout has no
  // Average Final Score and reuses the acronym for a fertility trait. Mapping them
  // would write the wrong number, so a bare 'AFS' must NOT populate the AFS trait.
  const header = "REGISTRATION NUMBER,REGISTERED NAME,LPI,AFS RELIABILITY,AFS";
  const row = "HOCANM100000003,TEST AFS,3000,80,14"; // 14 = age in months, not a final score
  const b = parseRow(row.split(","), parseHeader(header));
  assert.equal(val(b, "AFS"), null, "gealltraits 'AFS' (Age at First Service) must not fill Average Final Score");
});

test("a detail-layout file is untouched by the aliases (canonical name wins)", () => {
  // Both an EBV MILK KG and a stray MILK column present — the canonical must win,
  // proving the alias only fills a genuinely missing name.
  const header = "REGISTRATION NUMBER,REGISTERED NAME,LPI,EBV MILK KG,MILK";
  const row = "HOCANM100000004,TEST BOTH,3000,-232,999";
  const b = parseRow(row.split(","), parseHeader(header));
  assert.equal(val(b, "MILK"), -232, "canonical EBV MILK KG must win over a stray MILK column");
});
