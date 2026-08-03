import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTrait, buildTraitStats, weightedTrend, nextPeriod, runBacktest, type TraitStats } from "./proof-forecast";

const d = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1));
const obs = (pairs: [number, number, number][]) => pairs.map(([y, m, v]) => ({ date: d(y, m), value: v }));

/** Cohort stats with no systematic shift and a known spread. */
const flatStats = (level = 3000, sd = 50): TraitStats => ({
  level,
  drift: { mean: 0, sd, n: 100 },
  aprilMean: 0, aprilN: 100,
  ordinaryMean: 0, ordinaryN: 100,
});

test("weightedTrend leans on the most recent step", () => {
  // Recent step is +30, older ones 0 → trend must be positive but below 30.
  const t = weightedTrend([0, 0, 30]);
  assert.ok(t > 0 && t < 30, `expected 0 < ${t} < 30`);
  // A single step is taken at face value.
  assert.equal(weightedTrend([10]), 10);
  assert.equal(weightedTrend([]), 0);
});

test("an ordinary round holds the current value (persistence beat every correction)", () => {
  // Backtesting showed extrapolation makes ordinary rounds WORSE, so a rising
  // bull is still projected at his current value between base changes.
  const series = obs([[2024, 4, 3000], [2024, 8, 3050], [2024, 12, 3100]]);
  const p = projectTrait(series, flatStats(), { targetIsApril: false, reliability: 0.95 })!;
  assert.equal(p.predicted, 3100, "ordinary rounds default to the current proof");
  // ...but the band still has to be real.
  assert.ok(p.hi > p.predicted && p.lo < p.predicted, "an interval is still published");
});

test("a bull is never dragged toward the lineup average", () => {
  // A high bull with a flat history must stay where he is: each bull is
  // predicted from his OWN series, not pulled to the cohort mean.
  const series = obs([[2024, 4, 4000], [2024, 8, 4000], [2024, 12, 4000]]);
  const low = projectTrait(series, flatStats(3000), { targetIsApril: false, reliability: 0.3 })!;
  assert.equal(low.predicted, 4000, "no regression toward the cohort level");
});

test("an April target applies the cohort base change; a normal round does not", () => {
  const stats: TraitStats = { ...flatStats(), aprilMean: -40, aprilN: 50, ordinaryMean: 0, ordinaryN: 50 };
  const series = obs([[2024, 8, 3000], [2024, 12, 3000]]);
  const april = projectTrait(series, stats, { targetIsApril: true, reliability: 0.95 })!;
  const normal = projectTrait(series, stats, { targetIsApril: false, reliability: 0.95 })!;
  assert.ok(april.predicted < normal.predicted, "April must project lower when the base change is negative");
  assert.ok(Math.abs(april.predicted - 2960) < 1, `expected ≈2960, got ${april.predicted}`);
  assert.equal(normal.predicted, 3000, "an ordinary round carries no base change");
});

test("a PUBLISHED base change overrides the historical estimate", () => {
  // Lactanet publishes the real shift; it must win over what past Aprils did.
  const stats: TraitStats = { ...flatStats(), aprilMean: -40, aprilN: 50 };
  const series = obs([[2024, 8, 3000], [2024, 12, 3000]]);
  // Base rose by 82 → the bull's published value falls by 82.
  const p = projectTrait(series, stats, { targetIsApril: true, reliability: 0.95, publishedShift: -82 })!;
  assert.equal(p.predicted, 2918, "published shift applied exactly");
  assert.equal(p.basis, "base change");
});

test("the interval comes from the cohort's real spread and contains the prediction", () => {
  const series = obs([[2024, 4, 3000], [2024, 8, 3010], [2024, 12, 3020]]);
  const narrow = projectTrait(series, flatStats(3000, 10), { targetIsApril: false, reliability: 0.9 })!;
  const wide = projectTrait(series, flatStats(3000, 100), { targetIsApril: false, reliability: 0.9 })!;
  assert.ok(wide.hi - wide.lo > narrow.hi - narrow.lo, "a more volatile trait needs a wider band");
  for (const p of [narrow, wide]) {
    assert.ok(p.lo <= p.predicted && p.predicted <= p.hi, "prediction must sit inside its own band");
    assert.ok(p.hi > p.lo, "the band must have width");
  }
});

