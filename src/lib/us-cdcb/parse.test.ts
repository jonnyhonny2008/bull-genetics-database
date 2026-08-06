import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCdcbPairText, parseCdcbMeta, CdcbParseError } from "./parse";
import { classifyCdcbFile, cdcbRoundDate, cdcbRoundLabel } from "./file-kind";

// Fixtures are the FIRST 5 ANIMALS of the real April-2026 Ayrshire extract, with
// only the header's ANIM count adjusted. Every value below was read out of the
// genuine CDCB file, so a parser regression fails here rather than shipping a
// wrong number.

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const parsed = () => parseCdcbPairText(read("AY_all_evaluated_infoANIM_2604.csv"), read("AY_all_evaluated_infoEVAL_2604.csv"));

// --- the metadata line -------------------------------------------------------

test("FIELDS is rows-per-animal, and the pair's counts are honoured", () => {
  const p = parsed();
  assert.equal(p.animMeta.fields, 57, "57 info keys per animal");
  assert.equal(p.evalMeta.fields, 52, "52 traits per animal");
  assert.equal(p.animMeta.anim, 5);
  assert.equal(p.animals.length, 5);
  assert.equal(p.infoKeys.length, 57);
  assert.equal(p.traitCodes.length, 52);
});

test("RUN is captured but is NOT a round indicator", () => {
  // The April 2026 OFFICIAL round reads RUN:monthly — identical to a between-round
  // monthly add. This test exists to stop anyone 'improving' the classifier to
  // trust this field.
  const p = parsed();
  assert.equal(p.animMeta.run, "monthly");
  assert.equal(p.evalMeta.run, "monthly");
  // The FILE FAMILY is what says official:
  assert.equal(classifyCdcbFile("AY_all_evaluated_infoEVAL_2604.csv").kind, "official");
});

test("a malformed metadata line is rejected, not guessed at", () => {
  assert.throws(() => parseCdcbMeta("ID17|TRAIT|GPTA"), CdcbParseError);
  assert.throws(() => parseCdcbMeta("#TYPE:EVAL|RUN:monthly|DATE:notanumber|ANIM:5|FIELDS:52"), CdcbParseError);
  assert.throws(() => parseCdcbMeta("#TYPE:ANIM|RUN:monthly|DATE:2604|ANIM:5|FIELDS:57", "EVAL"), CdcbParseError);
});

// --- real values -------------------------------------------------------------

test("the first animal's identity and traits match the source file exactly", () => {
  const a = parsed().animals[0];
  assert.equal(a.id17, "AY840003006323920");
  assert.equal(a.info.ANIM_NAME, "DANDY'S NO 7 LANE P");
  assert.equal(a.info.NAAB_CODE, "179AY00011");
  assert.equal(a.info.BIRTH, "20120404");
  assert.equal(a.info.SEX, "M");
  assert.equal(a.info.EVAL_BREED, "AY");

  // ID17|NM|1|40|-11|67|20
  assert.deepEqual(a.traits.NM, { gpta: 1, grel: 40, gsons: -11, dgv: 67, pa: 20 });
  // ID17|MILK|-500|42|-524|-127|-595   (pounds, not kg)
  assert.deepEqual(a.traits.MILK, { gpta: -500, grel: 42, gsons: -524, dgv: -127, pa: -595 });
  // ID17|PTAT|-1.00|40|-1.08|-0.88|-0.96
  assert.deepEqual(a.traits.PTAT, { gpta: -1, grel: 40, gsons: -1.08, dgv: -0.88, pa: -0.96 });
});

test("EMPTY IS NULL, NEVER ZERO", () => {
  // Ayrshire publishes no health-trait evaluations, so those columns are blank.
  // Reading blank as 0 would place the bull at exactly breed-average on a trait
  // he has never been measured for, and that would flow into rankings and mating.
  const a = parsed().animals[0];
  const ket = a.traits.KET;
  assert.ok(ket, "KET row exists even with no value — the layout is dense");
  assert.equal(ket.gpta, null);
  assert.equal(ket.grel, null);
  assert.notEqual(ket.gpta, 0);
});

test("every animal carries every trait — absence is an empty value, not a missing row", () => {
  const p = parsed();
  for (const a of p.animals) {
    assert.equal(Object.keys(a.traits).length, 52, `${a.id17} should carry all 52 trait rows`);
    assert.equal(Object.keys(a.info).length, 57, `${a.id17} should carry all 57 info keys`);
  }
});

