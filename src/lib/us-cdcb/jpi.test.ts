import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeJpi, resolveJpiFormula, JpiUnavailable, JPI_REQUIRED_TRAITS, JPI_REGISTRY } from "./jpi";

// Fixture: AJCA's OWN published Green Book JPI values for the April 2026 round,
// joined to the raw CDCB Jersey PTAs for the same animals. Nothing is fitted —
// the divisors are AJCA's published constants, so every record is effectively a
// holdout.

interface Fixture { naab: string; id17: string; name: string; publishedJpi: number; traits: Record<string, number> }
const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const jerseys: Fixture[] = JSON.parse(readFileSync(join(FIX, "ajca-jpi-2604.json"), "utf8"));

test("reproduces AJCA's published April-2026 JPI exactly", () => {
  const errors: number[] = [];
  const failures: string[] = [];
  for (const j of jerseys) {
    const r = computeJpi(j.traits, "2604");
    assert.ok(r, `${j.naab} ${j.name}: all ten inputs are published, so this must compute`);
    const err = r.value - j.publishedJpi;
    errors.push(err);
    if (Math.abs(err) > 1) failures.push(`${j.naab} ${j.name}: computed ${r.value} vs published ${j.publishedJpi}`);
  }
  assert.deepEqual(failures, [], "animals off by more than 1 JPI point");

  const exact = errors.filter((e) => e === 0).length;
  assert.ok(exact / errors.length >= 0.99, `only ${exact}/${errors.length} exact — expected >= 99%`);
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  assert.ok(Math.abs(mean) < 0.05, `mean error ${mean.toFixed(4)} should be ~0 — a systematic offset means a wrong constant`);
});

test("rank order matches AJCA's published list", () => {
  const computed = jerseys.map((j) => ({ naab: j.naab, jpi: computeJpi(j.traits, "2604")!.value })).sort((a, b) => b.jpi - a.jpi);
  const published = [...jerseys].sort((a, b) => b.publishedJpi - a.publishedJpi);
  const cTop = computed.slice(0, 10).map((x) => x.naab).sort();
  const pTop = published.slice(0, 10).map((x) => x.naab).sort();
  assert.deepEqual(cTop, pTop, "top-10 set must match exactly");
});

test("the three non-linear traits are scored correctly", () => {
  const base = jerseys[0].traits;
  const v = resolveJpiFormula("2604");

  // Udder depth is TWO-WAY: credit falls off on both sides of the optimum, so a
  // bull above the optimum scores the same as one equally far below it.
  const above = computeJpi({ ...base, UDP: v.udOptimum + 1 }, "2604")!;
  const below = computeJpi({ ...base, UDP: v.udOptimum - 1 }, "2604")!;
  const atOpt = computeJpi({ ...base, UDP: v.udOptimum }, "2604")!;
  assert.equal(above.value, below.value, "equal distance either side of the optimum must score the same");
  assert.ok(atOpt.raw > above.raw, "the optimum must beat either side");

  // Fore udder and rear udder height are CAPPED — more stops helping.
  const atCap = computeJpi({ ...base, FUA: v.fuCap }, "2604")!;
  const overCap = computeJpi({ ...base, FUA: v.fuCap + 5 }, "2604")!;
  assert.equal(atCap.value, overCap.value, "FUA above the cap must not add credit");
  const ruhAt = computeJpi({ ...base, RUH: v.ruhCap }, "2604")!;
  const ruhOver = computeJpi({ ...base, RUH: v.ruhCap + 5 }, "2604")!;
  assert.equal(ruhAt.value, ruhOver.value, "RUH above the cap must not add credit");

  // SCS is inverted and centred on 3.0 — LOWER is better.
  const lowScs = computeJpi({ ...base, SCS: 2.8 }, "2604")!;
  const highScs = computeJpi({ ...base, SCS: 3.2 }, "2604")!;
  assert.ok(lowScs.raw > highScs.raw, "a lower somatic cell score must score higher");
});

test("each round resolves the version in force for that round", () => {
  assert.equal(resolveJpiFormula("2604").label, "JPI2025");
  assert.equal(resolveJpiFormula("2504").label, "JPI2025");
  assert.equal(resolveJpiFormula("2412").label, "JPI2023");
  assert.equal(resolveJpiFormula("2312").label, "JPI2023");
});

test("JPI2023 and JPI2025 genuinely differ — same weights, different constants", () => {
  const a = JPI_REGISTRY.find((v) => v.label === "JPI2023")!;
  const b = JPI_REGISTRY.find((v) => v.label === "JPI2025")!;
  assert.equal(a.constant, 0, "JPI2023 is 'SUM of above values' — no constant");
  assert.equal(b.constant, 48);
  assert.notEqual(a.udOptimum, b.udOptimum, "the udder-depth optimum moved with the April 2025 base change");
  assert.notEqual(a.sd.PRO, b.sd.PRO);
  // Using the wrong version is a real error, not a rounding nuisance.
  const t = jerseys[0].traits;
  assert.notEqual(computeJpi(t, "2604")!.value, computeJpi(t, "2412")!.value);
});

test("pre-2023 rounds are refused with an honest reason, never approximated", () => {
  // AJCA printed "/ SD" as a symbol for JPI2015/2017/2020. That is a permanent
  // gap in the public record, not a to-do.
  let caught: JpiUnavailable | null = null;
  try { resolveJpiFormula("2004"); } catch (e) { caught = e as JpiUnavailable; }
  assert.ok(caught instanceof JpiUnavailable);
  assert.equal(caught!.reason, "no_formula_published");
  assert.match(caught!.message, /SD/);
});

test("a missing trait yields null", () => {
  const t = { ...jerseys[0].traits };
  delete (t as Record<string, number>).MAS;
  assert.equal(computeJpi(t, "2604"), null);
});

test("weights sum to 100 in absolute terms", () => {
  const r = computeJpi(jerseys[0].traits, "2604")!;
  const sum = r.terms.reduce((s, x) => s + Math.abs(x.weight), 0);
  assert.equal(sum, 100);
  assert.equal(r.terms.length, JPI_REQUIRED_TRAITS.length);
});
