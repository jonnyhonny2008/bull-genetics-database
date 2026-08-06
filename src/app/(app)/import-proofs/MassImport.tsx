"use client";

import { useRef, useState } from "react";

// Browser-driven mass import: reads the Lactanet CSV locally and streams it to
// /api/proof-import/chunk in small batches, so it works on Vercel (no server-side
// file storage, every request well under the timeout). Keep the tab open until done.
const CHUNK = 200;

export default function MassImport() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run() {
    const f = fileRef.current?.files?.[0];
    if (!f || busy) return;
    setBusy(true); setSummary(null); setError(null); setProgress({ done: 0, total: 0 });
    try {
      const text = await f.text();
      const lines = text.split(/\r?\n/);
      const header = lines[0] ?? "";
      const data = lines.slice(1).filter((l) => l.trim());
      if (!header || !data.length) { setError("That file has no data rows."); setBusy(false); return; }
      setProgress({ done: 0, total: data.length });

      let captureId: string | undefined;
      let imported = 0, created = 0, failed = 0;
      const reasons: string[] = [];
      let stopped = false;
      for (let i = 0; i < data.length; i += CHUNK) {
        const rows = data.slice(i, i + CHUNK);
        const resp = await fetch("/api/proof-import/chunk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ header, rows, fileName: f.name, captureId }),
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) { setError(j.error ?? `Import failed (HTTP ${resp.status}).`); break; }
        captureId = j.captureId ?? captureId;
        imported += j.imported ?? 0; created += j.created ?? 0; failed += j.failed ?? 0;
        if (Array.isArray(j.failures)) for (const r of j.failures) if (reasons.length < 12) reasons.push(String(r));
        setProgress({ done: Math.min(i + CHUNK, data.length), total: data.length });
        // The very first chunk failing wholesale means the file's layout is wrong
        // (shifted header, not a bull-proof CSV). Stop rather than grind through
        // every chunk failing identically, and show why.
        if (j.fatal && i === 0) {
          setError(
            `None of the first ${rows.length} rows imported — the file layout looks wrong for a Lactanet bull-proof CSV. ` +
            (reasons.length ? `First problems: ${reasons.slice(0, 3).join("; ")}` : ""),
          );
          stopped = true;
          break;
        }
      }
      if (stopped) return;
      const detail = failed && reasons.length ? ` First skipped: ${reasons.slice(0, 3).join("; ")}` : "";
      if (imported === 0 && failed > 0) {
        setError(`No rows imported; ${failed} skipped of ${data.length}.${detail}`);
      } else {
        setSummary(`${imported} imported (${created} new)${failed ? `, ${failed} skipped` : ""} of ${data.length} rows.${detail}`);
      }
    } catch (e) {
      setError("Import error: " + String(e).slice(0, 140));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Select the Lactanet bull-proof CSV on your computer (e.g. <code>aiobgepa2604_ho.csv</code>). It imports in
        small background batches — <strong>keep this tab open until it finishes</strong>. Works the same here and on
        the hosted site; no server upload needed.
      </p>
      <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="text-sm" disabled={busy} />
      <div>
        <button type="button" onClick={run} disabled={busy} className="btn-primary">
          {busy ? `Importing… ${progress?.done ?? 0}/${progress?.total ?? 0}` : "Import ALL bulls"}
        </button>
      </div>
      {progress && progress.total > 0 && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}
      {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</div>}
      {summary && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
          {summary} <a href="/animals" className="underline">View animals →</a>
        </div>
      )}
    </div>
  );
}
