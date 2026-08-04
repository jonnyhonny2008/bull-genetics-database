// Unit tests for the Mating Program ranking maths. Pure — no DB/network.
//   npx tsx --test src/lib/mating-score.test.ts
//
// The first test is the reason this module exists: on a pool of real Holstein
// magnitudes, adding LPI to Conformation produces a DIFFERENT and worse ranking
// than standardising first. If that test ever passes trivially, the feature has
// stopped doing the one thing it was built to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MATCH_SCORE_DIGITS,
  MAX_SELECTED_TRAITS,
  MAX_WEIGHT,
  MIN_WEIGHT,
  SCORE_BASE,
  SCORE_SD_POINTS,
  WEIGHT_STEP,
  blendLabel,
  compareByScore,
  compositeScore,
  describeSelection,
  matchScoreOf,
  parentAverage,
  parseTraitSelection,
  poolTraitStats,
  rankIsComposite,
  type SelectedTrait,
} from "./mating-score";
import { fmtNum } from "./format";

// --- fixtures ---------------------------------------------------------------

/** A candidate pool in the shape the orchestrator hands over. */
const pool = (rows: Record<string, number | null>[]) =>
  rows.map((r) => ({ cols: new Map<string, number | null>(Object.entries(r)) }));

const bull = (o: Record<string, number | null>) => new Map<string, number | null>(Object.entries(o));

/** Parse a selection spec ("LPI,CONF:2") straight into SelectedTrait[]. */
const sel = (spec: string): SelectedTrait[] => parseTraitSelection([spec]).selected;

/** Score one bull against a pool, in one line. */
function scoreIn(
  poolRows: Record<string, number | null>[],
  spec: string,
  target: Record<string, number | null>,
) {
  const selected = sel(spec);
  const stats = poolTraitStats(selected, pool(poolRows));
  return compositeScore(bull(target), selected, stats);
}

const close = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `expected ${a} to be within ${tol} of ${b}`);

// --- the whole point: a raw sum is not a blend -------------------------------

test("standardising changes the ranking a raw sum would produce", () => {
  // Real magnitudes: LPI in the thousands, Conformation in single digits.
  // Pool LPI: mean 3000, sd 100. Pool CONF: mean 10, sd 5.
  const rows = [
    { LPI: 2900, CONF: 5 },
    { LPI: 3000, CONF: 10 },
    { LPI: 3100, CONF: 15 },
  ];
  const stats = poolTraitStats(sel("LPI,CONF"), pool(rows));
  close(stats.get("LPI")!.mean, 3000);
  close(stats.get("LPI")!.sd, Math.sqrt(20000 / 3));
  close(stats.get("CONF")!.mean, 10);

  // Two candidates the breeder is choosing between:
  //   RAW SUM  A = 3200 + 6 = 3206   B = 3060 + 18 = 3078   -> A wins by 128,
  //            and Conformation contributed 12 points of a 3206-point score:
  //            the "blend" is an LPI ranking with a rounding error attached.
  const A = { LPI: 3200, CONF: 6 };
  const B = { LPI: 3060, CONF: 18 };
  const rawSum = (b: Record<string, number>) => b.LPI + b.CONF;
  assert.ok(rawSum(A) > rawSum(B), "the raw sum ranks A first");

  // STANDARDISED: A is +2.45 sd on LPI but -0.98 sd on Conformation; B is
  // +0.73 sd on LPI and +1.96 sd on Conformation. B is the better blend, and
  // an equal-weight blend that is genuinely equal must say so.
  const selected = sel("LPI,CONF");
  const sa = compositeScore(bull(A), selected, stats);
  const sb = compositeScore(bull(B), selected, stats);
  assert.ok(sb.composite! > sa.composite!, "standardised, B ranks ahead of A");
  assert.ok(compareByScore(sa.composite, sb.composite) > 0, "and the comparator agrees");

  // The scale is this app's own: 100 at the pool average, 5 points per sd.
  close(sa.matchScore!, Math.round((SCORE_BASE + SCORE_SD_POINTS * sa.composite!) * 10) / 10);
  const average = compositeScore(bull({ LPI: 3000, CONF: 10 }), selected, stats);
  close(average.composite!, 0);
  assert.equal(average.matchScore, SCORE_BASE);
});

