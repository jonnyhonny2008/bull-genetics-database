import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTraitRanges, readTraitRanges, serialiseTraitRanges, describeTraitRange, isImpossibleRange, rangeFilter,
} from "./trait-range";

// ---------------------------------------------------------------------------
// THE URL FORMAT IS A PERMANENT INTERFACE, not an implementation detail.
//
// SavedSearch stores a literal {path, query} and replays it as a link, and views
// get emailed. Once anyone saves one, changing what `f=` means silently changes
// what THEIR saved link returns — a bull list that no longer matches the filter
// it claims. So the shape is pinned here rather than left to whatever the parser
// happens to do today.
// ---------------------------------------------------------------------------

const ALLOWED = new Set(["GTPI", "PTAT", "RPA", "SCS", "NM"]);

test("the three shapes a person can ask for", () => {
  assert.deepEqual(parseTraitRanges("GTPI:2800..", ALLOWED), [{ code: "GTPI", min: 2800, max: null }]);
  assert.deepEqual(parseTraitRanges("PTAT:..1.5", ALLOWED), [{ code: "PTAT", min: null, max: 1.5 }]);
  assert.deepEqual(parseTraitRanges("RPA:-0.5..1", ALLOWED), [{ code: "RPA", min: -0.5, max: 1 }]);
});

test("several traits stack, in the order written", () => {
  assert.deepEqual(parseTraitRanges("GTPI:2800..,PTAT:..1.5,RPA:-0.5..1", ALLOWED), [
    { code: "GTPI", min: 2800, max: null },
    { code: "PTAT", min: null, max: 1.5 },
    { code: "RPA", min: -0.5, max: 1 },
  ]);
});

test("a bare number is a FLOOR, not an equality test", () => {
  // Typing "GTPI:2800" by hand is common. Read as equality it would match almost
  // nothing, and the reader would conclude there are no such bulls.
  assert.deepEqual(parseTraitRanges("GTPI:2800", ALLOWED), [{ code: "GTPI", min: 2800, max: null }]);
});

test("negative bounds need no escaping at either end", () => {
  // This is the whole reason the separator is ".." and not "-".
  assert.deepEqual(parseTraitRanges("RPA:..-1.5", ALLOWED), [{ code: "RPA", min: null, max: -1.5 }]);
  assert.deepEqual(parseTraitRanges("RPA:-3..-1", ALLOWED), [{ code: "RPA", min: -3, max: -1 }]);
});

test("a bound of zero survives — it is a real filter, not an absent one", () => {
  // The bug this guards: `Number(s) || null` turns a legitimate 0 into "no bound",
  // so "PTAT at least 0" would quietly return every bull including the negatives.
  assert.deepEqual(parseTraitRanges("PTAT:0..", ALLOWED), [{ code: "PTAT", min: 0, max: null }]);
  assert.deepEqual(parseTraitRanges("PTAT:..0", ALLOWED), [{ code: "PTAT", min: null, max: 0 }]);
});

test("a code with no column behind it is dropped, not ignored downstream", () => {
  // A dropped code must never reach the query builder: it would return an
  // UNFILTERED list under a filter chip claiming otherwise.
  assert.deepEqual(parseTraitRanges("STA:..1", ALLOWED), []);
  assert.deepEqual(parseTraitRanges("STA:..1,GTPI:2800..", ALLOWED), [{ code: "GTPI", min: 2800, max: null }]);
});

test("junk is dropped rather than parsed into a bound", () => {
  for (const raw of ["", "GTPI", "GTPI:", "GTPI:..", ":2800..", "GTPI:abc", "GTPI:NaN..", "GTPI:Infinity..", "GTPI:1e5.."]) {
    assert.deepEqual(parseTraitRanges(raw, ALLOWED), [], raw);
  }
});

test("lower case and stray spaces are accepted — links get retyped by hand", () => {
  assert.deepEqual(parseTraitRanges(" gtpi:2800.. , ptat:..1.5 ", ALLOWED), [
    { code: "GTPI", min: 2800, max: null },
    { code: "PTAT", min: null, max: 1.5 },
  ]);
});

test("a repeated code keeps the first, so two bounds cannot silently fight", () => {
  assert.deepEqual(parseTraitRanges("GTPI:2800..,GTPI:..2000", ALLOWED), [{ code: "GTPI", min: 2800, max: null }]);
});

test("serialise round-trips parse exactly", () => {
  const raw = "GTPI:2800..,PTAT:..1.5,RPA:-0.5..1";
  assert.equal(serialiseTraitRanges(parseTraitRanges(raw, ALLOWED)), raw);
});

test("an impossible range is reported, never repaired by swapping", () => {
  // Swapping would show results that do not match the chip describing them.
  const [r] = parseTraitRanges("GTPI:2800..2000", ALLOWED);
  assert.deepEqual(r, { code: "GTPI", min: 2800, max: 2000 });
  assert.ok(isImpossibleRange(r));
  assert.ok(!isImpossibleRange({ code: "GTPI", min: 2000, max: 2800 }));
  assert.ok(!isImpossibleRange({ code: "GTPI", min: 2800, max: null }));
});

test("both bounds are inclusive in the Prisma filter", () => {
  assert.deepEqual(rangeFilter({ code: "X", min: 1, max: 2 }), { gte: 1, lte: 2 });
  assert.deepEqual(rangeFilter({ code: "X", min: 1, max: null }), { gte: 1 });
  assert.deepEqual(rangeFilter({ code: "X", min: null, max: 2 }), { lte: 2 });
  // Zero must appear as a bound, not be dropped by a falsy check.
  assert.deepEqual(rangeFilter({ code: "X", min: 0, max: null }), { gte: 0 });
});

test("the chip wording matches the filter", () => {
  const f = (v: number) => v.toFixed(1);
  assert.equal(describeTraitRange({ code: "X", min: 1, max: null }, f), "≥ 1.0");
  assert.equal(describeTraitRange({ code: "X", min: null, max: 2 }, f), "≤ 2.0");
  assert.equal(describeTraitRange({ code: "X", min: 1, max: 2 }, f), "1.0 to 2.0");
});

test("a code this list cannot filter is REPORTED, not just dropped", () => {
  // The failure this guards is the nastiest one available: an unrecognised code
  // silently yields an UNFILTERED list to someone who asked for a narrow set.
  const { ranges, dropped } = readTraitRanges("STA:..1,GTPI:2800..", ALLOWED);
  assert.deepEqual(ranges, [{ code: "GTPI", min: 2800, max: null }]);
  assert.deepEqual(dropped, ["STA"]);
});

test("a malformed clause is not reported as an unavailable trait", () => {
  // "STA:" asked for nothing. Announcing it as a trait we cannot offer would be
  // noise, and would fire on every half-typed URL.
  assert.deepEqual(readTraitRanges("STA:", ALLOWED).dropped, []);
  assert.deepEqual(readTraitRanges("STA:abc", ALLOWED).dropped, []);
  assert.deepEqual(readTraitRanges("STA:..", ALLOWED).dropped, []);
  // ...but a real bound on an unavailable trait is reported.
  assert.deepEqual(readTraitRanges("STA:1", ALLOWED).dropped, ["STA"]);
  assert.deepEqual(readTraitRanges("STA:..0", ALLOWED).dropped, ["STA"]);
});

test("nothing is reported when every code is available", () => {
  assert.deepEqual(readTraitRanges("GTPI:2800..,PTAT:..1.5", ALLOWED).dropped, []);
});
