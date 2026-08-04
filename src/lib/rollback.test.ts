import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalRounds, computeRollback, type EvalLite } from "./rollback";

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