test("weights actually move the order", () => {
  const rows = [
    { LPI: 2900, CONF: 5 },
    { LPI: 3000, CONF: 10 },
    { LPI: 3100, CONF: 15 },
  ];
  const A = { LPI: 3200, CONF: 6 }; // strong LPI, weak type
  const B = { LPI: 3060, CONF: 18 }; // modest LPI, strong type

  const top = (spec: string) => {
    const selected = sel(spec);
    const stats = poolTraitStats(selected, pool(rows));
    const sa = compositeScore(bull(A), selected, stats);
    const sb = compositeScore(bull(B), selected, stats);
    return compareByScore(sa.composite, sb.composite) <= 0 ? "A" : "B";
  };

  assert.equal(top("LPI,CONF"), "B", "equal weights: the type bull wins");
  assert.equal(top("LPI:4,CONF:1"), "A", "leaning hard on LPI flips it back");
  // ...and the weights are not merely cosmetic on the score itself.
  const equal = scoreIn(rows, "LPI,CONF", A).composite!;
  const heavy = scoreIn(rows, "LPI:4,CONF:1", A).composite!;
  assert.ok(heavy > equal, "weighting A's strong trait raises A's composite");
});

// --- direction --------------------------------------------------------------

test("SCS is negated: the LOW-cell bull scores higher", () => {
  const rows = [{ SCS: 2.8 }, { SCS: 3.0 }, { SCS: 3.2 }];
  const low = scoreIn(rows, "SCS", { SCS: 2.8 });
  const high = scoreIn(rows, "SCS", { SCS: 3.2 });
  assert.ok(low.composite! > 0, "below the pool mean on SCS is a POSITIVE composite");
  assert.ok(high.composite! < 0);
  assert.ok(low.matchScore! > SCORE_BASE && high.matchScore! < SCORE_BASE);
  assert.equal(compareByScore(low.composite, high.composite) < 0, true, "and he sorts first");

  // Inside a blend, SCS still pulls the right way: two bulls identical on LPI,
  // the one with the lower cell count comes out ahead.
  const blendRows = [
    { LPI: 2900, SCS: 3.2 },
    { LPI: 3000, SCS: 3.0 },
    { LPI: 3100, SCS: 2.8 },
  ];
  const a = scoreIn(blendRows, "LPI,SCS", { LPI: 3000, SCS: 2.8 });
  const b = scoreIn(blendRows, "LPI,SCS", { LPI: 3000, SCS: 3.2 });
  assert.ok(a.composite! > b.composite!);
});

// --- guard rails ------------------------------------------------------------

test("a trait the pool cannot separate on contributes nothing, and says so", () => {
  // Every bull has FAT 50: sd is 0, and dividing by it would be a crash or a
  // fabricated infinity. The composite must fall back to LPI alone.
  const rows = [
    { LPI: 2900, FAT: 50 },
    { LPI: 3000, FAT: 50 },
    { LPI: 3100, FAT: 50 },
  ];
  const selected = sel("LPI,FAT");
  const stats = poolTraitStats(selected, pool(rows));
  assert.equal(stats.get("FAT")!.usable, false);
  assert.equal(stats.get("FAT")!.sd, 0);
  assert.equal(stats.get("LPI")!.usable, true);

  const blended = compositeScore(bull({ LPI: 3100, FAT: 50 }), selected, stats);
  const lpiOnly = scoreIn(rows, "LPI", { LPI: 3100 });
  assert.ok(Number.isFinite(blended.composite!), "never NaN or Infinity");
  close(blended.composite!, lpiOnly.composite!);

  const said = describeSelection(selected, stats, rows.length);
  assert.ok(
    said.some((w) => /Fat/.test(w) && /NOTHING/.test(w)),
    `a warning must name Fat and say it counts for nothing; got: ${said.join(" | ")}`,
  );

  // A single bull with a value has no spread either — same treatment, no divide.
  const thin = poolTraitStats(sel("LPI"), pool([{ LPI: 3000 }]));
  assert.equal(thin.get("LPI")!.usable, false);
  assert.equal(compositeScore(bull({ LPI: 3000 }), sel("LPI"), thin).composite, null);
});

