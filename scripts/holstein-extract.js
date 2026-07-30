/* ===========================================================================
 * Holstein.ca bulk scraper  —  runs IN THE BROWSER (console or bookmarklet)
 * ---------------------------------------------------------------------------
 * Holstein.ca's WAF returns 403 to non-browser HTTP clients, so scraping must
 * happen inside a real browser session. All the data used here is on the
 * PUBLIC animal pages. This script stays on one holstein.ca tab and uses
 * same-origin fetch() to pull each animal's Main + Genetics pages (no page
 * navigation → fast), structures them, and downloads ONE batch JSON file.
 *
 * USAGE
 *   1. Open https://www.holstein.ca/en/AIS/Search in a tab.
 *   2. Open DevTools → Console, paste this whole file, press Enter.
 *   3. Run:  await scrapeHolstein(["HOCANM120781841","HOCANF121517751", ...])
 *      (or paste a big list; whitespace/commas/newlines all work)
 *   4. A file `holstein-batch-<n>.json` downloads. Import it in the app's
 *      "Holstein.ca Lookup" tab, or drop it in imports/holstein/ and run
 *      `npm run import:holstein`.
 *
 * Options:  scrapeHolstein(regs, { delayMs = 400, includeText = true })
 * Progress is logged to the console; partial results are kept on
 * window.__HOLSTEIN so a mid-run failure never loses what was already scraped.
 * ======================================================================== */
(function () {
  const clean = (s) => (s || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();

  function tablesOf(doc) {
    return Array.from(doc.querySelectorAll("table")).map((t) => ({
      head: clean(t.rows[0] && t.rows[0].cells.length === 1 ? t.rows[0].innerText : ""),
      rows: Array.from(t.rows).map((r) => Array.from(r.cells).map((c) => clean(c.innerText))),
    }));
  }

  // Full Main-page text. The parser (parseHolsteinAis) already skips the site
  // chrome to find the name, and the index/composite highlight blocks
  // ("Genetic Production", "Genetic Conformation") must be kept — that's where
  // GLPI/Pro$/PI/RI/LTI/MI/HWI/EI and the conformation composites live.
  function mainTextOf(doc /*, reg */) {
    return clean(doc.body.innerText);
  }

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
    const html = await r.text();
    return { html, doc: new DOMParser().parseFromString(html, "text/html") };
  }

  async function extractOne(regRaw, opts) {
    const reg = String(regRaw).trim().toUpperCase();
    const out = { reg, animalId: null, name: null, mainText: "", genText: null, genTables: null, error: null, scrapedAt: new Date().toISOString() };
    try {
      const { html, doc } = await fetchDoc("/en/AIS/AIS?animalRegNo=" + encodeURIComponent(reg));
      const idM = html.match(/animalId=(\d+)/i);
      out.animalId = idM ? idM[1] : null;
      out.mainText = mainTextOf(doc, reg);
      const nameLine = out.mainText.split("\n").map(clean).filter(Boolean).find((l, idx, a) => a[idx + 1] === reg);
      out.name = nameLine || (doc.title.match(/HOCAN[FM]\d+/) ? null : clean(doc.title));
      if (out.animalId) {
        const g = await fetchDoc(`/en/AIS/Genetics?animalId=${out.animalId}&animalRegNo=${encodeURIComponent(reg)}&uom=KG&me=BCA`);
        out.genTables = tablesOf(g.doc);
        out.genText = opts.includeText === false ? null : clean(g.doc.body.innerText);
      } else {
        out.error = "animalId not found (unknown/animal not public?)";
      }
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  }

  function parseRegs(input) {
    if (Array.isArray(input)) return input;
    return String(input).split(/[\s,;]+/);
  }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  window.scrapeHolstein = async function (input, opts) {
    opts = opts || {};
    const delayMs = opts.delayMs != null ? opts.delayMs : 400;
    const regs = [...new Set(parseRegs(input).map((s) => s.trim().toUpperCase()).filter((s) => /^HOCAN[FM]?\d/.test(s) || /^HO\d/.test(s)))];
    if (!regs.length) { console.error("[holstein] no valid registration numbers in input"); return []; }
    console.log(`[holstein] scraping ${regs.length} animal(s)…`);
    const results = (window.__HOLSTEIN = []);
    let ok = 0, fail = 0;
    for (let i = 0; i < regs.length; i++) {
      const rec = await extractOne(regs[i], opts);
      results.push(rec);
      if (rec.error) { fail++; console.warn(`  ✗ ${rec.reg} — ${rec.error}`); }
      else { ok++; console.log(`  ✓ ${rec.reg}  ${rec.name || ""}  (${(rec.genTables || []).length} tables)`); }
      console.log(`  [${i + 1}/${regs.length}]  ok=${ok} fail=${fail}`);
      if (i < regs.length - 1 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    const fname = `holstein-batch-${regs.length}-${Date.now()}.json`;
    download(fname, results);
    console.log(`[holstein] DONE — ${ok} ok, ${fail} failed. Downloaded ${fname}. Also on window.__HOLSTEIN`);
    return results;
  };

  console.log("[holstein] loaded. Run:  await scrapeHolstein([\"HOCANM120781841\", ...])");
})();
