// Unit tests for "Sires that move like him". Pure — no DB, no network.
//   npx tsx --test src/lib/proof-similarity.test.ts
//
// The tests that matter here are the ones that would catch the feature being
// quietly worthless:
//
//   • RESIDUALISATION. If the cohort term were not removed, two bulls who merely
//     lived through the same April rollback would look alike for a reason that
//     has nothing to do with either animal. The April test asserts the raw
//     changes really are common AND that the pair is still not reported.
//   • COMMENSURABILITY. LPI residuals run in the hundreds and Conformation
//     residuals in single digits. The multi-trait test is built so that a naive
//     raw concatenation gives a wildly asymmetric answer, and asserts BOTH that
//     the shipped code is symmetric and that the naive version is not — so the
//     test cannot start passing trivially.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_INFORMATIVE,
  MIN_OVERLAP,
  THIN_OVERLAP,
  buildResidualIndex,
  compareBulls,
  curveOf,
  evidenceScore,
  findSimilar,
  median,
  sdOf,
  shapeCorrelation,
  similarityOf,
  zNormalise,
  type ResidualIndex,
  type SimilarityMode,
} from "./proof-similarity";
import type { AnalogueBull } from "./proof-analogue";

// --- fixtures ---------------------------------------------------------------

/** Monthly round times, oldest first. Calendar only matters for grouping. */
const times = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => Date.UTC(2020, i, 1));

/**
 * A bull built from CHANGES rather than levels: `changes[j]` is his move into
 * round j+1. Every bull in one fixture shares the same round dates, which is
 * what makes the per-round cohort term measurable.
 */
function bullFrom(id: string, start: Record<string, number>, changes: Record<string, number[]>): AnalogueBull {
  const codes = Object.keys(changes);
  const n = changes[codes[0]].length;
  const ts = times(n + 1);
  const level: Record<string, number> = { ...start };
  const rounds = ts.map((time, i) => {
    if (i > 0) for (const c of codes) level[c] += changes[c][i - 1];
    return {
      time,
      kind: "interim" as const,
      rel: 0.9,
      daughters: 100,
      sireType: "proven" as string | null,
      traits: new Map<string, number>(codes.map((c) => [c, level[c]])),
    };
  });
  return { id, birthTime: Date.UTC(2015, 0, 1), rounds };
}

/** `n` bulls that never move on their own — the cohort background. */
function fillers(n: number, codes: string[], steps: number, extra: number[] = []): AnalogueBull[] {
  return Array.from({ length: n }, (_, i) =>
    bullFrom(
      `filler${i}`,
      Object.fromEntries(codes.map((c) => [c, 1000])),
      Object.fromEntries(codes.map((c) => [c, Array.from({ length: steps }, (_, j) => extra[j] ?? 0)])),
    ),
  );
}

const distance = (index: ResidualIndex, a: string, b: string, mode: SimilarityMode, codes?: string[]) => {
  const c = compareBulls(index, a, b, { mode, codes });
  assert.ok(c, `expected ${a} and ${b} to be comparable in ${mode} mode`);
  return c.distance;
};

// --- helpers ----------------------------------------------------------------

