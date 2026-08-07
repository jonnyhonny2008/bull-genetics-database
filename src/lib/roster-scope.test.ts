import { test } from "node:test";
import assert from "node:assert/strict";
import { CA_ROSTER, US_ROSTER, DUAL_REGISTERED } from "./roster-scope";

// ---------------------------------------------------------------------------
// These tests changed shape when the tables were split, and the history is the
// point. They used to assert a predicate that decided, row by row, whether a
// shared-table animal was Canadian or American. That predicate was written twice
// and leaked 18,500 and then 20,000 rows into the Canadian lineup.
//
// It leaked because the CDCB importer created rows in one pass and marked them in
// the next, so an interrupted run left animals that no query could classify. The
// fix was structural: the American roster moved to its own table. What is left to
// test is that nobody quietly reintroduces a filter — because the day CA_ROSTER
// stops being empty, every Canadian list on the site silently gets shorter, and
// nothing about the page looks broken.
// ---------------------------------------------------------------------------

test("THE POINT: the Canadian scope filters nothing, because Animal is Canadian by construction", () => {
  assert.deepEqual(CA_ROSTER, {}, "a condition here silently narrows every Canadian list");
});

test("the American scope is expressed against the American table", () => {
  // If this ever grows an `evaluations`/`identifiers` clause it has drifted back
  // towards deciding membership by content instead of by which table a row is in.
  assert.deepEqual(US_ROSTER, { archived: false });
});

test("dual registration is a join, not a category", () => {
  // A bull in both countries has a row in both tables. The double card and the nav
  // toggle depend on that being a relation rather than a flag someone maintains.
  assert.deepEqual(DUAL_REGISTERED, { usAnimals: { some: {} } });
});

test("the Canadian scope never mentions the American roster", () => {
  // The failed predicates both did. Reaching across the tables to decide who is
  // Canadian is exactly the mistake that was removed.
  const s = JSON.stringify(CA_ROSTER);
  for (const leak of ["usEvaluations", "usAnimals", "cdcb_id17", "identifiers"]) {
    assert.ok(!s.includes(leak), `CA_ROSTER must not reason about ${leak}`);
  }
});
