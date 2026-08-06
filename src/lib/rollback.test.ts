import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRounds, computeRollback, traitStepDeltas, deltaScalesFrom, type EvalLite } from "./rollback";

const D = (y: number, m: number) => new Date(Date.UTC(y, m - 1, 1));
const ev = (y: number, m: number, kind: string | null, lpi: number): EvalLite => ({
  evaluationDate: D(y, m),
  proofRun: `${["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m]} ${y}`,
  reliabilityOverall: 0.9,
  runKind: kind,
  traitValues: [{ traitCode: "LPI", numericValue: lpi }],
});

test("canonicalRounds keeps the official row when a month has both", () => {
  const rows = canonicalRounds([ev(2025, 4, "interim", 2241), ev(2025, 4, "official", 2249)]);
  assert.equal(rows.length, 1, "the two files for April 2025 are one round");
  assert.equal(rows[0].runKind, "official");
  assert.equal(rows[0].traitValues[0].numericValue, 2249);
});

test("canonicalRounds is order-independent", () => {
  // Official first, interim second — must still keep the official.
  const rows = canonicalRounds([ev(2025, 4, "official", 2249), ev(2025, 4, "interim", 2241)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runKind, "official");
});

test("distinct months are all kept", () => {
  const rows = canonicalRounds([ev(2024, 12, "official", 2200), ev(2025, 4, "interim", 2241), ev(2025, 4, "official", 2249)]);
  assert.equal(rows.length, 2);
});

test("a same-month official/interim pair produces no phantom step", () => {
  // Two Decembers (official) around one April that exists as BOTH files. The walk
  // must see three rounds, not four, and must never compare the two April files
  // to each other.
  const r = computeRollback([
    ev(2024, 12, "official", 2000),
    ev(2025, 4, "interim", 1500), // provisional April, wildly different
    ev(2025, 4, "official", 1990), // settled April, close to December
    ev(2025, 8, "official", 1995),
  ]);
  // 3 canonical rounds → 2 steps for LPI.
  assert.equal(r.traits.LPI?.steps, 2, "one step per consecutive round pair, no phantom");
  // The April value used must be the official one (1990), so the Dec→Apr step is
  // a hold, not the collapse to 1500 the interim file would have implied.
  assert.equal(r.traits.LPI?.series[1], 1990);
  // Exactly one April step (Dec 2024 → Apr 2025), landing on the base change.
  assert.equal(r.traits.LPI?.rollbackSteps, 1);
});

test("interim-only history is unaffected — coverage is preserved", () => {
  const r = computeRollback([ev(2025, 5, "interim", 2000), ev(2025, 6, "interim", 2010), ev(2025, 7, "interim", 2005)]);
  assert.equal(r.traits.LPI?.steps, 2);
  assert.equal(r.proofPerformance != null, true);
});

test("null runKind rows (pre-field web lookups) still collapse by month and survive", () => {
  const r = computeRollback([ev(2025, 5, null, 2000), ev(2025, 6, null, 2010)]);
  assert.equal(r.traits.LPI?.steps, 1);
});

// --- SD-relative scoring for zero-centred traits (Fix 2) ---------------------

// A bull with a Conformation series. Conf is zero-centred, so it is scored against
// a lineup step SD rather than percent-of-previous.
const evConf = (y: number, m: number, conf: number): EvalLite => ({
  evaluationDate: D(y, m),
  proofRun: `${m}/${y}`,
  reliabilityOverall: 0.9,
  runKind: "official",
  traitValues: [{ traitCode: "LPI", numericValue: 3000 }, { traitCode: "CONF", numericValue: conf }],
});

test("a zero-centred trait crossing zero is NOT read as a total collapse", () => {
  const scales = { CONF: 4 }; // lineup typically moves Conf ~4 per round
  // Conf +1 → −1: a small 2-unit move that straddles zero. Under the old
  // percent-of-previous math this divided by ~1 and scored ~0 ("collapse").
  const r = computeRollback([evConf(2025, 4, 1), evConf(2025, 8, -1)], { traitScales: scales });
  const conf = r.traits.CONF!;
  assert.equal(conf.steps, 1);
  // 2-unit drop on a 4-SD scale → 100 + 3*(-2/4) = 98.5, nowhere near a collapse.
  assert.ok(conf.stepResistance > 95, `expected a mild penalty, got ${conf.stepResistance}`);
});

test("SD-relative retention is direction-symmetric (same move, opposite sign)", () => {
  const scales = { CONF: 4 };
  const drop = computeRollback([evConf(2025, 4, 6), evConf(2025, 8, 2)], { traitScales: scales }).traits.CONF!;
  const gain = computeRollback([evConf(2025, 4, 2), evConf(2025, 8, 6)], { traitScales: scales }).traits.CONF!;
  // A 4-unit gain holds (capped at 100); the equal drop is penalised — and the
  // penalty depends only on the move size, not on the base it started from.
  assert.equal(gain.stepResistance, 100);
  assert.ok(drop.stepResistance < 100 && drop.stepResistance > 90);
  // Same-size drop from a different base scores identically (base-independent).
  const dropHigh = computeRollback([evConf(2025, 4, 12), evConf(2025, 8, 8)], { traitScales: scales }).traits.CONF!;
  assert.equal(drop.stepResistance, dropHigh.stepResistance);
});

test("traitStepDeltas + deltaScalesFrom derive a per-trait step SD", () => {
  const deltas = traitStepDeltas([evConf(2025, 4, 10), evConf(2025, 8, 6), evConf(2025, 12, 8)]);
  assert.deepEqual(deltas.CONF, [-4, 2]); // consecutive moves
  assert.ok(!("LPI" in deltas), "ratio-scale LPI is skipped (no SD needed)");
  const scales = deltaScalesFrom({ CONF: [-4, 2, -2, 4, 0] });
  assert.ok(scales.CONF > 0);
});