test("median handles odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

// --- 1. shape vs magnitude ---------------------------------------------------

test("identical shape at different magnitude matches under shape, not under magnitude", () => {
  const CODES = ["LPI"];
  // A's rhythm. B is exactly 3x A — same shape, three times the size.
  // D moved almost the same AMOUNTS as A, with a slightly different rhythm.
  const A = [10, -10, 20, -20, 10, -10];
  const B = A.map((v) => v * 3);
  const D = [11, -9, 19, -21, 11, -9];

  const bulls = [
    ...fillers(7, CODES, A.length),
    bullFrom("A", { LPI: 1000 }, { LPI: A }),
    bullFrom("B", { LPI: 1000 }, { LPI: B }),
    bullFrom("D", { LPI: 1000 }, { LPI: D }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // Seven flat fillers dominate every round, so the cohort term is 0 and the
  // residuals are the raw changes — nothing is being smuggled in here.
  assert.deepEqual(index.residuals.get("A")!.get("LPI"), A);

  // SHAPE: B is a perfect match; z-normalising removes the factor of 3.
  const shape = findSimilar(index, "A", { mode: "shape" });
  assert.equal(shape.status, "ok");
  assert.equal(shape.matches[0].id, "B");
  assert.ok(shape.matches[0].distance < 1e-9, `expected ~0, got ${shape.matches[0].distance}`);

  // The flat fillers have no shape of their own, so they are refused rather
  // than reported as weak matches.
  assert.deepEqual(shape.matches.map((m) => m.id).sort(), ["B", "D"]);
  assert.equal(shape.skipped, 7);

  // MAGNITUDE: D, who moved the same amounts, wins; B is far away.
  const mag = findSimilar(index, "A", { mode: "magnitude" });
  assert.equal(mag.matches[0].id, "D");
  const dAB = distance(index, "A", "B", "magnitude");
  const dAD = distance(index, "A", "D", "magnitude");
  assert.ok(dAB > 10 * dAD, `expected B far behind D under magnitude (B ${dAB}, D ${dAD})`);
  assert.ok(dAB > 0, "B must not be a zero-distance match under magnitude");
});

// --- 2. residualisation removes a cohort-wide April drop ---------------------

test("a cohort-wide April drop is removed, and two bulls who merely followed it are not matched", () => {
  const CODES = ["LPI"];
  const STEPS = 6;
  const APRIL = 2; // career position of the base change

  // Everyone — every filler and both test bulls — falls 200 on the same round.
  const common = Array.from({ length: STEPS }, (_, j) => (j === APRIL ? -200 : 0));
  const followed = [...common];

  const bulls = [
    ...fillers(7, CODES, STEPS, common),
    bullFrom("X", { LPI: 1000 }, { LPI: followed }),
    bullFrom("Y", { LPI: 2500 }, { LPI: followed }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // The raw change on that round really is -200 for both…
  assert.equal(index.raw.get("X")!.get("LPI")![APRIL], -200);
  assert.equal(index.raw.get("Y")!.get("LPI")![APRIL], -200);
  // …the cohort term measured on that round is -200…
  const roundTime = index.steps.get("X")![APRIL].time;
  assert.equal(index.cohort.get("LPI")!.get(roundTime)!.median, -200);
  // …and it is gone from the residual, which is the only thing compared.
  assert.equal(index.residuals.get("X")!.get("LPI")![APRIL], 0);
  assert.equal(index.residuals.get("Y")!.get("LPI")![APRIL], 0);

  // X and Y did nothing of their own. They must NOT be reported as similar —
  // in either mode — because "we both lived through April" is not a match.
  for (const mode of ["shape", "magnitude"] as SimilarityMode[]) {
    const res = findSimilar(index, "X", { mode });
    assert.equal(res.status, "no-own-movement", `${mode}: X should be unmatchable`);
    assert.equal(res.matches.length, 0, `${mode}: X should have no matches`);
    assert.equal(compareBulls(index, "X", "Y", { mode }), null, `${mode}: X~Y must be refused`);
  }

  // Sanity: without residualisation X and Y would have looked IDENTICAL, which
  // is exactly the artefact being prevented.
  const rawX = index.raw.get("X")!.get("LPI")!;
  const rawY = index.raw.get("Y")!.get("LPI")!;
  assert.deepEqual(rawX, rawY);
  assert.ok(sdOf(rawX.filter((v): v is number => v != null)) > 0, "raw series does vary");
});

test("a bull with real behaviour keeps it after the cohort April drop is removed", () => {
  const CODES = ["LPI"];
  const STEPS = 6;
  const APRIL = 2;
  const drop = (own: number[]) => own.map((v, j) => (j === APRIL ? v - 200 : v));

  const OWN_P = [8, -8, 4, -4, 8, -8];
  const OWN_Q = [16, -16, 8, -8, 16, -16]; // same rhythm, twice the size
  const OWN_R = [-8, 8, -4, 4, -8, 8];     // the mirror image

  const bulls = [
    ...fillers(7, CODES, STEPS, Array.from({ length: STEPS }, (_, j) => (j === APRIL ? -200 : 0))),
    bullFrom("P", { LPI: 1000 }, { LPI: drop(OWN_P) }),
    bullFrom("Q", { LPI: 1000 }, { LPI: drop(OWN_Q) }),
    bullFrom("R", { LPI: 1000 }, { LPI: drop(OWN_R) }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // The April round contributes nothing to anybody's own behaviour…
  assert.equal(index.residuals.get("P")!.get("LPI")![APRIL], OWN_P[APRIL]);
  // …and the ranking is about the bulls, not about the round they shared.
  const res = findSimilar(index, "P", { mode: "shape" });
  assert.equal(res.matches[0].id, "Q");
  assert.ok(res.matches[0].distance < 1e-9);
  const mirror = res.matches.find((m) => m.id === "R");
  assert.ok(mirror && mirror.distance > 1, "the mirror image must not read as similar");
});

// --- 3. too little history ---------------------------------------------------

test("a bull with three rounds is rejected for insufficient overlap", () => {
  const CODES = ["LPI"];
  const STEPS = 6;
  const long = [10, -10, 20, -20, 10, -10];

  // Three rounds = two career steps, one below MIN_OVERLAP.
  const shortBull = bullFrom("SHORT", { LPI: 1000 }, { LPI: long.slice(0, 2) });
  const bulls = [
    ...fillers(7, CODES, STEPS),
    bullFrom("A", { LPI: 1000 }, { LPI: long }),
    bullFrom("B", { LPI: 1000 }, { LPI: long.map((v) => v * 2) }),
    shortBull,
  ];
  const index = buildResidualIndex(bulls, CODES);

  assert.equal(MIN_OVERLAP, 4);
  assert.equal(shortBull.rounds.length, 3);
  assert.equal(index.residuals.get("SHORT")!.get("LPI")!.length, 2);

  // As a SUBJECT he is told he has too little history, not handed a weak match.
  const res = findSimilar(index, "SHORT", { mode: "shape" });
  assert.equal(res.status, "insufficient-history");
  assert.equal(res.matches.length, 0);

  // As a CANDIDATE he is skipped rather than scored on two points.
  const other = findSimilar(index, "A", { mode: "shape" });
  assert.ok(!other.matches.some((m) => m.id === "SHORT"));
  assert.equal(compareBulls(index, "A", "SHORT", { mode: "shape" }), null);
  assert.equal(compareBulls(index, "A", "SHORT", { mode: "magnitude" }), null);

  // Every reported match clears the floor.
  for (const m of other.matches) assert.ok(m.rounds >= MIN_OVERLAP);
});

// --- 4. multi-trait combination is not dominated by the largest scale --------

test("combining traits is not dominated by the largest-scale trait", () => {
  const CODES = ["LPI", "CONF"];
  const STEPS = 6;
  // LPI residuals in the hundreds, Conformation in single digits — exactly the
  // 100:1 mismatch that makes a raw concatenation an LPI-only match.
  const LPI = [100, -100, 200, -200, 100, -100];
  const CONF = LPI.map((v) => v / 100);
  const neg = (xs: number[]) => xs.map((v) => -v);

  // S is the subject. M1 agrees with him on LPI and is the mirror image on
  // Conformation; M2 is the exact reverse. By construction the two are equally
  // (dis)similar to S — unless one trait is allowed to shout down the other.
  const bulls = [
    ...fillers(7, CODES, STEPS),
    bullFrom("S", { LPI: 3000, CONF: 10 }, { LPI, CONF }),
    bullFrom("M1", { LPI: 3000, CONF: 10 }, { LPI, CONF: neg(CONF) }),
    bullFrom("M2", { LPI: 3000, CONF: 10 }, { LPI: neg(LPI), CONF }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // The scales really are two orders of magnitude apart.
  const ratio = index.scale.get("LPI")! / index.scale.get("CONF")!;
  assert.ok(Math.abs(ratio - 100) < 1e-6, `expected a 100:1 scale gap, got ${ratio}`);

  for (const mode of ["shape", "magnitude"] as SimilarityMode[]) {
    const d1 = distance(index, "S", "M1", mode, CODES);
    const d2 = distance(index, "S", "M2", mode, CODES);
    assert.ok(
      Math.abs(d1 - d2) < 1e-9,
      `${mode}: agreeing on the big trait must not beat agreeing on the small one (${d1} vs ${d2})`,
    );
    assert.ok(d1 > 0, `${mode}: the construction must not be degenerate`);
  }

  // …and the naive version this guards against really would be lopsided, so
  // the assertion above is not passing for free.
  const rawConcatDistance = (a: string, b: string) => {
    let sum = 0, n = 0;
    for (const code of CODES) {
      const ra = index.residuals.get(a)!.get(code)!;
      const rb = index.residuals.get(b)!.get(code)!;
      for (let i = 0; i < ra.length; i++) {
        const x = ra[i], y = rb[i];
        if (x == null || y == null) continue;
        sum += (x - y) ** 2; n++;
      }
    }
    return Math.sqrt(sum / n);
  };
  const n1 = rawConcatDistance("S", "M1");
  const n2 = rawConcatDistance("S", "M2");
  assert.ok(n2 > 50 * n1, `raw concatenation should be lopsided (${n1} vs ${n2})`);

  // Both traits actually contributed to the shipped comparison.
  const c = compareBulls(index, "S", "M1", { mode: "shape", codes: CODES })!;
  assert.deepEqual(c.traits.map((t) => t.code).sort(), ["CONF", "LPI"]);
  // …and the two counts are kept apart: 6 CAREER ROUNDS, 12 compared elements.
  assert.equal(c.rounds, STEPS);
  assert.equal(c.elements, STEPS * 2);
});

// --- 5. zero variance never produces NaN -------------------------------------

test("z-normalising a window with no variance yields zeros, never NaN", () => {
  assert.deepEqual(zNormalise([5, 5, 5, 5]), [0, 0, 0, 0]);
  assert.deepEqual(zNormalise([0, 0, 0, 0]), [0, 0, 0, 0]);
  assert.deepEqual(zNormalise([]), []);
  assert.deepEqual(zNormalise([7]), [0]);
  for (const v of zNormalise([5, 5, 5, 5])) assert.ok(Number.isFinite(v));
  // …and it still normalises a window that does vary.
  const z = zNormalise([1, 2, 3]);
  assert.ok(Math.abs(z[0] + z[1] + z[2]) < 1e-12);
  assert.ok(z.every(Number.isFinite));
});

test("flat bulls never leak NaN into a search", () => {
  const CODES = ["LPI", "CONF"];
  const STEPS = 6;
  const bulls = [
    ...fillers(7, CODES, STEPS),
    bullFrom("A", { LPI: 1000, CONF: 10 }, { LPI: [10, -10, 20, -20, 10, -10], CONF: [1, -1, 2, -2, 1, -1] }),
    // Moves on Conformation only — his LPI window is perfectly flat.
    bullFrom("FLAT_LPI", { LPI: 1000, CONF: 10 }, { LPI: [0, 0, 0, 0, 0, 0], CONF: [2, -2, 4, -4, 2, -2] }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  for (const mode of ["shape", "magnitude"] as SimilarityMode[]) {
    const res = findSimilar(index, "A", { mode, codes: CODES });
    assert.equal(res.status, "ok");
    for (const m of res.matches) {
      assert.ok(Number.isFinite(m.distance), `${mode}: ${m.id} produced ${m.distance}`);
      assert.ok(Number.isFinite(m.similarity));
      for (const t of m.traits) assert.ok(Number.isFinite(t.distance));
    }
    // The flat-LPI bull is still matchable on Conformation, and the LPI trait
    // is simply left out of that comparison rather than poisoning it. In EITHER
    // mode: a window where one bull never moved has nothing informative in it,
    // so magnitude mode no longer scores it as "close" for being two near-lines.
    const c = compareBulls(index, "A", "FLAT_LPI", { mode, codes: CODES })!;
    assert.ok(c, `${mode}: should still compare on the trait that moved`);
    assert.deepEqual(c.traits.map((t) => t.code), ["CONF"]);
  }
});

// --- the shape distance really is a correlation ------------------------------

test("shape distance is exactly sqrt(2(1-r)) — so the reported score means something", () => {
  const CODES = ["LPI"];
  const A = [10, -10, 20, -20, 10, -10];
  const bulls = [
    ...fillers(7, CODES, A.length),
    bullFrom("A", { LPI: 1000 }, { LPI: A }),
    bullFrom("SAME", { LPI: 1000 }, { LPI: A.map((v) => v * 3) }),
    bullFrom("MIRROR", { LPI: 1000 }, { LPI: A.map((v) => -v) }),
    bullFrom("OTHER", { LPI: 1000 }, { LPI: [7, 3, -12, 18, -4, -9] }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // Pearson correlation of the two residual windows, computed independently.
  const pearson = (a: number[], b: number[]) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length;
    const mb = b.reduce((s, v) => s + v, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };

  for (const id of ["SAME", "MIRROR", "OTHER"]) {
    const d = distance(index, "A", id, "shape");
    const r = pearson(
      index.residuals.get("A")!.get("LPI")!.filter((v): v is number => v != null),
      index.residuals.get(id)!.get("LPI")!.filter((v): v is number => v != null),
    );
    assert.ok(Math.abs(shapeCorrelation(d) - r) < 1e-12, `${id}: distance ${d} should decode to r=${r}`);
    assert.ok(Math.abs(d - Math.sqrt(2 * (1 - r))) < 1e-12);
  }
  // The landmarks the UI leans on: 0 is identical, sqrt(2) is unrelated, 2 is mirrored.
  assert.ok(Math.abs(distance(index, "A", "MIRROR", "shape") - 2) < 1e-12);
  assert.equal(shapeCorrelation(0), 1);
  assert.ok(Math.abs(shapeCorrelation(Math.SQRT2)) < 1e-12);
  assert.equal(shapeCorrelation(2), -1);
  // …and it is clamped, so a rounded distance can never print r outside [-1, 1].
  assert.equal(shapeCorrelation(99), -1);
  assert.equal(similarityOf(0, "shape"), 1);
  assert.equal(similarityOf(0, "magnitude"), 1);
  assert.ok(similarityOf(3, "magnitude") > 0 && similarityOf(3, "magnitude") < 1);
});

// --- career alignment and curves ---------------------------------------------

test("bulls are aligned by career position, not by calendar date", () => {
  const CODES = ["LPI"];
  const shape = [10, -10, 20, -20, 10, -10];
  const index = buildResidualIndex(
    [
      ...fillers(7, CODES, shape.length),
      bullFrom("A", { LPI: 1000 }, { LPI: shape }),
      bullFrom("B", { LPI: 1000 }, { LPI: shape }),
    ],
    CODES,
  );
  // Same career shape started on the same dates here (the fixture shares round
  // dates so the cohort term exists at all), but the comparison indexes by
  // career position: A's 1st move against B's 1st move.
  const c = compareBulls(index, "A", "B", { mode: "shape" })!;
  assert.equal(c.rounds, shape.length);
  assert.ok(c.distance < 1e-9);
  assert.deepEqual(index.steps.get("A")!.map((s) => s.position), [0, 1, 2, 3, 4, 5]);
});

test("curveOf returns a career-aligned residual path", () => {
  const CODES = ["LPI"];
  const own = [10, -10, 20, -20, 10, -10];
  const index = buildResidualIndex(
    [...fillers(7, CODES, own.length), bullFrom("A", { LPI: 1000 }, { LPI: own })],
    CODES,
  );
  const curve = curveOf(index, "A", "LPI");
  assert.equal(curve.length, own.length);
  assert.deepEqual(curve.map((p) => p.residual), own);
  assert.deepEqual(curve.map((p) => p.cumulative), [10, 0, 20, 0, 10, 0]);
  assert.deepEqual(curve.map((p) => p.position), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(curveOf(index, "nobody", "LPI"), []);
});

test("a round too thin to residualise is dropped, not compared raw", () => {
  const CODES = ["LPI"];
  // Only three bulls have a change on the final round, below MIN_ROUND_COHORT.
  const base = [10, -10, 20, -20, 10];
  const bulls = [
    ...fillers(7, CODES, base.length),
    bullFrom("A", { LPI: 1000 }, { LPI: base }),
    bullFrom("B", { LPI: 1000 }, { LPI: base }),
  ];
  // Give A and B one extra round nobody else has.
  for (const id of ["A", "B"]) {
    const b = bulls.find((x) => x.id === id)!;
    const lastRound = b.rounds[b.rounds.length - 1];
    b.rounds.push({
      time: Date.UTC(2020, base.length + 1, 1),
      kind: "interim",
      rel: 0.9, daughters: 100, sireType: "proven",
      traits: new Map([["LPI", (lastRound.traits.get("LPI") ?? 0) + 50]]),
    });
  }
  const index = buildResidualIndex(bulls, CODES);
  const series = index.residuals.get("A")!.get("LPI")!;
  assert.equal(series.length, base.length + 1);
  assert.equal(series[base.length], null, "the thin round must not be comparable");
  assert.equal(index.raw.get("A")!.get("LPI")![base.length], 50);
  assert.ok(index.unmeasuredRounds > 0);

  const c = compareBulls(index, "A", "B", { mode: "magnitude" })!;
  assert.equal(c.rounds, base.length);
  assert.equal(c.elements, base.length);
});

// ===========================================================================
// REGRESSIONS. One per defect found in review; each of the five was reproduced
// against the shipped code before the fix went in, and the reproduction is what
// the test asserts against.
// ===========================================================================

// --- R1. ranking must not reward a short history -----------------------------

test("REGRESSION: ranking is by evidence, so a thin window cannot buy the top spot", () => {
  const CODES = ["LPI"];
  // A lineup where NOBODY resembles anybody: every bull is independent noise.
  // Bulls differ only in how much history they have. A fair ranking spreads the
  // top spots evenly; the shipped code ranked on raw distance and handed 59 of
  // the 68 first places to the eight four-step bulls, because a low distance is
  // cheap over four points.
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const GRID = Array.from({ length: 40 }, (_, i) => Date.UTC(2015, i * 3, 1));
  const noise = (id: string, nRounds: number): AnalogueBull => {
    let lvl = 1000;
    return {
      id,
      birthTime: Date.UTC(2010, 0, 1),
      rounds: GRID.slice(GRID.length - nRounds).map((time) => {
        lvl += rnd() * 100;
        return { time, kind: "interim" as const, rel: 0.9, daughters: 100, sireType: "proven" as string | null, traits: new Map([["LPI", lvl]]) };
      }),
    };
  };
  const bulls = [
    ...Array.from({ length: 8 }, (_, i) => noise(`SHORT${i}`, 5)),   // 4 steps
    ...Array.from({ length: 60 }, (_, i) => noise(`LONG${i}`, 40)),  // 39 steps
  ];
  const index = buildResidualIndex(bulls, CODES);

  let shortTops = 0;
  let panels = 0;
  for (const b of bulls) {
    const res = findSimilar(index, b.id, { mode: "shape" });
    if (res.status !== "ok" || !res.matches.length) continue;
    panels++;
    if (res.matches[0].id.startsWith("SHORT")) shortTops++;
    // The ordering really is the score's, and it is monotone decreasing.
    for (let i = 1; i < res.matches.length; i++) {
      assert.ok(res.matches[i - 1].score >= res.matches[i].score - 1e-12, "matches must be ordered by score");
    }
  }
  assert.ok(panels > 50, `expected most bulls to produce a panel, got ${panels}`);
  // The eight short bulls are 12% of the lineup. Under the old ranking they took
  // 87% of the top spots. Anything near their fair share is the fix working.
  assert.ok(
    shortTops <= panels * 0.3,
    `short-history bulls took ${shortTops}/${panels} top spots — ranking still rewards thin windows`,
  );

  // And directly: a flattering correlation over 4 rounds loses to a modest one
  // over a long career, which raw-distance ranking got backwards every time.
  // (Note the honest limit of this: r = 0.92 on 4 points and r = 0.45 on 30 are
  // about equally significant, ~2.7 null SDs each, and the score says so. The
  // fix is that history is now WEIGHED, not that short history always loses.)
  assert.ok(evidenceScore(0.92, 4) < evidenceScore(0.5, 40), "a long career must be able to win");
  assert.ok(0.92 > 0.5, "…while raw distance would have ranked them the other way round");
  // Monotone in the evidence for a fixed agreement, which is the whole point.
  for (let n = 5; n <= 40; n++) assert.ok(evidenceScore(0.6, n) > evidenceScore(0.6, n - 1));
  assert.equal(evidenceScore(0.9, 1), 0, "a single round is no evidence at all");
  assert.ok(Number.isFinite(evidenceScore(1, 40)), "a perfect agreement must not return Infinity");
});

// --- R2/R5. rounds vs pooled elements ----------------------------------------

test("REGRESSION: combined mode reports CAREER ROUNDS, not nine times as many", () => {
  const CODES = ["LPI", "CONF", "MILK", "FAT", "PROT", "SCS", "HERD", "MAM", "FL"];
  const STEPS = 4; // the bare minimum overlap
  // Nine traits, four career steps. The shipped code pooled across traits and
  // reported overlap = 36, which is not a round count and — worse — can never
  // fall below the THIN_OVERLAP warning threshold, so the one safeguard the
  // panel had against a four-round match was switched off in exactly the mode a
  // user picks for the broadest evidence.
  const wave = (k: number) => [1, -2, 3, -1].map((v) => v * (1 + k * 0.1));
  const bulls = [
    ...fillers(7, CODES, STEPS),
    bullFrom("S", Object.fromEntries(CODES.map((c) => [c, 100])), Object.fromEntries(CODES.map((c, k) => [c, wave(k)]))),
    bullFrom("T", Object.fromEntries(CODES.map((c) => [c, 100])), Object.fromEntries(CODES.map((c, k) => [c, wave(k + 1)]))),
  ];
  const index = buildResidualIndex(bulls, CODES);
  const c = compareBulls(index, "S", "T", { mode: "shape", codes: CODES })!;

  assert.equal(c.rounds, STEPS, "rounds must be career steps");
  assert.equal(c.elements, STEPS * CODES.length, "elements is the RMS denominator, kept separate");
  assert.equal(c.traits.length, CODES.length);
  for (const t of c.traits) assert.equal(t.overlap, STEPS, "each trait sees the same four steps");

  // The number the panel prints and tests against THIN_OVERLAP must flag this.
  assert.ok(c.rounds < THIN_OVERLAP, "a four-round combined match must trip the thin warning");
  assert.ok(c.elements >= THIN_OVERLAP, "…which the pooled count demonstrably would not");

  // Same through findSimilar, which is what the loader actually calls.
  const res = findSimilar(index, "S", { mode: "shape", codes: CODES });
  const m = res.matches.find((x) => x.id === "T")!;
  assert.equal(m.rounds, STEPS);
  assert.equal(m.elements, STEPS * CODES.length);

  // And the reported correlation really is the overlap-weighted mean of the
  // per-trait correlations, as the panel's tooltip now claims.
  const weighted = c.traits.reduce((s, t) => s + t.overlap * shapeCorrelation(t.distance), 0)
    / c.traits.reduce((s, t) => s + t.overlap, 0);
  assert.ok(Math.abs(shapeCorrelation(c.distance) - weighted) < 1e-12);
});

// --- R3. a skipped round must not leak its base change -----------------------

test("REGRESSION: two bulls who missed the same April are not matched for missing it", () => {
  const CODES = ["LPI"];
  // Six rounds on the lineup's grid; everybody falls 200 on the April one and is
  // otherwise flat. Ten bulls have a row for every round. Two do not have an
  // April row at all, so their Dec→Aug step carries the base change whole.
  const GRID = [
    Date.UTC(2020, 7, 1), Date.UTC(2020, 11, 1), Date.UTC(2021, 3, 1),
    Date.UTC(2021, 7, 1), Date.UTC(2021, 11, 1), Date.UTC(2022, 7, 1),
  ];
  const APRIL = 2;
  const bull = (id: string, skipApril: boolean): AnalogueBull => {
    let lvl = 1000;
    const rounds = [];
    for (let i = 0; i < GRID.length; i++) {
      if (i === APRIL) lvl -= 200;
      if (skipApril && i === APRIL) continue;
      rounds.push({ time: GRID[i], kind: "interim" as const, rel: 0.9, daughters: 100, sireType: "proven" as string | null, traits: new Map([["LPI", lvl]]) });
    }
    return { id, birthTime: Date.UTC(2015, 0, 1), rounds };
  };
  const bulls = [
    ...Array.from({ length: 10 }, (_, i) => bull(`FLAT${i}`, false)),
    bull("GAP1", true), bull("GAP2", true),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // The step that crossed April is recognised as spanning two rounds…
  const gapSteps = index.steps.get("GAP1")!;
  assert.deepEqual(gapSteps.map((s) => s.span), [1, 2, 1, 1]);
  assert.ok(index.spanningSteps > 0, "the crossing must be counted, not silently absorbed");

  // …and BOTH rounds it crossed are taken off it, so nothing of the base change
  // survives. Before the fix this element was -200.
  assert.deepEqual(index.residuals.get("GAP1")!.get("LPI"), [0, 0, 0, 0]);
  assert.deepEqual(index.residuals.get("FLAT0")!.get("LPI"), [0, 0, 0, 0, 0]);

  // The pair is therefore two flat lines, and refused in both modes. Before the
  // fix they were each other's #1 match at distance 0.000 in both.
  for (const mode of ["shape", "magnitude"] as SimilarityMode[]) {
    assert.equal(compareBulls(index, "GAP1", "GAP2", { mode }), null, `${mode}: must be refused`);
    const res = findSimilar(index, "GAP1", { mode });
    assert.equal(res.status, "no-own-movement", `${mode}: GAP1 has nothing of his own`);
    assert.equal(res.matches.length, 0);
  }

  // A multi-round jump must also not be allowed to DEFINE a round's cohort term:
  // April's median comes from the ten bulls who were actually there.
  assert.equal(index.cohort.get("LPI")!.get(GRID[APRIL])!.median, -200);
  assert.equal(index.cohort.get("LPI")!.get(GRID[APRIL])!.n, 10);
});

test("REGRESSION: a step across a round whose cohort term is unmeasurable is dropped", () => {
  const CODES = ["LPI"];
  // One round only two bulls have — too thin for a cohort term. A third bull
  // steps straight over it, so his change contains a base movement that cannot
  // be measured. Comparing it raw would be worse than not comparing it.
  const GRID = [0, 1, 2, 3, 4, 5].map((i) => Date.UTC(2020, i * 2, 1));
  const THIN = 3;
  const mk = (id: string, skipThin: boolean, moves: number[]): AnalogueBull => {
    let lvl = 1000;
    const rounds = [];
    for (let i = 0; i < GRID.length; i++) {
      if (i > 0) lvl += moves[i - 1];
      if (skipThin && i === THIN) continue;
      rounds.push({ time: GRID[i], kind: "interim" as const, rel: 0.9, daughters: 100, sireType: "proven" as string | null, traits: new Map([["LPI", lvl]]) });
    }
    return { id, birthTime: Date.UTC(2015, 0, 1), rounds };
  };
  const flat = [0, 0, 0, 0, 0];
  const bulls = [
    ...Array.from({ length: 6 }, (_, i) => mk(`SKIP${i}`, true, flat)), // nobody but two bulls has the thin round
    mk("HAS1", false, flat), mk("HAS2", false, flat),
  ];
  const index = buildResidualIndex(bulls, CODES);
  assert.ok(index.unmeasuredRounds > 0, "the thin round must have no cohort term");
  assert.ok(index.droppedSteps > 0, "…and the steps that crossed it must be dropped, not compared raw");
  // The dropped step is the one that spanned the unmeasurable round.
  const s = index.steps.get("SKIP0")!;
  const spanning = s.findIndex((x) => x.span > 1);
  assert.ok(spanning >= 0);
  assert.equal(index.residuals.get("SKIP0")!.get("LPI")![spanning], null);
});

// --- R4. one shared non-zero round is not a match ----------------------------

test("REGRESSION: two bulls sharing exactly one non-zero round are not reported as similar", () => {
  const CODES = ["CONF"];
  // Conformation does not move at all for most bulls in most rounds. A and B
  // share one round where each moved, by different amounts, and are identical
  // zeros everywhere else. z-normalising collapses both to the same spike, and
  // the shipped code returned distance 0.000000, r = 1.0000 and overlap 8 — a
  // headline "perfect match" resting on a single coincidence, with the thin
  // window warning not firing because 8 is not below 8.
  const A = [0, 0, 0, 5, 0, 0, 0, 0];
  const B = [0, 0, 0, 3, 0, 0, 0, 0];
  const bulls = [
    ...fillers(7, CODES, A.length),
    bullFrom("A", { CONF: 10 }, { CONF: A }),
    bullFrom("B", { CONF: 10 }, { CONF: B }),
  ];
  const index = buildResidualIndex(bulls, CODES);

  // The residuals really are the spike windows — nothing else is going on.
  assert.deepEqual(index.residuals.get("A")!.get("CONF"), A);
  assert.deepEqual(index.residuals.get("B")!.get("CONF"), B);

  for (const mode of ["shape", "magnitude"] as SimilarityMode[]) {
    assert.equal(
      compareBulls(index, "A", "B", { mode }), null,
      `${mode}: one coincident round is not a match`,
    );
    const res = findSimilar(index, "A", { mode });
    assert.ok(!res.matches.some((m) => m.id === "B"), `${mode}: B must not appear`);
  }

  // The window IS comparable at eight positions — it is the informativeness
  // floor, not the overlap floor, that refuses it. Relax the floor and the old
  // behaviour returns, which shows the guard is what is doing the work.
  const loose = compareBulls(index, "A", "B", { mode: "shape", minInformative: 1 })!;
  assert.equal(loose.rounds, A.length);
  assert.equal(loose.informativeRounds, 1);
  assert.ok(shapeCorrelation(loose.distance) > 0.999, "…and it would have scored a perfect 1.00");
});

test("REGRESSION: rounds where both bulls genuinely moved still count as informative", () => {
  const CODES = ["LPI"];
  // The guard must not swallow legitimate matches: two bulls who moved on every
  // round are fully informative and still compared.
  const A = [10, -10, 20, -20, 10, -10];
  const bulls = [
    ...fillers(7, CODES, A.length),
    bullFrom("A", { LPI: 1000 }, { LPI: A }),
    bullFrom("B", { LPI: 1000 }, { LPI: A.map((v) => v * 3) }),
  ];
  const index = buildResidualIndex(bulls, CODES);
  const c = compareBulls(index, "A", "B", { mode: "shape" })!;
  assert.equal(c.rounds, A.length);
  assert.equal(c.informativeRounds, A.length);
  assert.equal(c.traits[0].informative, A.length);
  assert.equal(MIN_INFORMATIVE, 4);
  assert.ok(c.distance < 1e-9);
});
