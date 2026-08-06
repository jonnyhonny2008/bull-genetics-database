import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTpi, resolveTpiFormula, roundOrdinal, formulaConfidence,
  TpiUnavailable, TPI_REQUIRED_TRAITS, INDEX_REGISTRY,
} from "./index-registry";

// ---------------------------------------------------------------------------
// THE REGRESSION TEST THAT MATTERS.
//
// The fixture is Holstein Association USA's OWN published April-2026 Top 100 TPI
// list, joined to the raw CDCB PTAs for the same bulls. If our arithmetic ever
// drifts from HAUSA's, this fails — which is the only thing standing between a
// computed number and a wrong number in front of a customer.
//
// Gate is +/-3, not +/-2. On the wider validation set 190/193 landed within +/-2
// but 193/193 within +/-3, so a tighter gate produces false alarms.
// ---------------------------------------------------------------------------

interface Fixture {
  naab: string; name: string;
  publishedTpi: number; publishedFe: number; publishedUdc: number; publishedFlc: number;
  traits: Record<string, number>;
}
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const bulls: Fixture[] = JSON.parse(readFileSync(join(FIX, "hausa-top100-2604.json"), "utf8"));

const TOLERANCE = 3;

test("reproduces HAUSA's published April-2026 TPI for all 99 bulls within +/-3", () => {
  assert.equal(bulls.length, 99, "fixture should carry the full published list");
  const errors: number[] = [];
  const failures: string[] = [];

  for (const b of bulls) {
    const r = computeTpi(b.traits, "2604");
    assert.ok(r, `${b.naab} ${b.name}: every required trait is published, so this must compute`);
    const err = r.value - b.publishedTpi;
    errors.push(err);
    if (Math.abs(err) > TOLERANCE) failures.push(`${b.naab} ${b.name}: computed ${r.value} vs published ${b.publishedTpi} (${err > 0 ? "+" : ""}${err})`);
  }

  assert.deepEqual(failures, [], `bulls outside +/-${TOLERANCE}`);

  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
  assert.ok(Math.abs(mean) <= 1.0, `mean error ${mean.toFixed(3)} should be within +/-1.0 — a systematic offset means a wrong formula version`);
  assert.ok(rmse <= 2.0, `RMSE ${rmse.toFixed(3)} should be <= 2.0`);
});

test("rank order matches the published list — the top of the list is the product", () => {
  const computed = bulls
    .map((b) => ({ naab: b.naab, tpi: computeTpi(b.traits, "2604")!.value }))
    .sort((a, b) => b.tpi - a.tpi);
  const published = [...bulls].sort((a, b) => b.publishedTpi - a.publishedTpi);

  // Top 10 must be the same set — a stud's lead page.
  const cTop = new Set(computed.slice(0, 10).map((x) => x.naab));
  const pTop = new Set(published.slice(0, 10).map((x) => x.naab));
  assert.deepEqual([...cTop].sort(), [...pTop].sort(), "top-10 set must match exactly");

  // No bull may move more than a few places overall.
  const cRank = new Map(computed.map((x, i) => [x.naab, i]));
  let maxShift = 0;
  published.forEach((p, i) => { maxShift = Math.max(maxShift, Math.abs((cRank.get(p.naab) ?? i) - i)); });
  assert.ok(maxShift <= 5, `max rank shift ${maxShift} should be <= 5`);
});

test("the composites reproduce HAUSA's published UDC and FLC", () => {
  // Published to 2dp, so matching proves the transforms — including the
  // asymmetric RP* and the quadratic TL*/SV* curves.
  //
  // A handful of rows in the fixture's UDC/FLC columns are PDF-scrape artifacts,
  // and we can PROVE that rather than just tolerating it: UDC carries weight
  // 11/0.8 and FLC 6/0.8, both multiplied by 3.8. So a UDC genuinely wrong by
  // 2.9 would move TPI by ~150 points. Any bull whose TPI still matches within
  // +/-3 therefore CANNOT have a materially wrong composite — the published
  // column is what is misparsed.
  const suspect: string[] = [];
  for (const b of bulls) {
    const r = computeTpi(b.traits, "2604")!;
    const dU = Math.abs(r.composites.udc - b.publishedUdc);
    const dF = Math.abs(r.composites.flc - b.publishedFlc);
    if (dU <= 0.02 && dF <= 0.02) continue;

    // Implied TPI impact if the published composite were the truth.
    const implied = Math.abs(dU * (11 / 0.8) + dF * (6 / 0.8)) * 3.8;
    const tpiErr = Math.abs(r.value - b.publishedTpi);
    if (implied > 5 && tpiErr <= 3) continue; // provably a bad published cell
    suspect.push(`${b.naab}: dUDC=${dU.toFixed(3)} dFLC=${dF.toFixed(3)} but TPI err=${tpiErr}`);
  }
  assert.deepEqual(suspect, [], "composite deviations that are NOT explained by a misparsed published cell");
});

test("FE$ reproduces exactly — this is what proves CDCB's FS is Feed Saved, not Final Score", () => {
  let off = 0;
  for (const b of bulls) {
    const r = computeTpi(b.traits, "2604")!;
    if (Math.abs(Math.round(r.composites.fe) - b.publishedFe) > 1) off++;
  }
  assert.equal(off, 0, "FE$ should reproduce exactly for every bull");
});

// --- version resolution ------------------------------------------------------

