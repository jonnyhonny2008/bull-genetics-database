import { test } from "node:test";
import assert from "node:assert/strict";
import { US_SPECIALIST_CATALOG, US_SPECIALIST_TRAITS, usSpecialistTrait } from "./specialists";
import { HOLSTEIN_LINEAR } from "../../../prisma/traits-holstein";

// ---------------------------------------------------------------------------
// The direction of a type trait, pinned.
//
// These are the owner's calls (2026-08-07) and they are not derivable from the
// data, so nothing but a test protects them from being "tidied" back to a
// symmetric-looking catalogue later.
//
// The scale orientation is still asserted below even though all three of the
// traits it governs are now intermediate. It is the fact that would have to be
// re-checked the moment anyone gives one of them a direction again — a decision
// about "wide" or "tall" is meaningless without knowing which end is which.
// ---------------------------------------------------------------------------

function dir(code: string) {
  const t = usSpecialistTrait(code);
  assert.ok(t, `${code} missing from the catalogue`);
  return t.direction;
}

test("the scale orientation these directions depend on is the seeded one", () => {
  const ends = (code: string) => {
    const t = HOLSTEIN_LINEAR.find((x) => x.traitCode === code);
    assert.ok(t, `${code} missing from the trait seed`);
    return [t.leftLabel, t.rightLabel];
  };
  // Wide is the NEGATIVE end. This is the fact that makes "wider is better" mean
  // "lower is better" — if this seed ever flips, RTP's direction must flip with it.
  assert.deepEqual(ends("RTP"), ["Wide", "Close"]);
  // Short is the NEGATIVE end, so "lower is better" means the moderate-framed bull.
  assert.deepEqual(ends("STA"), ["Short", "Tall"]);
});

test("stature, rump angle and rear teat placement are intermediate optimum", () => {
  // The owner's call, and the published arithmetic agrees: UDC and FLC both
  // SUBTRACT 0.20 x STA, and RTP goes through RPstar, a curve that peaks at 1.0
  // and falls away after it. A formula that stops rewarding a trait past a point
  // is describing an optimum, not a direction.
  for (const code of ["STA", "RPA", "RTP"]) {
    assert.equal(dir(code), "intermediate", code);
  }
});

test("dairy form is the one type trait kept directional, and is offered as a specialty", () => {
  assert.equal(dir("DFM"), "higher");
  assert.ok(
    US_SPECIALIST_TRAITS.some((t) => t.code === "DFM"),
    "a higher-is-better trait with no exclusion reason belongs in the picker",
  );
});

test("the traits with a long-standing intermediate optimum are untouched", () => {
  for (const code of ["TLG", "RLS", "UDP"]) {
    assert.equal(dir(code), "intermediate", code);
  }
});

test("no lower-is-better trait is offered as a specialty", () => {
  // The finder ranks bulls solidly POSITIVE on every picked trait, so a
  // lower-is-better trait in the picker would put the worst bulls on top.
  for (const t of US_SPECIALIST_TRAITS) {
    assert.equal(t.direction, "higher", `${t.code} is offered but is not higher-is-better`);
  }
});

test("every excluded trait still states a reason, and every trait has a direction", () => {
  for (const t of US_SPECIALIST_CATALOG) {
    assert.ok(t.direction, `${t.code} has no direction`);
    if (t.direction !== "higher") {
      assert.ok(t.excluded, `${t.code} is not higher-is-better but gives no reason for being excluded`);
    }
  }
});
