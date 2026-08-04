// Corrective-mating direction. These tests exist because getting the sign
// wrong here does not throw, does not fail a typecheck, and does not look wrong
// on screen — it just quietly recommends bulls that make the next generation
// worse. Every case below is one a breeder would notice in the barn three years
// later.
//
//   npx tsx --test src/lib/mating-targets.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  INTERMEDIATE_TARGETS,
  correctionNote,
  deficit,
  idealBullValue,
  isIntermediate,
  matingFit,
  targetFor,
} from "./mating-targets";
import { LOWER_IS_BETTER, rankWeaknesses, type WeaknessInput } from "./mating-score";

/** Rank bulls for one cow on one trait, best first. */
function rankBulls(code: string, cowValue: number, bulls: number[], lowerIsBetter = false): number[] {
  return [...bulls].sort(
    (a, b) => matingFit(code, cowValue, b, lowerIsBetter) - matingFit(code, cowValue, a, lowerIsBetter),
  );
}

// --- the case the whole feature exists for --------------------------------

test("a TALL cow gets a SHORT bull — the +14 sire is the worst answer, not the best", () => {
  const ranked = rankBulls("STA", 10, [14, 6, 0, -10]);
  assert.equal(ranked[0], -10, "the -10 bull lands her daughter on target and must rank first");
  assert.equal(ranked[ranked.length - 1], 14, "the +14 bull makes her daughter worse and must rank last");
  // The database flags every linear trait higherIsBetter, which would pick +14.
  assert.ok(
    matingFit("STA", 10, -10) > matingFit("STA", 10, 14),
    "corrective direction must beat a naive higher-is-better ranking",
  );
});

test("a SHORT cow gets a TALL bull — correction works in both directions", () => {
  const ranked = rankBulls("STA", -8, [8, 2, -4, -14]);
  assert.equal(ranked[0], 8, "she is below target, so the +8 bull is the corrective one");
  assert.equal(ranked[ranked.length - 1], -14);
});

test("idealBullValue is 2*target - cow, so the daughter lands exactly on target", () => {
  for (const [code, target] of Object.entries(INTERMEDIATE_TARGETS)) {
    for (const cow of [-12, -5, 0, 5, 12]) {
      const bull = idealBullValue(code, cow);
      assert.notEqual(bull, null, `${code} must be target-seeking`);
      assert.equal((cow + (bull as number)) / 2, target, `${code}: daughter should land on ${target}`);
    }
  }
});

test("every intermediate trait uses its OWN target, not a hard-coded zero", () => {
  assert.equal(targetFor("RA"), 2);
  assert.equal(targetFor("FTP"), 2);
  assert.equal(targetFor("RTP"), 2);
  assert.equal(targetFor("BODY"), 1);
  assert.equal(targetFor("STA"), 0);
  assert.equal(targetFor("TL"), 0);
  assert.equal(targetFor("RLSV"), 0);
  // A cow already at the +2 Rump Angle target needs an on-target bull, not a high one.
  assert.equal(idealBullValue("RA", 2), 2);
  assert.equal(rankBulls("RA", 2, [14, 2, -10])[0], 2);
});

test("directional traits are untouched — higher bull still wins", () => {
  assert.equal(isIntermediate("FUA"), false);
  assert.equal(targetFor("FUA"), null);
  assert.equal(idealBullValue("FUA", -5), null, "a directional trait has no single ideal");
  assert.deepEqual(rankBulls("FUA", -5, [14, 6, -10]), [14, 6, -10]);
});

test("a lower-is-better trait prefers the LOWER bull", () => {
  const ranked = rankBulls("SCS", 3.2, [2.6, 3.0, 3.6], true);
  assert.equal(ranked[0], 2.6);
  assert.equal(ranked[ranked.length - 1], 3.6);
});

// --- weighting -------------------------------------------------------------

test("deficit measures distance from target either side, and is 0 when on target", () => {
  assert.equal(deficit("STA", 11), 11);
  assert.equal(deficit("STA", -11), 11, "below target is just as much a fault as above");
  assert.equal(deficit("STA", 0), 0);
  assert.equal(deficit("RA", 2), 0, "on its own +2 target");
  assert.equal(deficit("RA", 7), 5);
});

test("a directional deficit is measured against the population centre, not zero", () => {
  // Conformation averages ~11 in this lineup and Daughter Fertility ~100.
  // Against an assumed origin of 0 both would report no fault at all.
  assert.equal(deficit("CONF", 8, 11), 3);
  assert.equal(deficit("DF", 92, 100), 8);
  assert.equal(deficit("CONF", 15, 11), 0, "above the population is not a fault");
});

test("rankWeaknesses cannot silently zero a 100-based trait", () => {
  const inputs: WeaknessInput[] = [
    { code: "DF", label: "Daughter Fertility", cowValue: 88, mean: 100, sd: 6 },
    { code: "CONF", label: "Conformation", cowValue: 8, mean: 11, sd: 4 },
    { code: "MILK", label: "Milk", cowValue: 900, mean: 555, sd: 400 },
  ];
  const { weaknesses, ranked } = rankWeaknesses(inputs, 5, LOWER_IS_BETTER);
  const codes = ranked.map((w) => w.code);
  assert.ok(codes.includes("DF"), "a cow 12 points below average on fertility IS weak");
  assert.ok(codes.includes("CONF"), "a cow below the population on type IS weak");
  assert.ok(!codes.includes("MILK"), "she is above the population on milk — not a fault");
  const total = weaknesses.reduce((s, w) => s + w.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, "weights must be normalised so the blend is honest");
});

test("a trait with no known population centre is named, never scored zero", () => {
  const { ranked, uncorrectable } = rankWeaknesses(
    [{ code: "MSPD", label: "Milking Speed", cowValue: 90, mean: null, sd: 5 }],
    5,
    LOWER_IS_BETTER,
  );
  assert.equal(ranked.length, 0);
  assert.deepEqual(uncorrectable.map((u) => u.code), ["MSPD"]);
});

test("a cow with no value for a trait is unassessable, not perfect", () => {
  const { ranked, unassessable } = rankWeaknesses(
    [{ code: "CONF", label: "Conformation", cowValue: null, mean: 11, sd: 4 }],
    5,
    LOWER_IS_BETTER,
  );
  assert.equal(ranked.length, 0);
  assert.deepEqual(unassessable.map((u) => u.code), ["CONF"]);
});

test("a cow already on target carries no correction weight", () => {
  const { weaknesses } = rankWeaknesses(
    [
      { code: "STA", label: "Stature", cowValue: 0, mean: null, sd: 5 },
      { code: "RA", label: "Rump Angle", cowValue: 9, mean: null, sd: 5 },
    ],
    5,
    LOWER_IS_BETTER,
  );
  assert.deepEqual(weaknesses.map((w) => w.code), ["RA"], "only the trait off target is corrected");
  assert.equal(weaknesses[0].weight, 1);
});

test("correctionNote tells the breeder which way to go", () => {
  const up = correctionNote("STA", "Stature", -8) ?? "";
  assert.match(up, /below/);
  assert.match(up, /\+8/);
  const down = correctionNote("STA", "Stature", 10) ?? "";
  assert.match(down, /above/);
  assert.match(down, /-10/);
  assert.equal(correctionNote("STA", "Stature", 0), null, "nothing to say when she is on target");
});
