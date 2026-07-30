"use client";

import { useMemo, useState } from "react";

// Client-only helper: paste a list of registration numbers (or a CSV column),
// and get the exact browser snippet to run on holstein.ca. The snippet is the
// real scraper (scripts/holstein-extract.js, passed in as `extractorSource`)
// plus a call seeded with the parsed reg numbers. Nothing is sent anywhere from
// here — the user runs it in their own browser, which downloads a batch JSON to
// import above.
export default function PrepareScrape({ extractorSource }: { extractorSource: string }) {
  const [raw, setRaw] = useState("");
  const [copied, setCopied] = useState(false);

  const regs = useMemo(() => {
    const found = raw.toUpperCase().match(/HOCAN[FM]?\d{4,}|HO\d{6,}/g) ?? [];
    return [...new Set(found.map((s) => s.trim()))];
  }, [raw]);

  const snippet = useMemo(() => {
    if (!regs.length) return "";
    return `${extractorSource}\n\n/* ---- run the scrape for your list ---- */\nawait scrapeHolstein(${JSON.stringify(regs)});\n`;
  }, [regs, extractorSource]);

  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Registration numbers (paste a list, CSV column, or Excel selection)</label>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={5}
          className="input font-mono text-xs"
          placeholder={"HOCANM120781841\nHOCANF121517751\n… (commas, spaces, or newlines all work)"}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Detected <strong>{regs.length}</strong> registration number{regs.length === 1 ? "" : "s"}. Accepts HOCANM/HOCANF/HO numbers; anything else is ignored.
        </p>
      </div>

      {regs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">Step 1 — copy this, run it in your browser console on holstein.ca</span>
            <button type="button" onClick={copy} className="btn-secondary text-xs">{copied ? "Copied ✓" : "Copy snippet"}</button>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-500">
            <li>Open <a className="text-blue-600 underline" href="https://www.holstein.ca/en/AIS/Search" target="_blank" rel="noreferrer">holstein.ca Animal Inquiry</a> in a new tab.</li>
            <li>Open DevTools → Console (F12), paste the snippet, press Enter.</li>
            <li>A <code>holstein-batch-*.json</code> downloads when it finishes.</li>
            <li>Upload that file in <em>Step 2</em> above to import everything into the database.</li>
          </ol>
          <textarea readOnly value={snippet} rows={8} className="input font-mono text-[10px] leading-tight" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </div>
  );
}
