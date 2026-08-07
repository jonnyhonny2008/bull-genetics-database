import { test } from "node:test";
import assert from "node:assert/strict";
import { US_TRAIT_CATALOG, US_SAFELY_RANKED_TRAITS, usTrait } from "./trait-catalog";
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
  const t = usTrait(code);
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

test("dairy form is the one type trait of the four kept directional", () => {
  assert.equal(dir("DFM"), "higher");
  assert.ok(
    US_SAFELY_RANKED_TRAITS.some((t) => t.code === "DFM"),
    "a higher-is-better trait with nothing to caution about is safe to rank",
  );
});

test("the traits with a long-standing intermediate optimum are untouched", () => {
  for (const code of ["TLG", "RLS", "UDP"]) {
    assert.equal(dir(code), "intermediate", code);
  }
});

test("nothing but a higher-is-better trait is treated as safe to rank", () => {
  // US_SAFELY_RANKED_TRAITS feeds anything that sorts high-to-low and reads the
  // top of the list. A lower-is-better or intermediate trait in it would put the
  // WORST bulls on top, silently.
  for (const t of US_SAFELY_RANKED_TRAITS) {
    assert.equal(t.direction, "higher", `${t.code} is treated as safely ranked but is not higher-is-better`);
  }
});

test("every trait has a direction, and anything not higher-is-better carries a caution", () => {
  for (const t of US_TRAIT_CATALOG) {
    assert.ok(t.direction, `${t.code} has no direction`);
    if (t.direction !== "higher") {
      assert.ok(t.caution, `${t.code} is not higher-is-better but carries no caution`);
    }
  }
});

test("no code appears twice", () => {
  const seen = new Set<string>();
  for (const t of US_TRAIT_CATALOG) {
    assert.ok(!seen.has(t.code), `${t.code} is listed twice — usTrait() would silently return the first`);
    seen.add(t.code);
  }
});