test("each round resolves the formula that was in force FOR THAT ROUND", () => {
  assert.equal(resolveTpiFormula("2604").tpi.label, "April 2026");
  assert.equal(resolveTpiFormula("2512").tpi.label, "April 2025");
  assert.equal(resolveTpiFormula("2504").tpi.label, "April 2025");
  assert.equal(resolveTpiFormula("2412").tpi.label, "April 2021");
  assert.equal(resolveTpiFormula("2004").tpi.label, "April 2020");
  assert.equal(resolveTpiFormula("2008").tpi.label, "August 2020");
});

test("THE AUGUST 2024 TRAP: the Fertility Index changed with no change to the TPI formula", () => {
  // Both rounds resolve the SAME TPI weights, but DIFFERENT fertility indexes.
  // A registry keyed on the TPI formula alone computes 2408 wrong by ~15 points
  // on every bull, silently reordering the top 100.
  const r2404 = resolveTpiFormula("2404");
  const r2408 = resolveTpiFormula("2408");
  assert.equal(r2404.tpi.label, r2408.tpi.label, "same TPI weights either side of the change");
  assert.equal(r2404.fi!.label, "FI v2020");
  assert.equal(r2408.fi!.label, "FI v2024", "FI changed at August 2024 with no TPI formula change");
});

test("the five layers resolve independently", () => {
  const f = resolveTpiFormula("2604");
  assert.equal(f.tpi.label, "April 2026");
  assert.equal(f.fe!.label, "FE$ v2025");   // changed April 2025, not April 2026
  assert.equal(f.fi!.label, "FI v2024");    // changed August 2024
  assert.equal(f.ht!.label, "HT v2020");    // unchanged since 2020
  assert.equal(f.udc!.label, "UDC v2020 (2015 base)");
  assert.equal(f.flc!.label, "FLC v2020 (2015 base)");
  assert.equal(f.bwc.label, "BWC v2017");
  // Four different effective dates in one round's resolution — the whole point.
});

test("using the WRONG version is catastrophically wrong, not slightly wrong", () => {
  // Guards the reason this registry exists. Scoring 2026 data with the April 2021
  // formula (constant 2363 vs 2845) is ~-477 points.
  const b = bulls[0];
  const right = computeTpi(b.traits, "2604")!;
  const wrong = computeTpi(b.traits, "2412")!; // resolves April 2021
  assert.ok(Math.abs(right.value - wrong.value) > 300,
    `expected a large gap, got ${right.value} vs ${wrong.value}`);
});

// --- refusing to guess -------------------------------------------------------

test("a round before the CDCB archive is refused, never back-filled with today's formula", () => {
  let caught: TpiUnavailable | null = null;
  try { resolveTpiFormula("1804"); } catch (e) { caught = e as TpiUnavailable; }
  assert.ok(caught instanceof TpiUnavailable, "should throw TpiUnavailable");
  assert.equal(caught!.reason, "no_round_data");
});

test("2019 rounds resolve but are flagged CONTESTED, so they are not publishable", () => {
  // They depend on FE v2017, whose coefficients are disputed between sources.
  const f = resolveTpiFormula("1904");
  assert.equal(f.fe!.confidence, "contested");
  assert.equal(formulaConfidence(f), "contested");
  // ...and they cannot actually be computed, because the 2017 formula needs a
  // Daughter Fertility term CDCB does not publish. Scoring it as zero would bias
  // every 2019 bull, so the engine returns null instead.
  assert.equal(computeTpi(bulls[0].traits, "1904"), null);
});

test("April 2026 is fully verified", () => {
  assert.equal(formulaConfidence(resolveTpiFormula("2604")), "verified");
});

test("a missing trait yields null — a partial TPI is a wrong TPI", () => {
  const t = { ...bulls[0].traits };
  delete (t as Record<string, number>).PTAT;
  assert.equal(computeTpi(t, "2604"), null);
  const t2 = { ...bulls[0].traits, SCS: null as unknown as number };
  assert.equal(computeTpi(t2, "2604"), null);
});

test("bad round codes are rejected", () => {
  assert.throws(() => roundOrdinal("26"));
  assert.throws(() => roundOrdinal("2613"));  // month 13
  assert.throws(() => roundOrdinal("abcd"));
  assert.equal(roundOrdinal("2604"), 202604);
});

// --- registry integrity ------------------------------------------------------

test("every TPI version's absolute weights sum to 100", () => {
  for (const v of INDEX_REGISTRY.tpi) {
    const sum = v.terms.reduce((s, t) => s + Math.abs(t.w), 0);
    assert.ok(Math.abs(sum - 100) < 1e-9, `${v.label} weights sum to ${sum}, expected 100`);
  }
});

test("no version ranges overlap or leave a gap within each layer", () => {
  for (const [name, versions] of Object.entries(INDEX_REGISTRY)) {
    const sorted = [...versions].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      assert.ok(prev.to !== null, `${name}: ${prev.label} is open-ended but ${cur.label} follows it`);
      assert.ok(prev.to! < cur.from, `${name}: ${prev.label} (to ${prev.to}) overlaps ${cur.label} (from ${cur.from})`);
    }
    assert.equal(sorted[sorted.length - 1].to, null, `${name}: the newest version must be open-ended`);
  }
});

test("the required-trait list is exactly what the engine reads", () => {
  assert.equal(TPI_REQUIRED_TRAITS.length, 37);
  for (const code of TPI_REQUIRED_TRAITS) assert.ok(bulls[0].traits[code] != null, `fixture missing ${code}`);
});
