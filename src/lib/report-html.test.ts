// The HTML report is emailed to third parties and opened from file:// with no
// network. Two things must hold or it is dangerous: every value is escaped (the
// names come from the database and the paste box, i.e. from attackers in the
// limit), and the file references nothing external. These tests are the guard.
//
//   npx tsx --test src/lib/report-html.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  esc,
  jsonForScript,
  htmlDocument,
  table,
  badge,
  statStrip,
  cap,
  type DocumentSpec,
} from "./report-html";

const HOSTILE = `<script>alert('xss')</script>`;

// --- escaping --------------------------------------------------------------

test("esc neutralises every HTML metacharacter", () => {
  assert.equal(esc(`<script>`), "&lt;script&gt;");
  assert.equal(esc(`a & b`), "a &amp; b");
  assert.equal(esc(`"quoted"`), "&quot;quoted&quot;");
  assert.equal(esc(`it's`), "it&#39;s");
  assert.equal(esc(`<a href="x" onclick='y'>&`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
});

test("esc handles null/undefined without printing the words", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
});

test("a hostile bull name renders as visible text, never as a tag", () => {
  const html = table({
    columns: [{ label: "Bull" }],
    rows: [{ cells: [{ html: esc(HOSTILE) }] }],
  });
  assert.ok(!html.includes("<script>alert"), "the raw tag must not survive into the markup");
  assert.ok(html.includes("&lt;script&gt;alert"), "it must be present as escaped text");
});

test("a double quote in data cannot break out of an attribute", () => {
  // A cell title is attacker-controlled and lands inside title="…".
  const html = table({
    columns: [{ label: "X" }],
    rows: [{ cells: [{ html: "v", title: `" onmouseover="alert(1)` }] }],
  });
  assert.ok(!/title="" onmouseover=/.test(html), "the quote must not close the attribute early");
  assert.ok(html.includes("&quot; onmouseover=&quot;"), "the quote must be escaped inside the attribute");
});

test("a column header built from data is escaped too", () => {
  const html = table({ columns: [{ label: HOSTILE }], rows: [] , empty: "none"});
  assert.ok(!html.includes("<script>alert"));
});

// --- the script-embedding escape ------------------------------------------

test("jsonForScript stops </script> from ending the block early", () => {
  const out = jsonForScript({ name: `</script><img onerror=alert(1)>` });
  assert.ok(!out.includes("</script>"), "a literal </script> would terminate the inline script");
  assert.ok(out.includes("\\u003c"), "< must be unicode-escaped");
  assert.ok(out.includes("\\u003e"), "> must be unicode-escaped");
});

test("jsonForScript escapes the JS line terminators U+2028 / U+2029", () => {
  const out = jsonForScript({ a: "x y z" });
  assert.ok(!out.includes(" "), "U+2028 is a literal line break in JS source");
  assert.ok(!out.includes(" "));
});

test("jsonForScript round-trips to the original value once parsed", () => {
  const value = { name: `</script>`, n: 42, arr: ["<b>", "a&b"] };
  // The escapes are all \\uXXXX forms, which JSON.parse restores verbatim.
  const parsed = JSON.parse(jsonForScript(value));
  assert.deepEqual(parsed, value);
});

// --- self-containment ------------------------------------------------------

function sampleDoc(): DocumentSpec {
  return {
    docTitle: "Test",
    reportTitle: "Test Report",
    subtitle: "A sample",
    params: [{ label: "Pool", value: "Blondin bulls" }],
    generatedAt: new Date(0),
    stats: [{ label: "Bulls", value: "42" }],
    notices: [],
    sections: [
      table({
        columns: [{ label: "Bull" }, { label: "LPI", sort: "num", align: "right" }],
        rows: [
          { cells: [{ html: esc(HOSTILE) }, { html: "100", sort: 100 }] },
          { cells: [{ html: esc("Normal Bull") }, { html: "20", sort: 20 }] },
        ],
      }),
    ],
    footnotes: ["A caveat."],
  };
}

test("the emitted document references nothing external", () => {
  const doc = htmlDocument(sampleDoc());
  assert.ok(!/https?:\/\//.test(doc), "no http(s) URL may appear anywhere in the file");
  assert.ok(!/src=["'](?!data:)/.test(doc), "every src must be a data: URI");
  assert.ok(!/<link\b/i.test(doc), "no <link> stylesheet");
  assert.ok(!/@import/.test(doc), "no CSS @import");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(/.test(doc), "no network from the script");
  assert.ok(!/type=["']module["']/.test(doc), "the script must not be an ES module");
});

test("the document inlines exactly one style and one script block", () => {
  const doc = htmlDocument(sampleDoc());
  assert.equal((doc.match(/<style\b/gi) || []).length, 1);
  assert.equal((doc.match(/<script\b/gi) || []).length, 1);
  assert.ok(doc.includes("data:image/png;base64"), "the logo is inlined as a data URI");
});

test("hostile data survives all the way into the whole document escaped", () => {
  const doc = htmlDocument(sampleDoc());
  assert.ok(!doc.includes("<script>alert('xss')"), "no executable copy of the hostile name");
  assert.ok(doc.includes("&lt;script&gt;alert(&#39;xss&#39;)"), "the escaped form is present");
});

// --- numeric sort ----------------------------------------------------------

test("numeric cells carry a numeric sort value, so 100 does not sort before 20", () => {
  const html = table({
    columns: [{ label: "LPI", sort: "num" }],
    rows: [
      { cells: [{ html: "100", sort: 100 }] },
      { cells: [{ html: "20", sort: 20 }] },
    ],
  });
  // The sort value rides data-sv, and the header is marked num-sortable.
  assert.ok(html.includes('data-sv="100"'));
  assert.ok(html.includes('data-sv="20"'));
  assert.ok(html.includes('data-sort="num"'));
});

// --- caps ------------------------------------------------------------------

test("cap trims a long list but keeps the true count and says so", () => {
  const c = cap(Array.from({ length: 5000 }, (_, i) => i), 200, "exclusions");
  assert.equal(c.items.length, 200);
  assert.equal(c.total, 5000);
  assert.ok(c.capped);
  assert.match(c.note, /200/);
  assert.match(c.note, /5,?000/);
});

test("cap leaves a short list alone and flags nothing", () => {
  const c = cap([1, 2, 3], 200, "exclusions");
  assert.equal(c.items.length, 3);
  assert.equal(c.capped, false);
  assert.equal(c.note, "");
});

// --- badges ----------------------------------------------------------------

test("badge escapes its own text", () => {
  assert.ok(!badge(HOSTILE, "warn").includes("<script>alert"));
});
