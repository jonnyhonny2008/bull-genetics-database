import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRound } from "./sire-class";

// Proven = full EBV (daughter-based); Genomic = GPA (genomic parent average).
// The LPI official code is the direct signal and must win over the activity code.

test("GPA (official code 2) is genomic", () => {
  assert.equal(classifyRound({ officialCode: "2", activityCode: "6" }), "genomic");
});

test("official daughter-based (code 1) is proven", () => {
  assert.equal(classifyRound({ officialCode: "1", activityCode: "5" }), "proven");
});

test("MACE (official code 3) is proven even with an unproven domestic activity code", () => {
  // This is the case the old activity-code-first order got wrong: a MACE sire is
  // daughter-based abroad (full EBV) but carries a 'not yet proven' domestic code.
  assert.equal(classifyRound({ officialCode: "3", activityCode: "5" }), "proven");
});

test("with no official LPI code, fall back to the activity code", () => {
  assert.equal(classifyRound({ officialCode: "0", activityCode: "6" }), "proven"); // 6 = newly proven, genotyped
  assert.equal(classifyRound({ officialCode: "0", activityCode: "5" }), "genomic"); // 5 = not yet proven, genotyped
  assert.equal(classifyRound({ officialCode: null, activityCode: "1" }), "proven");
});

test("with neither code, fall back to a daughter count", () => {
  assert.equal(classifyRound({ daughters: 40 }), "proven");
  assert.equal(classifyRound({ daughters: 0 }), "genomic");
  assert.equal(classifyRound({}), "genomic");
});
