import { test } from "node:test";
import assert from "node:assert/strict";
import { caFavourableEnd, isCaIntermediateOptimum, CA_INTERMEDIATE_OPTIMUM } from "./ca-linear";
import { HOLSTEIN_LINEAR } from "../../prisma/traits-holstein";

// ---------------------------------------------------------------------------
// The Canadian INTERMEDIATE OPTIMUM block, pinned to the printed chart.
//
// Ten traits, named on the Canadian linear chart itself. The risk this guards is
// quiet drift: a trait dropping off the list still draws a bar, and a bar always
// implies that further right is better. Nothing on the page would look broken.
// ---------------------------------------------------------------------------

/** Exactly the traits printed under INTERMEDIATE OPTIMUM, by their chart names. */
const PRINTED = [
  ["UFLOOR", "Udder Floor"],
  ["UDEP", "Udder Depth"],
  ["FTP", "Front Teat Placement"],
  ["RTP", "Rear Teat Placement"],
  ["TL", "Teat Length"],
  ["RLSV", "Rear Legs Side View"],
  ["FLV", "Front Leg View"],
  ["STA", "Stature"],
  ["RA", "Rump Angle"],
  ["THURL", "Thurl Placement"],
] as const;

test("every trait printed under INTERMEDIATE OPTIMUM is treated as one", () => {
  for (const [code, name] of PRINTED) {
    assert.ok(isCaIntermediateOptimum(code, name), `${name} (${code})`);
    assert.equal(caFavourableEnd(code, name, true), "intermediate", name);
  }
  assert.equal(CA_INTERMEDIATE_OPTIMUM.size, PRINTED.length, "the code list and the chart must stay the same length");
});

test("an intermediate trait is intermediate whichever way the config leans", () => {
  // higherIsBetter is a boolean and cannot express a third state, so it must not
  // be able to override the chart.
  for (const hib of [true, false, null, undefined]) {
    assert.equal(caFavourableEnd("STA", "Stature", hib), "intermediate", String(hib));
  }
});

test("the name fallback catches a trait whose code drifted", () => {
  // Same trait, upstream code changed. It must not silently start drawing as if
  // taller were better.
  assert.equal(caFavourableEnd("STATURE_V2", "Stature", true), "intermediate");
  // Both spellings the chart and the seed disagree on.
  assert.equal(caFavourableEnd("XX", "Fore Teat Placement", true), "intermediate");
  assert.equal(caFavourableEnd("XX", "Front Legs View", true), "intermediate");
  // Punctuation and case are not a reason to miss one.
  assert.equal(caFavourableEnd("XX", "Rear Legs, Side View", true), "intermediate");
});

test("traits NOT on the list keep their configured direction", () => {
  assert.equal(caFavourableEnd("FUA", "Fore Attachment", true), "right");
  assert.equal(caFavourableEnd("LOCO", "Locomotion", true), "right");
  // A trait configured good-when-low keeps that, rather than being assumed upward.
  assert.equal(caFavourableEnd("XYZ", "Something Deep", false), "left");
  // Unconfigured claims nothing at all.
  assert.equal(caFavourableEnd("XYZ", "Unknown trait", null), undefined);
});

test("the intermediate list does not leak onto traits that merely look similar", () => {
  for (const name of ["Rear Attachment Height", "Rear Legs Rear View", "Pin Width", "Chest Width"]) {
    assert.ok(!isCaIntermediateOptimum("ZZZ", name), name);
  }
});

test("every code on the list is a real seeded linear trait", () => {
  const seeded = new Map(HOLSTEIN_LINEAR.map((t) => [t.traitCode, t.traitName]));
  for (const code of CA_INTERMEDIATE_OPTIMUM) {
    assert.ok(seeded.has(code), `${code} is not a seeded linear trait — the chart would never match it`);
  }
});

test("the two systems now agree on the traits they share", async () => {
  // Stature, Rump Angle and Rear Teat Placement are intermediate on BOTH sides.
  // They are still stored separately on purpose — the associations are free to
  // diverge again — but today they must not contradict each other on one bull.
  const { usTrait } = await import("./us-cdcb/trait-catalog");
  for (const [caCode, caName, usCode] of [
    ["STA", "Stature", "STA"],
    ["RA", "Rump Angle", "RPA"],
    ["RTP", "Rear Teat Placement", "RTP"],
  ] as const) {
    assert.equal(caFavourableEnd(caCode, caName, true), "intermediate", caName);
    assert.equal(usTrait(usCode)?.direction, "intermediate", usCode);
  }
});
