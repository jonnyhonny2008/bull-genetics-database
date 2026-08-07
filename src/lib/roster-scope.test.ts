import { test } from "node:test";
import assert from "node:assert/strict";
import { CA_ROSTER, US_ROSTER, rosterScope } from "./roster-scope";

// ---------------------------------------------------------------------------
// The scope is a Prisma predicate, so it cannot be exercised without a database.
// What CAN be pinned without one is its SHAPE — and the shape is the whole risk.
//
// Two ways to get this wrong, both silent:
//   * make the Canadian rule `evaluations: { some: {} }` and every hand-entered
//     animal that has not been proofed yet disappears from the lineup;
//   * make it `usEvaluations: { none: {} }` alone and every dual-registered
//     Blondin bull — the ones that matter most — disappears instead.
// The rule has to be the OR of those two, and this file says so out loud.
// ---------------------------------------------------------------------------

/** A tiny evaluator for the subset of Prisma predicate shapes used here. */
function matches(scope: Record<string, unknown>, animal: { ca: number; us: number }): boolean {
  if (Array.isArray(scope.OR)) return (scope.OR as Record<string, unknown>[]).some((c) => matches(c, animal));
  if (scope.evaluations) {
    const e = scope.evaluations as Record<string, unknown>;
    if (e.some) return animal.ca > 0;
    if (e.none) return animal.ca === 0;
  }
  if (scope.usEvaluations) {
    const e = scope.usEvaluations as Record<string, unknown>;
    if (e.some) return animal.us > 0;
    if (e.none) return animal.us === 0;
  }
  throw new Error("unrecognised predicate shape: " + JSON.stringify(scope));
}

const DUAL = { ca: 3, us: 2 };        // a Blondin bull proofed in both countries
const CANADIAN = { ca: 4, us: 0 };    // Lactanet only
const AMERICAN = { ca: 0, us: 1 };    // a CDCB import — one of ~70,000
const UNPROOFED = { ca: 0, us: 0 };   // entered by hand, awaiting a first round

test("THE POINT: the CDCB import stays off the Canadian side", () => {
  assert.equal(matches(CA_ROSTER, AMERICAN), false);
  assert.equal(matches(US_ROSTER, AMERICAN), true);
});

test("a bull proofed in both countries appears on BOTH sides", () => {
  // This is what the double card is for. If either of these flips, the toggle
  // starts landing on a bull that is not in the list he was reached from.
  assert.equal(matches(CA_ROSTER, DUAL), true);
  assert.equal(matches(US_ROSTER, DUAL), true);
});

test("an unproofed hand-entered animal stays Canadian and does not leak into the US list", () => {
  // The asymmetry that a naive `evaluations: { some: {} }` would destroy.
  assert.equal(matches(CA_ROSTER, UNPROOFED), true);
  assert.equal(matches(US_ROSTER, UNPROOFED), false);
});

test("a Canadian-only bull is Canadian only", () => {
  assert.equal(matches(CA_ROSTER, CANADIAN), true);
  assert.equal(matches(US_ROSTER, CANADIAN), false);
});

test("every animal lands on at least one side — nothing falls through the gap", () => {
  for (const a of [DUAL, CANADIAN, AMERICAN, UNPROOFED]) {
    assert.ok(matches(CA_ROSTER, a) || matches(US_ROSTER, a), JSON.stringify(a));
  }
});

test("rosterScope picks the right rule", () => {
  assert.deepEqual(rosterScope("ca"), CA_ROSTER);
  assert.deepEqual(rosterScope("us"), US_ROSTER);
});

test("the Canadian rule is an OR of exactly the two clauses, not a single one", () => {
  // Guards the specific regression: someone "simplifying" this to one clause.
  assert.ok(Array.isArray(CA_ROSTER.OR), "CA_ROSTER must stay an OR");
  assert.equal((CA_ROSTER.OR as unknown[]).length, 2);
});
