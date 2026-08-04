import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCorpus, forecastTrait, quantileOf, cohortFacts, roundKindOf,
  QUANTILES, K, MIN_NEIGHBOURS,
  type AnalogueBull, type AnalogueRound,
} from "./proof-analogue";

const CODES = ["LPI", "CONF"];

/**
 * A synthetic lineup. Each bull walks a deterministic path so the assertions can
 * be exact: bull i moves by (i % 7) - 3 each interim round, so the cohort spans
 * a known range of behaviours and no bull is identical to another.
 */
function makeLineup(bullCount: number, roundCount: number): AnalogueBull[] {
  const bulls: AnalogueBull[] = [];
  for (let i = 0; i < bullCount; i++) {
    const rounds: AnalogueRound[] = [];
    let lpi = 2500 + i * 7;
    let conf = 5 + (i % 11);
    for (let r = 0; r < roundCount; r++) {
      // Months 1,2,3,5,6,7,9,10,11 — deliberately skipping April, August and
      // December so every generated round is an interim unless asked otherwise.
      const month = [1, 2, 3, 5, 6, 7, 9, 10, 11][r % 9];
      const year = 2020 + Math.floor(r / 9);
      const date = new Date(Date.UTC(year, month - 1, 1));
      rounds.push({
        time: date.getTime(),
        kind: roundKindOf(date),
        rel: 0.7 + (i % 20) / 100,
        daughters: i % 3 === 0 ? null : i * 2,
        sireType: i % 3 === 0 ? "genomic" : "proven",
        traits: new Map([["LPI", lpi], ["CONF", conf]]),
      });
      lpi += (i % 7) - 3;
      conf += r % 5 === 0 ? 1 : 0;
    }
    bulls.push({ id: `bull-${i}`, birthTime: Date.UTC(2015 + (i % 5), 0, 1), rounds });
  }
  return bulls;
}

const future = Date.UTC(2030, 0, 1);

test("quantileOf interpolates and clamps at the ends", () => {
  const xs = [0, 10, 20, 30, 40];
  assert.equal(quantileOf(xs, 0), 0);
  assert.equal(quantileOf(xs, 1), 40);
  assert.equal(quantileOf(xs, 0.5), 20);
  assert.equal(quantileOf(xs, 0.25), 10);
  // Out-of-range probabilities are clamped rather than throwing.
  assert.equal(quantileOf(xs, -1), 0);
  assert.equal(quantileOf(xs, 2), 40);
  assert.equal(quantileOf([], 0.5), 0);
  assert.equal(quantileOf([7], 0.9), 7);
});

test("a forecast returns monotone quantiles and coherent probabilities", () => {
  const bulls = makeLineup(60, 20);
  const corpus = buildCorpus(bulls, CODES);
  const f = forecastTrait(corpus, "LPI", bulls[0], "interim", future);
  assert.ok(f, "expected a forecast");
  assert.equal(f!.quantiles.length, QUANTILES.length);
  for (let i = 1; i < f!.quantiles.length; i++) {
    assert.ok(f!.quantiles[i] >= f!.quantiles[i - 1], `quantiles must not cross at ${i}`);
  }
  assert.ok(f!.lo <= f!.hi, "lo must not exceed hi");
  const total = f!.pUp + f!.pDown + f!.pSteady;
  assert.ok(Math.abs(total - 1) < 1e-9, `probabilities must sum to 1, got ${total}`);
  assert.ok(f!.expectedMove >= 0, "expected move is a magnitude");
  assert.ok(f!.zeroShare >= 0 && f!.zeroShare <= 1);
});

test("with a full lineup the analogue path is used, not the cohort fallback", () => {
  const bulls = makeLineup(60, 20);
  const corpus = buildCorpus(bulls, CODES);
  const f = forecastTrait(corpus, "LPI", bulls[3], "interim", future);
  assert.equal(f!.basis, "analogue");
  assert.equal(f!.neighbours, K);
});

test("too few analogues falls back to the cohort band rather than guessing", () => {
  // 8 bulls x 6 rounds gives well under MIN_NEIGHBOURS eligible cases.
  const bulls = makeLineup(8, 6);
  const corpus = buildCorpus(bulls, CODES);
  const f = forecastTrait(corpus, "LPI", bulls[0], "interim", future);
  assert.ok(f, "a fallback band is still a band");
  assert.equal(f!.basis, "cohort");
  assert.ok(f!.neighbours < MIN_NEIGHBOURS);
});

test("an April target is refused — a base change is published, not modelled", () => {
  const bulls = makeLineup(60, 20);
  const corpus = buildCorpus(bulls, CODES);
  assert.equal(forecastTrait(corpus, "LPI", bulls[0], "april", future), null);
});

