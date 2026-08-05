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
  CORRECTION_TRAITS,
  INTERMEDIATE_TARGETS,
  correctionCentre,
  correctionNote,
  correctionTrait,
  deficit,
  idealBullValue,
  improvesWeakness,
  isIntermediate,
  isPositiveImprover,
  matingFit,
  targetFor,
  worsensWeakness,
} from "./mating-targets";
import {
  LOWER_IS_BETTER,
  MATING_DISPLAY_TRAITS,
  MATING_INDEXES,
  matingDisplayOnly,
  rankWeaknesses,
  type WeaknessInput,
} from "./mating-score";
import { KEY_TRAITS } from "./key-traits";

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

// --- the never-worsen floor: the whole safety guarantee ---------------------
// worsensWeakness is what stands between a cow's real fault and a bull who would
// deepen it. If this returns the wrong answer nothing throws — the report just
// recommends the bull that makes her daughter worse, which is the exact outcome
// the user asked to make impossible.

test("never-worsen floor: a directional weakness is worsened only by a bull BELOW the cow", () => {
  // Daughter Fertility, base 100. She is 92.
  assert.equal(worsensWeakness("DF", 92, 88), true, "a bull below her drops the daughter — a setback");
  assert.equal(worsensWeakness("DF", 92, 92), false, "an equal bull holds her line — not a setback");
  assert.equal(worsensWeakness("DF", 92, 105), false, "a bull above her lifts the daughter — a fix");
});

test("never-worsen floor: for a LOWER-is-better trait, worse means a HIGHER bull", () => {
  // SCS, healthy is low. She is 3.2.
  assert.equal(worsensWeakness("SCS", 3.2, 3.6, true), true, "a higher-SCS bull worsens udder health");
  assert.equal(worsensWeakness("SCS", 3.2, 2.8, true), false, "a lower-SCS bull improves it");
});

test("never-worsen floor: for an INTERMEDIATE trait, worse means further from target", () => {
  // Stature, target 0. She is already +10 (too tall).
  assert.equal(worsensWeakness("STA", 10, 14), true, "a taller bull pushes the daughter further from 0");
  assert.equal(worsensWeakness("STA", 10, -10), false, "the -10 bull lands her daughter exactly on target");
  assert.equal(worsensWeakness("STA", 10, 6), false, "a bull that halves the excess is an improvement, not a setback");
});

test("never-worsen floor is base-INDEPENDENT — it works with no known base", () => {
  // Conformation has no fixed base here (base 'pool'), yet the floor is still
  // well defined because it compares the daughter with the cow, not with a base.
  assert.equal(worsensWeakness("CONF", 8, 6), true, "a bull below her lowers her daughter's type");
  assert.equal(worsensWeakness("CONF", 8, 12), false, "a bull above her raises it");
});

test("improvesWeakness is strict — holding the line is NOT improving", () => {
  assert.equal(improvesWeakness("DF", 92, 100), true);
  assert.equal(improvesWeakness("DF", 92, 92), false, "equal is not an improvement");
  assert.equal(improvesWeakness("DF", 92, 88), false);
});

// --- strict "only bulls that are positive" ----------------------------------

test("isPositiveImprover means the bull is on the good side of the BASE, not just above the cow", () => {
  // DF base 100. A bull at 96 improves a cow at 92 but is not himself positive.
  assert.equal(isPositiveImprover("DF", 92, 96, 100), false, "96 lifts her but is still below the 100 base");
  assert.equal(isPositiveImprover("DF", 92, 101, 100), true, "101 is genuinely positive for fertility");
});

test("isPositiveImprover flips for a lower-is-better trait", () => {
  // SCS base 3.0, positive = below it.
  assert.equal(isPositiveImprover("SCS", 3.2, 2.8, 3.0, true), true);
  assert.equal(isPositiveImprover("SCS", 3.2, 3.1, 3.0, true), false, "3.1 helps her but is still above the base");
});

