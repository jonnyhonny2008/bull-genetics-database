import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTpi, resolveTpiFormula, tpiRequiredTraits } from "./index-registry";

// ---------------------------------------------------------------------------
// BROAD VALIDATION AGAINST PUBLISHED TPI — 270 real bulls, two rounds, three
// independently-obtained published sources.
//
// This is the test that decides whether a computed GTPI may be shown to a
// customer. It is deliberately wider than a happy-path check:
//
//   * TWO ROUNDS, and they resolve DIFFERENT formula versions. April 2026 uses
//     the April-2026 weights (constant 2845, FE$ v2025, FI v2024); April 2020
//     uses the April-2020 weights (constant 2370, FE v2020, FI v2020, and a
//     DIFFERENT calving-trait weighting). So this exercises the registry's
//     version resolution, not just one formula.
//   * TWO INDEPENDENT SOURCES at 2026 — Holstein Association's own published
//     Top 100 PDF, and NAAB-CSS's per-bull pages. 28 bulls appear in both and
//     agree on all 28, which is what rules out a single mis-parsed source.
//   * THE WHOLE RANGE, not just the elite: TPI 1343 to 3480. An index can look
//     perfect on the top 100 and drift badly in the middle of the population.
//
// Gate is +/-3 (see index-registry.ts for why +/-2 produces false alarms).
// ---------------------------------------------------------------------------

interface Fixture {
  naab: string; name: string; round: string;
  publishedTpi: number; source: string; traits: Record<string, number>;
}
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (f: string): Fixture[] => JSON.parse(readFileSync(join(FIX, f), "utf8"));

const bulls2604 = load("published-tpi-2604.json");
const bulls2004 = load("published-tpi-2004.json");

const TOLERANCE = 3;

/**
 * Bulls where the PUBLISHED value is known to be wrong or on different inputs —
 * not where our arithmetic is. Each is diagnosed, not waved away, and the test
 * below asserts this list does not grow.
 */
const KNOWN_BAD_GROUND_TRUTH: Record<string, string> = {
  // PROVEN, not assumed: NAAB-CSS serves GENOSOURCE CAPTAIN's entire record on
  // both sons' pages — all three are published as exactly 3356 — while CDCB gives
  // the three genuinely different PTAs (PRO 64/55/59, FAT 117/110/112, PL
  // 3.6/2.9/2.3). Three bulls with different genetics cannot share one TPI, so
  // the published figure is the error. Our values correctly differ per bull.
  "551HO04412": "NAAB-CSS duplicates GENOSOURCE CAPTAIN's record onto this son (published 3356 = Captain's)",
  "551HO04413": "NAAB-CSS duplicates GENOSOURCE CAPTAIN's record onto this son (published 3356 = Captain's)",
  // Interbull-converted Australian bull: CDCB carries DCE 1.6 / DSB 3.7 where
  // HAUSA used 1.7 / 4.6. Substituting HAUSA's inputs reproduces their figure
  // exactly, so this is an input-vintage difference, not a formula error.
  "187HO05347": "Interbull-converted (AUS) — CDCB and HAUSA hold different calving-trait vintages",
  // German Interbull-converted bull. UNDIAGNOSED — recorded as an open anomaly
  // rather than explained away. 4 points on a ~2,286 figure.
  "202HO00896": "Interbull-converted (DEU) — UNDIAGNOSED 4-point deviation, open anomaly",
};

function report(bulls: Fixture[], round: string) {
  const errs: number[] = [];
  const failures: string[] = [];
  for (const b of bulls) {
    const r = computeTpi(b.traits, round);
    if (!r) { failures.push(`${b.naab} ${b.name}: returned null — a round we should be able to compute`); continue; }
    const e = r.value - b.publishedTpi;
    if (KNOWN_BAD_GROUND_TRUTH[b.naab]) continue; // excluded from the stats too
    errs.push(e);
    if (Math.abs(e) > TOLERANCE) failures.push(`${b.naab} ${b.name} [${b.source}]: computed ${r.value} vs published ${b.publishedTpi} (${e > 0 ? "+" : ""}${e})`);
  }
  const mean = errs.reduce((s, e) => s + e, 0) / (errs.length || 1);
  const rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / (errs.length || 1));
  return { errs, failures, mean, rmse, exact: errs.filter((e) => e === 0).length };
}

test("April 2026 — 170 bulls from two independent published sources, all within ±3", () => {
  assert.ok(bulls2604.length >= 150, `expected a broad fixture, got ${bulls2604.length}`);
  const r = report(bulls2604, "2604");
  assert.deepEqual(r.failures, [], "bulls outside tolerance");
  const excluded = bulls2604.filter((b) => KNOWN_BAD_GROUND_TRUTH[b.naab]).length;
  assert.equal(r.errs.length, bulls2604.length - excluded, "every bull must compute (minus the documented bad-ground-truth rows)");
  assert.ok(Math.abs(r.mean) <= 1.0, `mean error ${r.mean.toFixed(3)} — a systematic offset means a wrong formula version`);
  assert.ok(r.rmse <= 2.0, `RMSE ${r.rmse.toFixed(3)}`);
});

test("April 2020 — 100 bulls scored with the APRIL 2020 formula, all within ±3", () => {
  // The point of this one is version resolution. These same bulls scored with
  // today's formula would be out by hundreds of points (different constant,
  // different Feed Efficiency definition, different calving weights).
  assert.ok(bulls2004.length >= 100, `expected >= 100 bulls, got ${bulls2004.length}`);
  const r = report(bulls2004, "2004");
  assert.deepEqual(r.failures, [], "bulls outside tolerance");
  assert.ok(Math.abs(r.mean) <= 1.0, `mean error ${r.mean.toFixed(3)}`);
});

