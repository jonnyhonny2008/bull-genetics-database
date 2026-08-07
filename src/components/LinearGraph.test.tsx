import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LinearGraph, type LinearTraitDatum } from "./LinearGraph";

// ---------------------------------------------------------------------------
// The linear chart makes a CLAIM ABOUT THE ANIMAL in colour, and colour is what a
// reader takes away — nobody reads a caption to find out whether green was good.
//
// One trait carries the whole risk. Stature runs Short (−) to Tall (+) and this
// stud selects DOWN, so a bull at −2.0 is a GOOD bull with a NEGATIVE number. The
// original chart shaded by sign alone, which would have painted him in the "bad"
// colour and told every reader the exact opposite of the truth. These tests pin
// the colour to FAVOURABILITY, not to the sign.
// ---------------------------------------------------------------------------

const BRAND = "bg-brand-500"; // favourable
const AMBER = "bg-amber-500"; // unfavourable
const NEUTRAL = "bg-slate-400"; // no better end

function draw(t: Partial<LinearTraitDatum> & { value: number }): string {
  const datum: LinearTraitDatum = {
    name: "Stature", min: -3, max: 3, left: "Short", right: "Tall", ...t,
  };
  return renderToStaticMarkup(<LinearGraph groups={[{ group: "Body", traits: [datum] }]} />);
}

/** The bar element's colour class, ignoring the legend swatches below the chart. */
function barClass(html: string): string {
  const m = html.match(/absolute top-0\.5 bottom-0\.5 rounded (bg-[a-z0-9-]+)/);
  assert.ok(m, "no value bar found in rendered chart");
  return m[1];
}

test("THE POINT: on a lower-is-better trait, the NEGATIVE bull is the green one", () => {
  // A bull two points short, on a scale this stud selects downward.
  assert.equal(barClass(draw({ value: -2, favourable: "left" })), BRAND);
  // ...and the tall one is the warning, even though his number is positive.
  assert.equal(barClass(draw({ value: 2, favourable: "left" })), AMBER);
});

test("a higher-is-better trait still reads the ordinary way", () => {
  assert.equal(barClass(draw({ value: 2, favourable: "right" })), BRAND);
  assert.equal(barClass(draw({ value: -2, favourable: "right" })), AMBER);
});

test("an intermediate optimum is shaded as neither, and says so", () => {
  const html = draw({ value: 2, name: "Rump Angle", favourable: "intermediate" });
  assert.equal(barClass(html), NEUTRAL, "neither end of an intermediate trait is 'good'");
  assert.match(html, />opt</, "intermediate traits carry a visible badge");
  assert.match(html, /intermediate optimum/, "and the legend explains what the badge means");
  // The same chart with a directional trait must NOT claim an optimum.
  assert.doesNotMatch(draw({ value: 2, favourable: "right" }), />opt</);
});

test("omitting favourable preserves the original sign-based behaviour exactly", () => {
  // The Canadian card passes no direction, and must be unaffected by all of this.
  assert.equal(barClass(draw({ value: 2 })), BRAND);
  assert.equal(barClass(draw({ value: -2 })), AMBER);
  const html = draw({ value: 2 });
  assert.match(html, /positive deviation/, "unrated charts keep the neutral legend wording");
  assert.doesNotMatch(html, /favourable end/);
});

test("the favourable descriptor is the emphasised one", () => {
  // "Short" is the good end for stature here, so it is the bold one, not "Tall".
  const html = draw({ value: -2, favourable: "left" });
  assert.match(html, /font-semibold text-brand-600[^>]*>Short</);
  assert.doesNotMatch(html, /font-semibold text-brand-600[^>]*>Tall</);
});

test("a value past the end of the track is clamped to the rail, but printed in full", () => {
  // CDCB publishes the odd extreme bull outside ±3. The bar may not run off the
  // chart, but the number beside it must stay the real one.
  const html = draw({ value: 4.5, favourable: "right" });
  // Every percentage the chart emits stays within the track.
  for (const [, n] of html.matchAll(/(?:left|width):(-?[\d.]+)%/g)) {
    const v = Number(n);
    assert.ok(v >= 0 && v <= 100, `${v}% escapes the track`);
  }
  assert.match(html, /left:100%/, "the marker pins to the rail rather than running off");
  assert.match(html, /\+4\.5/, "and the true value is still printed beside it");
});

test("±3 puts breed average dead centre", () => {
  const html = draw({ value: 0, favourable: "right" });
  assert.match(html, /left:\s*50%/, "zero sits at the midpoint of a symmetric track");
});
