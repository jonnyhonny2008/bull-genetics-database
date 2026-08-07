import { test } from "node:test";
import assert from "node:assert/strict";
import { toSystem, systemFromPathname, systemHref, routeAvailable } from "./genetic-system";

// ---------------------------------------------------------------------------
// The navigation contract for the two-program app.
//
// The toggle is the whole interaction model: one bull, two evaluation systems,
// one click between them. Two ways it can be wrong, and both are worse than a
// broken link:
//
//   * losing the bull — toggling from a bull's page to a LIST makes the toggle
//     useless exactly where it matters most;
//   * minting a dead URL — the two sides are not mirror images, so mapping a path
//     across blindly 404s from about half the app.
// ---------------------------------------------------------------------------

test("THE POINT: an animal page carries the bull across, both directions", () => {
  // Both systems key off the same Animal.id — the US side is a parallel
  // EVALUATION table, not a parallel animal roster — so the id is the same bull.
  assert.equal(toSystem("/animals/abc123", "us"), "/us/animals/abc123");
  assert.equal(toSystem("/us/animals/abc123", "ca"), "/animals/abc123");
  // ...and it round-trips, which is what "toggle back and forth" means.
  const there = toSystem("/animals/abc123", "us");
  assert.equal(toSystem(there, "ca"), "/animals/abc123");
});

test("a Canadian-only sub-page of a bull lands on that bull's US card, not a list", () => {
  // /animals/[id]/edit, /proofs/new etc. have no US twin. Falling back to the
  // bull's US card keeps the user on the same animal.
  assert.equal(toSystem("/animals/abc123/edit", "us"), "/us/animals/abc123");
  assert.equal(toSystem("/animals/abc123/proofs/new", "us"), "/us/animals/abc123");
  // Going the other way, the deeper Canadian path is preserved.
  assert.equal(toSystem("/animals/abc123/edit", "ca"), "/animals/abc123/edit");
});

test("shared sections map straight across", () => {
  for (const p of ["/dashboard", "/animals", "/analysis", "/compare", "/reports"]) {
    assert.equal(toSystem(p, "us"), `/us${p}`, p);
    assert.equal(toSystem(`/us${p}`, "ca"), p, p);
  }
});

test("a page the other side does not have falls back to its dashboard, never a 404", () => {
  // Canada has whole groups America will never have: the mating program and
  // parent average need female evaluations CDCB does not publish; Data In and
  // Configuration are Canadian-pipeline screens.
  for (const p of ["/parent-average", "/uploads", "/import-proofs", "/animal-import", "/review", "/sources", "/traits", "/breeds", "/admin", "/admin/errors"]) {
    assert.equal(toSystem(p, "us"), "/us/dashboard", p);
  }
  // Specialists was America's one exclusive page. It is now a trait picker inside
  // BOTH animals lists — a search, not a place — so the path is dead on both sides
  // and must land on a dashboard rather than a 404.
  assert.equal(toSystem("/us/specialists", "ca"), "/dashboard");
  assert.equal(toSystem("/specialists", "us"), "/us/dashboard");
});

test("nested report pages cross over only where they really exist", () => {
  assert.equal(toSystem("/reports/proof-changes", "us"), "/us/reports/proof-changes");
  assert.equal(toSystem("/reports/round-summary", "us"), "/us/reports/round-summary");
  // The interim report has no US meaning — CDCB ships one file per round.
  assert.equal(toSystem("/reports/interim-changes", "us"), "/us/reports");
  assert.equal(toSystem("/reports/mating-program", "us"), "/us/reports");
});

test("the root and bare /us resolve to a dashboard", () => {
  assert.equal(toSystem("/", "us"), "/us/dashboard");
  assert.equal(toSystem("/", "ca"), "/dashboard");
  assert.equal(toSystem("/us", "ca"), "/dashboard");
});

test("toSystem never returns a path for the wrong system", () => {
  const paths = ["/", "/dashboard", "/animals", "/animals/x1", "/animals/x1/edit", "/reports", "/reports/proof-changes", "/reports/interim-changes", "/parent-average", "/admin", "/us/dashboard", "/us/animals", "/us/animals/x1", "/us/specialists"];
  for (const p of paths) {
    assert.ok(systemFromPathname(toSystem(p, "us")) === "us", `${p} -> us`);
    assert.ok(systemFromPathname(toSystem(p, "ca")) === "ca", `${p} -> ca`);
  }
});

test("systemFromPathname does not mistake a lookalike path for the US side", () => {
  assert.equal(systemFromPathname("/us/animals"), "us");
  assert.equal(systemFromPathname("/us"), "us");
  assert.equal(systemFromPathname("/animals"), "ca");
  // A Canadian route that merely starts with the letters "us" is not the US side.
  assert.equal(systemFromPathname("/uses"), "ca");
  assert.equal(systemFromPathname("/usage/report"), "ca");
});

test("route availability reflects what each side actually has", () => {
  assert.ok(routeAvailable("/animals", "us"));
  assert.ok(!routeAvailable("/parent-average", "us"), "needs female data CDCB does not publish");
  // Neither side has a specialists PAGE: both have the picker in their list.
  assert.ok(!routeAvailable("/specialists", "ca"));
  assert.ok(!routeAvailable("/specialists", "us"));
  assert.equal(systemHref("/animals", "us"), "/us/animals");
  assert.equal(systemHref("/animals", "ca"), "/animals");
});