test("SEX is read from the data, not assumed — the parser is sex-agnostic", () => {
  // The public /bulls/ files are all male, but CDCB publishes females in the same
  // layout and those files are expected later. Nothing may key off sex.
  const p = parsed();
  for (const a of p.animals) assert.ok(["M", "F"].includes(a.info.SEX), `unexpected SEX ${a.info.SEX}`);
});

// --- integrity gates ---------------------------------------------------------

test("a row count that disagrees with the header is refused", () => {
  const anim = read("AY_all_evaluated_infoANIM_2604.csv");
  const ev = read("AY_all_evaluated_infoEVAL_2604.csv");
  const truncated = ev.split("\n").slice(0, -2).join("\n"); // drop a trait row
  assert.throws(() => parseCdcbPairText(anim, truncated), CdcbParseError);
});

test("a mismatched pair (different rounds) is refused", () => {
  const anim = read("AY_all_evaluated_infoANIM_2604.csv");
  const ev = read("AY_all_evaluated_infoEVAL_2604.csv").replace("DATE:2604", "DATE:2512");
  assert.throws(() => parseCdcbPairText(anim, ev), CdcbParseError);
});

test("a non-numeric evaluation value is refused rather than silently dropped", () => {
  const anim = read("AY_all_evaluated_infoANIM_2604.csv");
  const ev = read("AY_all_evaluated_infoEVAL_2604.csv").replace("|NM|1|40|", "|NM|BAD|40|");
  assert.throws(() => parseCdcbPairText(anim, ev), CdcbParseError);
});

// --- the file-family classifier ---------------------------------------------

test("the file family alone decides official vs between-round", () => {
  const off = classifyCdcbFile("AY_all_evaluated_2604.zip");
  assert.equal(off.family, "all_evaluated");
  assert.equal(off.kind, "official");
  assert.equal(off.roundCode, "2604");
  assert.equal(off.periodKey, "R2604");
  assert.equal(off.breed, "AY");

  const yp = classifyCdcbFile("HO_young_Pub_2604.zip");
  assert.equal(yp.kind, "official", "young_Pub at a YYMM is the same triannual evaluation");
  assert.equal(yp.periodKey, "R2604");
});

test("New_young_Pub is monthly and must NOT collide with the official round", () => {
  // Both carry 2604. If they shared a period key, a provisional add could
  // displace the official April round for that animal.
  const monthly = classifyCdcbFile("HO_New_young_Pub_2604.zip");
  assert.equal(monthly.family, "new_young");
  assert.equal(monthly.kind, "provisional");
  assert.equal(monthly.roundCode, null, "only triannual families get a round code");
  assert.equal(monthly.periodKey, "M2604");
  assert.notEqual(monthly.periodKey, classifyCdcbFile("HO_all_evaluated_2604.zip").periodKey);
});

test("a weekly file is unofficial and keyed by its own date", () => {
  const w = classifyCdcbFile("HO_young_Pub_20260802.zip");
  assert.equal(w.family, "weekly");
  assert.equal(w.kind, "unofficial");
  assert.equal(w.periodKey, "W20260802");
  assert.equal(w.roundCode, null);
});

test("the classifier accepts the zip, either member CSV, and the transposed file", () => {
  for (const n of [
    "AY_all_evaluated_2604.zip",
    "AY_all_evaluated_infoEVAL_2604.csv",
    "AY_all_evaluated_infoANIM_2604.csv",
    "AY_all_evaluated_2604_wide.csv",
    "/some/path/AY_all_evaluated_2604.zip",
  ]) {
    const id = classifyCdcbFile(n);
    assert.equal(id.kind, "official", n);
    assert.equal(id.periodKey, "R2604", n);
  }
});

test("an unrecognised name yields nulls rather than a wrong guess", () => {
  assert.equal(classifyCdcbFile("crossref_ALL_2608.csv").family, null);
  assert.equal(classifyCdcbFile("aistatus.txt").family, null);
  assert.equal(classifyCdcbFile("HO.GenomicRelationships.2607.00.zip").family, null);
  assert.equal(classifyCdcbFile("").family, null);
  // A young_Pub with a nonsense date shape is refused, not filed as a round.
  assert.equal(classifyCdcbFile("HO_young_Pub_26.zip").family, null);
});

test("round dates and labels", () => {
  assert.deepEqual(cdcbRoundDate(classifyCdcbFile("AY_all_evaluated_2604.zip")), new Date(Date.UTC(2026, 3, 1)));
  assert.equal(cdcbRoundLabel(classifyCdcbFile("AY_all_evaluated_2604.zip")), "April 2026");
  assert.equal(cdcbRoundLabel(classifyCdcbFile("HO_young_Pub_20260802.zip")), "Week of 2 Aug 2026");
});
