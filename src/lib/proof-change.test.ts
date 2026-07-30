// Unit tests for the Proof Change diff + SD flagging. Pure — no DB/network.
//   npm run test:reports
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRawChange, finalizeCohort, traitStdStats, sdFromParam, periodKey, KEY_TRAIT_CODES } from "./proof-change";
import type { TraitDefLite } from "./eval-traits";

const defMap = new Map<string, TraitDefLite>([
  ["LPI", { name: "LPI", category: "Index", unit: null, order: 1 }],
  ["MILK", { name: "Milk", category: "Production", unit: "kg", order: 2 }],
  ["FATPCT", { name: "Fat %", category: "Production", unit: "%", order: 3 }],
  ["SCS", { name: "Somatic Cell Score", category: "Health", unit: null, order: 4 }],
]);
const pack = (o: Record<string, number>) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v }])));
const d = (iso: string) => new Date(iso + "T00:00:00Z");

/** A bull whose LPI goes prev -> prev+delta between April and July. */
const bull = (lpiPrev: number, lpiLatest: number, extra: Record<string, number> = {}, extraPrev: Record<string, number> = {}) => [
  { proofRun: "July 2026", evaluationDate: d("2026-07-01"), traitsJson: pack({ LPI: lpiLatest, ...extra }) },
  { proofRun: "April 2026", evaluationDate: d("2026-04-01"), traitsJson: pack({ LPI: lpiPrev, ...extraPrev }) },
];

test("compares latest against the previous OFFICIAL proof (skips interims)", () => {
  const raw = computeRawChange([
    { proofRun: "July 2026", evaluationDate: d("2026-07-01"), traitsJson: pack({ LPI: 3100, MILK: 500 }) },  // latest interim
    { proofRun: "June 2026", evaluationDate: d("2026-06-01"), traitsJson: pack({ LPI: 3050, MILK: 480 }) },  // interim — skipped
    { proofRun: "April 2026", evaluationDate: d("2026-04-01"), traitsJson: pack({ LPI: 3000, MILK: 400 }) }, // previous official
  ], defMap);
  assert.equal(raw.found, true);
  assert.equal(raw.latestRun, "July 2026");
  assert.equal(raw.previousRun, "April 2026");
  assert.equal(raw.lpiDelta, 100);
});

test("returns found=false when there is no previous official proof", () => {
  const raw = computeRawChange([
    { proofRun: "July 2026", evaluationDate: d("2026-07-01"), traitsJson: pack({ LPI: 3100 }) },
    { proofRun: "June 2026", evaluationDate: d("2026-06-01"), traitsJson: pack({ LPI: 3050 }) },
  ], defMap);
  assert.equal(raw.found, false);
});

test("traitStdStats computes population mean and SD", () => {
  const s = traitStdStats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5);
  assert.equal(s.sd, 2); // textbook population SD
  assert.equal(s.n, 8);
});

test("flags the outlier bull, not the ones that moved with the herd", () => {
  // Nine bulls move ~+100 LPI; one jumps +400. Only the outlier should flag.
  const raws = [100, 100, 100, 100, 100, 100, 100, 100, 100, 400].map((delta) =>
    computeRawChange(bull(3000, 3000 + delta), defMap));
  const out = finalizeCohort(raws, 1);
  const outlier = out[out.length - 1];
  const typical = out[0];
  assert.equal(outlier.keyChanges.find((k) => k.code === "LPI")?.flagged, true);
  assert.equal(typical.keyChanges.find((k) => k.code === "LPI")?.flagged, false);
  assert.ok((outlier.keyChanges.find((k) => k.code === "LPI")?.z ?? 0) > 1);
});

test("a herd-wide base shift alone does not flag anyone", () => {
  // Every bull drops exactly 200 (a base change). SD is 0 -> nothing unusual.
  const raws = Array.from({ length: 10 }, () => computeRawChange(bull(3000, 2800), defMap));
  const out = finalizeCohort(raws, 1);
  assert.equal(out.every((b) => b.flaggedCount === 0), true);
});