test("no selected trait usable = no score, never a divide by zero", () => {
  const rows = [{ LPI: 3000, FAT: 50 }, { LPI: 3000, FAT: 50 }];
  const selected = sel("LPI,FAT");
  const stats = poolTraitStats(selected, pool(rows));
  const s = compositeScore(bull({ LPI: 3000, FAT: 50 }), selected, stats);
  assert.equal(s.composite, null);
  assert.equal(s.matchScore, null);
  assert.ok(describeSelection(selected, stats, rows.length).some((w) => /None of the selected traits varies/.test(w)));
});

test("a bull missing any selected trait scores null and sorts LAST", () => {
  const rows = [
    { LPI: 2900, CONF: 5 },
    { LPI: 3000, CONF: 10 },
    { LPI: 3100, CONF: 15 },
  ];
  const selected = sel("LPI,CONF");
  const stats = poolTraitStats(selected, pool(rows));

  // A bull with a huge LPI and NO Conformation. Re-normalising over the trait
  // he happens to carry would put him top — precisely by virtue of the missing
  // number. He gets nothing instead.
  const gap = compositeScore(bull({ LPI: 4000, CONF: null }), selected, stats);
  assert.equal(gap.composite, null);
  assert.equal(gap.matchScore, null);
  assert.deepEqual(gap.missing, ["CONF"]);

  const weakest = compositeScore(bull({ LPI: 2900, CONF: 5 }), selected, stats);
  assert.ok(weakest.composite! < 0);
  assert.equal(compareByScore(gap.composite, weakest.composite), 1, "the unscored bull sorts after the worst scored one");

  const order = [gap.composite, weakest.composite, 2].sort(compareByScore);
  assert.deepEqual(order, [2, weakest.composite, null]);
});

// --- single trait: unchanged behaviour --------------------------------------

test("one trait is the raw parent average, not a z-score", () => {
  const selected = sel("LPI");
  assert.equal(rankIsComposite(selected), false);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].code, "LPI");
  assert.equal(selected[0].weight, 1);
  assert.equal(blendLabel(selected), "LPI");

  // The displayed and sorted number is the plain mean of the two parents.
  assert.equal(parentAverage(3100, 2900), 3000);
  // ...and the bull's own value when the dam has none — never invented.
  assert.equal(parentAverage(3100, null), 3100);
  assert.equal(parentAverage(null, 2900), null);
  assert.equal(parentAverage(null, null), null);

  // Ranking on that raw value gives the same order as the raw values themselves.
  const dam = 2800;
  const bulls = [3100, 2900, 3300];
  const pre = bulls.map((b) => parentAverage(b, dam)!);
  assert.deepEqual(pre, [2950, 2850, 3050]);
  assert.deepEqual([...pre].sort((a, b) => b - a), [3050, 2950, 2850]);
});

// --- parsing ----------------------------------------------------------------

test("parses a bare code as a single-trait run", () => {
  const { selected, warnings } = parseTraitSelection(["LPI"]);
  assert.equal(selected.length, 1);
  assert.equal(rankIsComposite(selected), false);
  assert.deepEqual(warnings, []);
});