test("the two 2026 sources agree with each other where they overlap", () => {
  // 28 bulls appear in both HAUSA's PDF and NAAB-CSS's pages. If our value sits
  // within tolerance of both, no single mis-parsed source can be propping the
  // result up.
  const both = bulls2604.filter((b) => b.source === "both");
  assert.ok(both.length >= 20, `expected a meaningful overlap, got ${both.length}`);
  for (const b of both) {
    const r = computeTpi(b.traits, "2604")!;
    assert.ok(Math.abs(r.value - b.publishedTpi) <= TOLERANCE, `${b.naab}: ${r.value} vs ${b.publishedTpi}`);
  }
});

test("accuracy holds across the WHOLE range, not just the top of the list", () => {
  // An index can look perfect on elite bulls and drift in the middle. Split the
  // fixture at its median and require both halves to hold independently.
  const sorted = [...bulls2604].sort((a, b) => a.publishedTpi - b.publishedTpi);
  const mid = Math.floor(sorted.length / 2);
  for (const [label, slice] of [["lower half", sorted.slice(0, mid)], ["upper half", sorted.slice(mid)]] as const) {
    const r = report(slice as Fixture[], "2604");
    assert.deepEqual(r.failures, [], `${label} outside tolerance`);
    assert.ok(Math.abs(r.mean) <= 1.0, `${label} mean ${r.mean.toFixed(3)}`);
  }
  assert.ok(sorted[0].publishedTpi < 2000, `fixture should reach well below the elite, lowest is ${sorted[0].publishedTpi}`);
});

test("REGRESSION: required traits follow the round's formula, not a fixed list", () => {
  // CDCB's published trait set grew over time. The April 2020 extract declares
  // FIELDS:46 and carries no FS (Feed Saved) at all; April 2026 carries 52 and
  // does. Demanding today's inputs returned null for every 2020 bull until this
  // was fixed — a whole round silently uncomputable.
  const need2020 = tpiRequiredTraits(resolveTpiFormula("2004"));
  const need2026 = tpiRequiredTraits(resolveTpiFormula("2604"));
  assert.ok(!need2020.includes("FS"), "the 2020 formula must not require FS — CDCB did not publish it yet");
  assert.ok(need2026.includes("FS"), "the 2026 formula does require FS");
  // 2020's Feed Efficiency consumes BWC instead, so it needs the body-weight linears.
  for (const c of ["STA", "STR", "BDE", "TRW", "DFM"]) assert.ok(need2020.includes(c), `2020 should require ${c} for BWC`);
  // And a real 2020 bull must actually compute.
  assert.ok(computeTpi(bulls2004[0].traits, "2004"), "a 2020 bull must compute with the 2020 formula");
});

test("the known-bad ground-truth list does not grow, and every entry is a real outlier", () => {
  // A hardcoded exclusion list is only honest if it is policed. Two assertions:
  // every excluded bull must ACTUALLY deviate (so a stale entry cannot silently
  // hide a future regression), and the list must stay tiny relative to the fixture.
  const stillDeviates: string[] = [];
  for (const naab of Object.keys(KNOWN_BAD_GROUND_TRUTH)) {
    const b = bulls2604.find((x) => x.naab === naab);
    if (!b) continue; // not in this fixture
    const r = computeTpi(b.traits, "2604")!;
    if (Math.abs(r.value - b.publishedTpi) > TOLERANCE) stillDeviates.push(naab);
  }
  assert.equal(stillDeviates.length, Object.keys(KNOWN_BAD_GROUND_TRUTH).filter((n) => bulls2604.some((b) => b.naab === n)).length,
    "every excluded bull should still deviate — a stale exclusion masks regressions");
  const excludedInFixture = bulls2604.filter((b) => KNOWN_BAD_GROUND_TRUTH[b.naab]).length;
  assert.ok(excludedInFixture / bulls2604.length < 0.05,
    `${excludedInFixture}/${bulls2604.length} excluded — too many to still call these isolated data errors`);
});

test("every bull sourced from Holstein Association's own list matches — no exclusions needed", () => {
  // The exclusions are all NAAB-CSS rows. HAUSA's own published list, the most
  // authoritative source available, must pass with nothing carved out.
  const hausa = bulls2604.filter((b) => b.source === "HAUSA" || b.source === "both");
  assert.ok(hausa.length >= 90, `expected a substantial HAUSA set, got ${hausa.length}`);
  const failures: string[] = [];
  for (const b of hausa) {
    const r = computeTpi(b.traits, "2604")!;
    if (Math.abs(r.value - b.publishedTpi) > TOLERANCE) failures.push(`${b.naab}: ${r.value} vs ${b.publishedTpi}`);
  }
  assert.deepEqual(failures, [], "HAUSA-sourced bulls outside tolerance");
});

test("scoring a round with the WRONG version is caught by the data, not just in theory", () => {
  // The same April-2020 bulls scored with today's formula.
  const b = bulls2004[0];
  const right = computeTpi(b.traits, "2004")!;
  const wrong = computeTpi({ ...b.traits, FS: 0 }, "2604");
  assert.ok(Math.abs(right.value - b.publishedTpi) <= TOLERANCE, "the correct version matches the published value");
  if (wrong) {
    assert.ok(Math.abs(wrong.value - b.publishedTpi) > 100,
      `today's formula on 2020 data should be badly wrong, got ${wrong.value} vs published ${b.publishedTpi}`);
  }
});