test("for an intermediate trait, 'positive' just means it improves her", () => {
  // No single 'positive' side exists, so strict falls back to improvement.
  assert.equal(isPositiveImprover("STA", 10, -10, 0), true, "lands her on target");
  assert.equal(isPositiveImprover("STA", 10, 14, 0), false, "makes her taller still");
});

// --- correction bases -------------------------------------------------------

test("each correction trait uses its own published base, never one origin", () => {
  assert.equal(correctionCentre("DF", null), 100, "functional RBV");
  assert.equal(correctionCentre("MSPD", null), 100, "functional RBV");
  assert.equal(correctionCentre("BQ", null), 0, "linear deviation");
  assert.equal(correctionCentre("MILK", null), 0, "kg deviation");
  assert.equal(correctionCentre("STA", null), 0, "intermediate target");
  assert.equal(correctionCentre("RA", null), 2, "intermediate target, not 0");
});

test("the scale-ambiguous traits take the pool mean, and are uncorrectable without it", () => {
  assert.equal(correctionCentre("CONF", 11), 11, "Conformation has no fixed base — use the pool mean");
  assert.equal(correctionCentre("CONF", null), null, "no pool mean ⇒ uncorrectable, never centred on 0");
  assert.equal(correctionCentre("MAMM", null), null);
  // SCS is published on a ~3.0 score in some rounds and a ~100 index in others,
  // so it too reads the pool mean rather than a base that is right for only one.
  assert.equal(correctionCentre("SCS", 100), 100);
  assert.equal(correctionCentre("SCS", null), null);
});

test("LPI and Pro$ are money indexes you MAXIMISE — never correction faults", () => {
  const codes = new Set(CORRECTION_TRAITS.map((t) => t.code));
  assert.ok(!codes.has("LPI"), "LPI must not be a correction trait");
  assert.ok(!codes.has("PRO$"), "Pro$ must not be a correction trait");
  // Milking Speed and Bone Quality — the meeting cow's needs — ARE, and are deep.
  assert.equal(correctionTrait("MSPD")?.deep, true, "Milking Speed has no fast column");
  assert.equal(correctionTrait("BQ")?.deep, true, "Bone Quality has no fast column");
  assert.equal(correctionTrait("DF")?.deep, false, "Daughter Fertility is an indexed column");
});

// --- the mating report must show what the proof reports show ----------------

test("every KEY_TRAIT the proof reports show is visible on the mating report", () => {
  const shown = new Set(MATING_DISPLAY_TRAITS.map((t) => t.code));
  for (const kt of KEY_TRAITS) {
    assert.ok(shown.has(kt.code), `${kt.code} is on the proof reports but not the mating report`);
  }
  // …and in the reports' own order, so a bull reads the same left to right.
  const firstNine = MATING_DISPLAY_TRAITS.slice(0, KEY_TRAITS.length).map((t) => t.code);
  assert.deepEqual(firstNine, KEY_TRAITS.map((t) => t.code));
});

test("labels match the proof reports exactly — no 'Fat %' vs 'Fat Percent' drift", () => {
  const byCode = new Map(MATING_DISPLAY_TRAITS.map((t) => [t.code, t.label]));
  for (const kt of KEY_TRAITS) assert.equal(byCode.get(kt.code), kt.label, `${kt.code} label`);
});

test("a displayed trait with no indexed column is named, not silently unrankable", () => {
  const rankable = new Set(MATING_INDEXES.map((i) => i.code));
  const displayOnly = matingDisplayOnly().map((t) => t.code);
  // Milking Speed has no column in TRAIT_COLUMNS, so it can be shown but not ranked.
  assert.deepEqual(displayOnly, ["MSPD"]);
  assert.ok(!rankable.has("MSPD"));
  // Everything else the proof reports show IS rankable here.
  for (const kt of KEY_TRAITS) {
    if (kt.code === "MSPD") continue;
    assert.ok(rankable.has(kt.code), `${kt.code} should be rankable`);
  }
});