test("parses codes and weights, and labels the blend", () => {
  const { selected, warnings } = parseTraitSelection(["LPI:2,CONF"]);
  assert.deepEqual(selected.map((s) => [s.code, s.weight]), [["LPI", 2], ["CONF", 1]]);
  assert.equal(rankIsComposite(selected), true);
  assert.equal(blendLabel(selected), "LPI ×2 + Conformation");
  assert.deepEqual(warnings, []);
  // Slot form: one entry per field, exactly as the GET form submits it.
  assert.deepEqual(parseTraitSelection(["LPI:2", "CONF:1"]).selected.map((s) => s.code), ["LPI", "CONF"]);
  // Case and stray spaces are the user's, not an error.
  assert.deepEqual(parseTraitSelection([" lpi , conf "]).selected.map((s) => s.code), ["LPI", "CONF"]);
});

test("an unknown code is reported, never silently substituted", () => {
  const { selected, warnings } = parseTraitSelection(["LPI,PI"]);
  assert.deepEqual(selected.map((s) => s.code), ["LPI"]);
  assert.ok(warnings.some((w) => w.includes('"PI"')));

  const none = parseTraitSelection(["NOPE"]);
  assert.deepEqual(none.selected.map((s) => s.code), ["LPI"], "falls back to the default");
  assert.ok(none.warnings.some((w) => /ranked on LPI instead/.test(w)));
});

test("weights are clamped, duplicates dropped and the trait count capped", () => {
  const hot = parseTraitSelection(["LPI:900"]);
  assert.equal(hot.selected[0].weight, MAX_WEIGHT);
  assert.ok(hot.warnings.some((w) => /held at/.test(w)));

  const cold = parseTraitSelection(["LPI:0"]);
  assert.equal(cold.selected[0].weight, MIN_WEIGHT);

  const junk = parseTraitSelection(["LPI:heavy"]);
  assert.equal(junk.selected[0].weight, 1);
  assert.ok(junk.warnings.some((w) => /not a usable weight/.test(w)));

  const dupe = parseTraitSelection(["LPI:2,LPI:3"]);
  assert.equal(dupe.selected.length, 1);
  assert.equal(dupe.selected[0].weight, 2, "the first wins; weights are not summed");
  assert.ok(dupe.warnings.some((w) => /selected twice/.test(w)));

  const many = parseTraitSelection(["LPI,PRO$,CONF,MAMM,MILK,FAT"]);
  assert.equal(many.selected.length, MAX_SELECTED_TRAITS);
  assert.ok(many.warnings.some((w) => w.includes(`Only ${MAX_SELECTED_TRAITS} traits`)));
});

// --- regressions ------------------------------------------------------------
//
// Both of these were shipped once. They are not maths bugs — they are the two
// ways a correct composite still reaches the breeder as a wrong report: a score
// rounded until the ranking looks arbitrary, and a form that will not submit.

/** Read a source file of the app, so a regression at the real render site fails here. */
const source = (...parts: string[]) => readFileSync(join(__dirname, "..", ...parts), "utf8");

test("the Match score is shown to one decimal, on screen and in the workbook", () => {
  // The ranking sorts on the UNROUNDED composite while the score is rounded for
  // display. At whole numbers a fifth of a standard deviation disappears, and a
  // numbered list shows three consecutive bulls carrying the same figure with
  // nothing on the page to justify the order they are in.
  assert.equal(MATCH_SCORE_DIGITS, 1);

  const higher = matchScoreOf(2.44); // 100 + 5 × 2.44
  const lower = matchScoreOf(2.36);
  assert.equal(higher, 112.2);
  assert.equal(lower, 111.8);
  assert.ok(higher > lower, "these two bulls are strictly ordered");

  assert.equal(fmtNum(higher, 0), fmtNum(lower, 0), "0 decimals collapses them — the defect");
  assert.notEqual(
    fmtNum(higher, MATCH_SCORE_DIGITS),
    fmtNum(lower, MATCH_SCORE_DIGITS),
    "at the shipped precision the order the breeder sees is the order that was computed",
  );

  // A run of near-neighbours, as the top of a real leaderboard looks: every
  // distinct score must still print as a distinct string.
  const scores = [2.44, 2.4, 2.36, 2.3].map(matchScoreOf);
  const shown = scores.map((s) => fmtNum(s, MATCH_SCORE_DIGITS));
  assert.equal(new Set(shown).size, scores.length, `collapsed: ${shown.join(", ")}`);

  // The Excel export writes m.matchScore raw — already 1 dp from matchScoreOf —
  // so the screen must not round harder than the workbook it is exported to.
  assert.equal(matchScoreOf(2.44), Number(fmtNum(higher, MATCH_SCORE_DIGITS)));

  // And no render site may fall back to fmtNum's 0-decimal default.
  const results = source("components", "MatingProgramResults.tsx");
  assert.equal(
    /fmtNum\(\s*(?:m|top|f\.matches\[0\])?\.?matchScore/.test(results),
    false,
    "matchScore must be rendered through fmtScore, not bare fmtNum",
  );
  assert.ok(results.includes("MATCH_SCORE_DIGITS"), "the precision is the shared constant, not a literal");
  assert.ok(results.includes("fmtScore(m.matchScore)"), "the recommendations row uses it");
  assert.ok(results.includes("fmtScore(best)"), "so does the per-female headline");
});

/**
 * HTML constraint validation, as browsers implement it: a numeric `step` is
 * counted from `min`, and a value off the grid blocks form submission entirely.
 */
function stepMismatch(value: number, min: number, step: number | "any"): boolean {
  if (step === "any") return false;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) > 1e-9;
}