test("sensitivity multiplier changes what clears the bar", () => {
  // A realistically spread cohort (mean 100, SD 50). The last bull is +140,
  // i.e. ~0.8 SD out: flagged at 0.5 SD, but not at 1 SD.
  const deltas = [0, 50, 50, 100, 100, 100, 150, 150, 200, 140];
  const raws = deltas.map((x) => computeRawChange(bull(3000, 3000 + x), defMap));
  const atHalf = finalizeCohort(raws, 0.5);
  const atOne = finalizeCohort(raws, 1);
  const i = deltas.length - 1;
  assert.equal(atHalf[i].keyChanges.find((k) => k.code === "LPI")?.flagged, true);
  assert.equal(atOne[i].keyChanges.find((k) => k.code === "LPI")?.flagged, false);
});

test("only KEY traits drive 'significant'; other flagged traits are listed separately", () => {
  // LPI moves with the herd for everyone; SCS (non-key) is the outlier on one bull.
  const raws = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1].map((bump) =>
    computeRawChange(bull(3000, 3100, { SCS: 300 + bump * 90 }, { SCS: 300 }), defMap));
  const out = finalizeCohort(raws, 1);
  const odd = out[out.length - 1];
  assert.ok(!KEY_TRAIT_CODES.includes("SCS"));
  assert.equal(odd.otherFlagged.some((t) => t.code === "SCS"), true, "SCS should be flagged");
  assert.equal(odd.keyFlaggedCount, 0, "no KEY trait moved unusually, so not 'significant'");
  assert.ok(odd.flaggedCount > odd.keyFlaggedCount);
});

test("keeps a reference % but guards a near-zero denominator", () => {
  const raw = computeRawChange([
    { proofRun: "Aug 2026", evaluationDate: d("2026-08-01"), traitsJson: pack({ LPI: 3000, FATPCT: 0.05 }) },
    { proofRun: "Apr 2026", evaluationDate: d("2026-04-01"), traitsJson: pack({ LPI: 3000, FATPCT: 0.0 }) },
  ], defMap);
  const fat = raw.changes.find((c) => c.code === "FATPCT");
  assert.equal(fat?.delta, 0.05);
  assert.equal(fat?.pct, null); // no divide-by-~zero blow-up
});

// --- explicit round selection ---------------------------------------------

const threeRounds = [
  { proofRun: "July 2026", evaluationDate: d("2026-07-01"), traitsJson: pack({ LPI: 3300 }) },
  { proofRun: "April 2026", evaluationDate: d("2026-04-01"), traitsJson: pack({ LPI: 3200 }) },
  { proofRun: "December 2025", evaluationDate: d("2025-12-01"), traitsJson: pack({ LPI: 3000 }) },
];

test("periodKey builds a stable YYYY-MM key", () => {
  assert.equal(periodKey(d("2026-04-01")), "2026-04");
  assert.equal(periodKey(d("2025-12-01")), "2025-12");
});

test("pinning both rounds compares exactly those two", () => {
  const raw = computeRawChange(threeRounds, defMap, { from: "2025-12", to: "2026-04" });
  assert.equal(raw.previousRun, "December 2025");
  assert.equal(raw.latestRun, "April 2026");
  assert.equal(raw.lpiDelta, 200); // 3200 - 3000, ignoring July
});

test("pinning only the earlier round keeps the latest proof as the target", () => {
  const raw = computeRawChange(threeRounds, defMap, { from: "2025-12" });
  assert.equal(raw.previousRun, "December 2025");
  assert.equal(raw.latestRun, "July 2026");
  assert.equal(raw.lpiDelta, 300);
});

test("a bull missing a pinned round is not comparable", () => {
  const raw = computeRawChange(threeRounds, defMap, { from: "2024-08", to: "2026-04" });
  assert.equal(raw.found, false);
});

test("rejects a backwards selection (earlier side must precede the later one)", () => {
  const raw = computeRawChange(threeRounds, defMap, { from: "2026-07", to: "2026-04" });
  assert.equal(raw.found, false);
});

test("sdFromParam validates the sensitivity input", () => {
  assert.equal(sdFromParam("0.5"), 0.5);
  assert.equal(sdFromParam("1.5"), 1.5);
  assert.equal(sdFromParam("1"), 1);
  assert.equal(sdFromParam(undefined), 1);
  assert.equal(sdFromParam("99"), 1); // rejects anything else
});
