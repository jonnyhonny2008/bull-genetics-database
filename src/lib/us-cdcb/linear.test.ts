import { test } from "node:test";
import assert from "node:assert/strict";
import { usLinearGroups, usFavourableEnd, US_LINEAR_ENDS, US_LINEAR_MIN, US_LINEAR_MAX } from "./linear";
import { US_SPECIALIST_CATALOG } from "./specialists";

// ---------------------------------------------------------------------------
// What actually reaches the chart. The component is tested separately for how it
// DRAWS a datum; this file tests that the datum describes the right animal.
// ---------------------------------------------------------------------------

const BULL = { STA: 1.8, DFM: 2.1, RTP: -1.4, RPA: 0.9, STR: 0.5, FUA: 1.1, FTA: 0.3 };

function flat() {
  return usLinearGroups(BULL).flatMap((g) => g.traits);
}
function trait(name: string) {
  const t = flat().find((x) => x.name === name);
  assert.ok(t, `${name} not plotted`);
  return t;
}

test("the traits the owner ruled on reach the chart the way they were told to", () => {
  // Stature, Rump Angle and Rear Teat Placement are intermediate optimum on the
  // US side as well as the Canadian one — neither extreme is the target.
  for (const name of ["Stature", "Rump Angle", "Rear Teat Placement"]) {
    assert.equal(trait(name).favourable, "intermediate", name);
  }
  assert.equal(trait("Dairy Form").favourable, "right", "dairy form: higher is better");
});

test("an intermediate trait is drawn as such however the bull sits", () => {
  // STA +1.8 must not be shaded good merely for being positive, and RTP −1.4 must
  // not be shaded bad merely for being negative. Neither is a verdict.
  const sta = trait("Stature"), rtp = trait("Rear Teat Placement");
  assert.ok(sta.value > 0 && sta.favourable === "intermediate", "a tall bull is not thereby a worse or better one");
  assert.ok(rtp.value < 0 && rtp.favourable === "intermediate");
  // The end descriptors are still carried, so the reader can see WHICH way he sits.
  assert.deepEqual([rtp.left, rtp.right], ["Wide", "Close"]);
  assert.deepEqual([sta.left, sta.right], ["Short", "Tall"]);
});

test("every plotted trait uses the ±3 track", () => {
  for (const t of flat()) {
    assert.equal(t.min, US_LINEAR_MIN, t.name);
    assert.equal(t.max, US_LINEAR_MAX, t.name);
  }
  assert.equal(US_LINEAR_MIN, -3);
  assert.equal(US_LINEAR_MAX, 3);
});

test("composite scores are kept off the chart", () => {
  // Neither has two named biological extremes, so neither gets an axis.
  for (const code of ["PTAT", "FLS"]) {
    assert.ok(!(code in US_LINEAR_ENDS), `${code} has no honest end descriptors`);
  }
  const plotted = usLinearGroups({ ...BULL, PTAT: 3.2, FLS: 1.1 }).flatMap((g) => g.traits);
  assert.ok(!plotted.some((t) => t.name.includes("PTAT")));
});

test("a trait the bull has no figure for is omitted, not drawn at zero", () => {
  // Drawing a missing trait at the centre line would show breed average, which is
  // a claim about the bull rather than an absence of one.
  const names = flat().map((t) => t.name);
  assert.ok(!names.includes("Teat Length"), "TLG is absent from this bull");
  assert.ok(names.includes("Fore Udder Attachment"));
});

test("nothing is plotted for an animal with no type data at all", () => {
  assert.deepEqual(usLinearGroups({}), []);
  assert.deepEqual(usLinearGroups({ NM: 900, MILK: 1500 }), []);
});

test("every descriptor pair belongs to a trait the catalogue knows", () => {
  const known = new Set(US_SPECIALIST_CATALOG.map((t) => t.code));
  for (const code of Object.keys(US_LINEAR_ENDS)) {
    assert.ok(known.has(code), `${code} has descriptors but no catalogue entry, so it has no direction`);
    assert.notEqual(usFavourableEnd(code), undefined, `${code} would be drawn with no stated direction`);
  }
});

test("NaN and nulls from a sparse extract never reach the chart", () => {
  const junk = usLinearGroups({ STA: NaN, DFM: Infinity, RTP: 0 });
  assert.deepEqual(junk.flatMap((g) => g.traits).map((t) => t.name), ["Rear Teat Placement"]);
});