test("every weight the server accepts can actually be typed into the form", () => {
  // The defect: step 0.5 counted from min 0.1 admits 0.1, 0.6, 1.1 … so the
  // form's OWN default of 1 was invalid, the browser refused to submit, and the
  // report could not be run at all — including the single-trait run.
  assert.equal(stepMismatch(1, MIN_WEIGHT, 0.5), true, "this is what was shipped");
  assert.equal(stepMismatch(2, MIN_WEIGHT, 0.5), true, "even a plain weight of 2 was rejected");

  assert.equal(WEIGHT_STEP, "any");
  for (const w of [MIN_WEIGHT, 0.5, 1, 1.5, 2, 2.5, 3, MAX_WEIGHT]) {
    assert.equal(stepMismatch(w, MIN_WEIGHT, WEIGHT_STEP), false, `weight ${w} must be enterable`);
    // ...and what the form accepts is what the server keeps, unclamped.
    assert.equal(parseTraitSelection([`LPI:${w}`]).selected[0].weight, w);
  }

  // The form must take the step from the shared constant. A hard-coded numeric
  // step is the whole bug, whatever its value.
  const page = source("app", "(app)", "reports", "mating-program", "page.tsx");
  assert.ok(page.includes("step={WEIGHT_STEP}"), "the weight input uses the shared step");
  assert.equal(/step=\{\s*[\d.]/.test(page), false, "no hard-coded numeric step on this form");
});

test("the blend is explained in words a breeder can act on", () => {
  const rows = [
    { LPI: 2900, CONF: 5 },
    { LPI: 3000, CONF: 10 },
    { LPI: 3100, CONF: 15 },
  ];
  const selected = sel("LPI:2,CONF");
  const said = describeSelection(selected, poolTraitStats(selected, pool(rows)), rows.length);
  assert.ok(said.length >= 1);
  assert.ok(said[0].includes("LPI (weight 2)") && said[0].includes("Conformation (weight 1)"));
  assert.ok(said[0].includes(`${SCORE_BASE}`) && said[0].includes(`${SCORE_SD_POINTS} points`));

  // SCS in a blend gets its own sentence — a breeder must not have to infer it.
  const withScs = sel("LPI,SCS");
  const scsRows = [{ LPI: 2900, SCS: 3.2 }, { LPI: 3100, SCS: 2.8 }];
  const scsSaid = describeSelection(withScs, poolTraitStats(withScs, pool(scsRows)), scsRows.length);
  assert.ok(scsSaid.some((w) => /SCS/.test(w) && /LOWER/.test(w)));

  // A single-trait run standardises nothing, so it explains nothing.
  assert.deepEqual(describeSelection(sel("LPI"), new Map(), 3), []);
});