test("a single round yields a hold, not a fabricated trend", () => {
  const p = projectTrait(obs([[2024, 12, 2500]]), flatStats(2500), { targetIsApril: false, reliability: 0.8 })!;
  assert.equal(p.basis, "hold");
  assert.equal(p.steps, 0);
  // No history to extrapolate: the value should stay put (no cohort shift here).
  assert.ok(Math.abs(p.predicted - 2500) < 1e-6);
});

test("empty history projects nothing rather than guessing", () => {
  assert.equal(projectTrait([], flatStats(), { targetIsApril: false, reliability: 0.9 }), null);
});

test("buildTraitStats separates April steps from ordinary ones", () => {
  // Two bulls, each dropping 100 on the April round and gaining 10 otherwise.
  const mk = () => ({
    rounds: [
      { date: d(2024, 12), traits: new Map([["LPI", 3000]]) },
      { date: d(2025, 4), traits: new Map([["LPI", 2900]]) },  // April: -100
      { date: d(2025, 8), traits: new Map([["LPI", 2910]]) },  // ordinary: +10
    ],
  });
  const stats = buildTraitStats([mk(), mk(), mk(), mk(), mk()], new Set(["LPI"]));
  const s = stats.get("LPI")!;
  assert.equal(s.aprilMean, -100);
  assert.equal(s.ordinaryMean, 10);
  assert.equal(s.level, 2910, "level is the mean of the most recent values");
});

test("nextPeriod follows the cadence actually present in the data", () => {
  // Quarterly-ish rounds (4-month gaps) → next is 4 months on.
  const next = nextPeriod([d(2025, 4), d(2025, 8), d(2025, 12)]);
  assert.equal(next.getUTCFullYear(), 2026);
  assert.equal(next.getUTCMonth(), 3, "expected April 2026");
  // Monthly interims → next month.
  const monthly = nextPeriod([d(2026, 1), d(2026, 2), d(2026, 3)]);
  assert.equal(monthly.getUTCMonth(), 3);
  // A single known round still has to produce a later one.
  assert.ok(nextPeriod([d(2026, 5)]).getTime() > d(2026, 5).getTime());
});

test("backtest scores the April base change against the naive rule", () => {
  // Every bull drops 100 on each April. A model that knows about base changes
  // must beat "assume no change" on an April target.
  const bulls = Array.from({ length: 12 }, (_, i) => ({
    rounds: [
      { date: d(2023, 12), reliability: 0.9, traits: new Map([["LPI", 3000 + i]]) },
      { date: d(2024, 4), reliability: 0.9, traits: new Map([["LPI", 2900 + i]]) },  // April −100
      { date: d(2024, 12), reliability: 0.9, traits: new Map([["LPI", 2900 + i]]) },
      { date: d(2025, 4), reliability: 0.9, traits: new Map([["LPI", 2800 + i]]) },  // April −100
    ],
  }));
  const bt = runBacktest(bulls, new Set(["LPI"]));
  assert.equal(bt.ran, true);
  assert.equal(bt.bulls, 12);
  const lpi = bt.traits.find((t) => t.code === "LPI")!;
  assert.ok(lpi.mae < lpi.naiveMae, `model MAE ${lpi.mae} should beat naive ${lpi.naiveMae}`);
  assert.ok(lpi.skill > 0, "positive skill expected when a real base change exists");

  // Too few bulls to measure anything → says so instead of inventing accuracy.
  const thin = runBacktest(bulls.slice(0, 2), new Set(["LPI"]));
  assert.equal(thin.ran, false);
  assert.equal(thin.traits.length, 0);
});
