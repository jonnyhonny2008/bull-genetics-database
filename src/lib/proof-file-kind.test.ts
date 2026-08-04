import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProofFile, isImportableProofFile, runKindLabel } from "./proof-file-kind";

// Every name below is a real file from "Blondin Sires - Genetics".

test("the two families that share a GERUN are told apart", () => {
  const off = classifyProofFile("gealltraits_bulls07992504_ho.csv");
  const int = classifyProofFile("gealltraits_bulls_unoff07992504_ho.csv");
  assert.equal(off.kind, "official");
  assert.equal(int.kind, "interim");
  // Same run, same breed — only the name separates them. This is the whole point.
  assert.equal(off.gerun, int.gerun);
  assert.equal(off.gerun, "2504");
  assert.equal(off.stud, "0799");
  assert.equal(off.breed, "HO");
});

test("_unoff is matched before the official pattern it contains", () => {
  // "gealltraits_bulls_unoff…" also contains "gealltraits_bulls". Order-dependent:
  // get it wrong and every interim file is filed as official.
  assert.equal(classifyProofFile("gealltraits_bulls_unoff07992604_je.csv").kind, "interim");
});

test("the bare stud file is interim, not official", () => {
  // Proven by content: for all 49 rounds where both exist, the bare file and the
  // _unoff file hold the same registrations with zero differing LPI values.
  const bare = classifyProofFile("07992504_ho.csv");
  assert.equal(bare.kind, "interim");
  assert.equal(bare.family, "interim");
  assert.equal(bare.gerun, "2504");
});

test("pregeno is not a proof round at all", () => {
  const pg = classifyProofFile("07992504pregeno_ho.csv");
  assert.equal(pg.family, "pregenomic");
  assert.equal(pg.kind, null, "importing a pre-genomic run as a proof round would overwrite real proofs");
  assert.equal(isImportableProofFile(pg), false);
});

test("cows and other studs' bulls are not stud bull rounds", () => {
  assert.equal(classifyProofFile("gealltraits_cows07992504_ho.csv").family, "cows");
  assert.equal(classifyProofFile("gealltraits_cows07992504_ho.csv").kind, null);
  // "gealltraits_bulls_priv…" contains "gealltraits_bulls" but carries no stud code.
  const priv = classifyProofFile("gealltraits_bulls_priv2504_ho.csv");
  assert.equal(priv.family, "private");
  assert.equal(priv.kind, null);
  assert.equal(priv.stud, null);
  assert.equal(priv.gerun, "2504");
});

test("a release-date suffix does not become the stud or the run", () => {
  const f = classifyProofFile("gealltraits_bulls_unoff07992504_20250408_ho.csv");
  assert.equal(f.kind, "interim");
  assert.equal(f.stud, "0799");
  assert.equal(f.gerun, "2504");
  assert.equal(f.releaseDate, "20250408");
});

test("a content-hash prefix from staging does not hide the family", () => {
  // The staging step rewrote names as "<8 hex>_<original>"; anchored patterns
  // dropped them to "other", which is how 605 interim files were imported blind.
  const f = classifyProofFile("012d2bbf_07992404_20240409_ho.csv");
  assert.equal(f.kind, "interim");
  assert.equal(f.stud, "0799");
  assert.equal(f.gerun, "2404");
});

test("a doubled folder+basename still resolves to its own run", () => {
  // Real staged name. Both halves carry a stud+GERUN; the trailing one is the file's.
  const f = classifyProofFile("07992006_20200602_07992006_20200602_ho.csv");
  assert.equal(f.kind, "interim");
  assert.equal(f.gerun, "2006");
});

test("an 8-digit calendar date is never read as stud+GERUN", () => {
  // "20250408" would otherwise parse as stud 2025, run 0408.
  const f = classifyProofFile("gealltraits_bulls07992504_20250408_ho.csv");
  assert.equal(f.stud, "0799");
  assert.equal(f.gerun, "2504");
});

test("an impossible month is not accepted as a run", () => {
  // Month 13 cannot be a GERUN; without the check "07991399" would parse happily.
  assert.equal(classifyProofFile("07991399_ho.csv").family, "other");
});

test("hand-edited breed suffixes still resolve", () => {
  assert.equal(classifyProofFile("07992010_20201006_ho-Edit.csv").breed, "HO");
  assert.equal(classifyProofFile("obgedet07992007_ho 2.csv").breed, "HO");
  // …but a longer word starting with the breed code is not a breed.
  assert.equal(classifyProofFile("07992504_hostname.csv").breed, null);
});

test("a full path is accepted, not just a basename", () => {
  const f = classifyProofFile("C:\\Users\\J\\Blondin\\CDN\\April 2025\\gealltraits_bulls07992504_ho.csv");
  assert.equal(f.kind, "official");
  assert.equal(f.gerun, "2504");
});

test("unrelated extracts are not mistaken for proof rounds", () => {
  for (const n of ["allobgepa2012_ay.csv", "aiobgepa2604_ho.csv", "GE_ALL_TRAITS_TestFile.csv", "Blondin[1].csv"])
    assert.equal(classifyProofFile(n).kind, null, n);
});

test("empty and junk input do not throw", () => {
  for (const n of ["", "   ", "notacsv", ".csv"]) assert.equal(classifyProofFile(n).kind, null);
});

test("labels read the way the reports say them", () => {
  assert.equal(runKindLabel("official"), "Official");
  assert.equal(runKindLabel("interim"), "Interim");
  assert.equal(runKindLabel(null), "Unknown");
});