test("an unknown trait yields no forecast", () => {
  const bulls = makeLineup(30, 12);
  const corpus = buildCorpus(bulls, CODES);
  assert.equal(forecastTrait(corpus, "NOPE", bulls[0], "interim", future), null);
});

/**
 * THE LEAKAGE TEST.
 *
 * Every feature must read only rounds strictly before the one being predicted.
 * An earlier experimental feature (daughters gained) violated this by reading
 * the predicted round's daughter count, and it looked like the strongest signal
 * in the model precisely because it was cheating.
 *
 * So: change everything about the target round except the history behind it, and
 * the forecast must not move by even a floating-point tick.
 */
test("the forecast cannot see the round it is predicting", () => {
  const base = makeLineup(60, 20);
  const corpus = buildCorpus(base, CODES);
  const bull = base[5];
  const before = forecastTrait(corpus, "LPI", bull, "interim", future, { historyLength: 12 });

  // Rewrite every round from index 12 onwards — the future, as far as a forecast
  // made at round 12 is concerned.
  const tampered: AnalogueBull = {
    ...bull,
    rounds: bull.rounds.map((r, i) => (i < 12 ? r : {
      ...r,
      rel: 0.99,
      daughters: 9999,
      sireType: "proven",
      traits: new Map([["LPI", 9999], ["CONF", 99]]),
    })),
  };
  const after = forecastTrait(corpus, "LPI", tampered, "interim", future, { historyLength: 12 });

  assert.ok(before && after);
  assert.equal(after!.lo, before!.lo);
  assert.equal(after!.hi, before!.hi);
  assert.deepEqual(after!.quantiles, before!.quantiles);
  assert.equal(after!.expectedMove, before!.expectedMove);
});

test("a bull is never his own analogue", () => {
  // One bull is given a wildly distinctive history. If he were allowed to match
  // himself his own huge moves would dominate his band.
  const bulls = makeLineup(60, 20);
  const odd = bulls[0];
  let v = 5000;
  for (const r of odd.rounds) { r.traits.set("LPI", v); v += 500; }
  const corpus = buildCorpus(bulls, CODES);
  const f = forecastTrait(corpus, "LPI", odd, "interim", future);
  assert.ok(f);
  // Every other bull moves by at most 3 per round, so a band anywhere near 500
  // would prove he had matched himself.
  assert.ok(f!.hi - f!.lo < 100, `band ${f!.lo}-${f!.hi} suggests self-matching`);
});

test("neighbours come only from the same kind of round", () => {
  // Interims and official rounds behave differently, so mixing them would widen
  // an official-round band with interim noise.
  const bulls = makeLineup(60, 20);
  // Give every bull an August (official) round with a much larger jump.
  for (const b of bulls) {
    const t = Date.UTC(2022, 7, 1);
    const lastLpi = b.rounds[b.rounds.length - 1].traits.get("LPI") ?? 2500;
    b.rounds.push({
      time: t, kind: roundKindOf(new Date(t)), rel: 0.9, daughters: 100, sireType: "proven",
      traits: new Map([["LPI", lastLpi + 400], ["CONF", 6]]),
    });
    b.rounds.sort((x, y) => x.time - y.time);
  }
  const corpus = buildCorpus(bulls, CODES);
  const interim = forecastTrait(corpus, "LPI", bulls[1], "interim", future);
  assert.ok(interim, "interim forecast expected");
  // The +400 official jumps must not leak into the interim band.
  assert.ok(interim!.hi - interim!.lo < 100, `interim band ${interim!.lo}-${interim!.hi} looks contaminated by official rounds`);
});

test("cohortFacts describes the round kind actually asked for", () => {
  const bulls = makeLineup(40, 18);
  const corpus = buildCorpus(bulls, CODES);
  const facts = cohortFacts(corpus, "LPI", "interim");
  assert.ok(facts);
  assert.ok(facts!.n > 0);
  assert.ok(facts!.zeroShare >= 0 && facts!.zeroShare <= 1);
  assert.ok(facts!.typicalMove >= 0);
  // No official rounds were generated, so there is nothing to describe.
  assert.equal(cohortFacts(corpus, "LPI", "official"), null);
});

test("a bull with a single round produces no forecast", () => {
  const bulls = makeLineup(60, 20);
  const lonely: AnalogueBull = { id: "lonely", birthTime: null, rounds: [bulls[0].rounds[0]] };
  const corpus = buildCorpus(bulls, CODES);
  assert.equal(forecastTrait(corpus, "LPI", lonely, "interim", future, { historyLength: 0 }), null);
});
