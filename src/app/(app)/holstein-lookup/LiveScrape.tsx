"use client";

import { useMemo, useRef, useState } from "react";

interface Outcome {
  reg: string; ok: boolean; animalId?: string; name?: string | null;
  created?: boolean; traitCount?: number; evaluation?: boolean; classification?: boolean;
  warnings?: string[]; error?: string;
}

function Row({ o }: { o: Outcome }) {
  return (
    <li className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 text-xs">
      <span className="truncate">
        <span className={o.ok ? "text-emerald-600" : "text-red-600"}>{o.ok ? "✓" : "✗"}</span>{" "}
        <span className="font-mono">{o.reg}</span> {o.name ? <span className="text-slate-500">· {o.name}</span> : null}
      </span>
      <span className="shrink-0 text-slate-400">
        {o.ok
          ? <>{o.created ? "new" : "updated"} · {o.traitCount ?? 0} traits{o.classification ? " · cls" : ""}{o.animalId ? <> · <a className="text-blue-600 underline" href={`/animals/${o.animalId}`}>open</a></> : null}</>
          : <span className="text-red-500">{o.error}</span>}
      </span>
    </li>
  );
}

export default function LiveScrape() {
  // ---- single lookup ----
  const [reg, setReg] = useState("");
  const [single, setSingle] = useState<Outcome | null>(null);
  const [singleBusy, setSingleBusy] = useState(false);

  async function lookupOne(e: React.FormEvent) {
    e.preventDefault();
    setSingleBusy(true); setSingle(null);
    try {
      const r = await fetch("/api/lactanet/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reg }) });
      setSingle(await r.json());
    } catch (err) {
      setSingle({ reg, ok: false, error: String(err) });
    } finally { setSingleBusy(false); }
  }

  // ---- bulk ----
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<Outcome[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Full registrations: breed(2) + country(3, may be numeric like 840) + sex + digits.
  const regs = useMemo(() => [...new Set((raw.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{3}[MF]\d{4,}\b/g) ?? []))], [raw]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    setRaw((prev) => (prev ? prev + "\n" : "") + text);
  }

  async function importAll() {
    if (!regs.length || bulkBusy) return;
    setBulkBusy(true); setRows([]); setSummary(null); setProgress({ done: 0, total: regs.length });
    try {
      const resp = await fetch("/api/lactanet/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ regs }) });
      if (!resp.body) throw new Error("no stream");
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "progress") { setRows((prev) => [...prev, msg.outcome]); setProgress({ done: msg.index, total: msg.total }); }
          else if (msg.type === "done") { setSummary(`${msg.ok} imported (${msg.created} new), ${msg.fail} failed of ${msg.total}.`); }
        }
      }
    } catch (err) {
      setSummary("Import error: " + String(err));
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="space-y-6">
      {/* Single */}
      <form onSubmit={lookupOne} className="space-y-2">
        <label className="label">Look up one animal by registration number</label>
        <div className="flex gap-2">
          <input value={reg} onChange={(e) => setReg(e.target.value)} className="input flex-1" placeholder="HOCANF121517751" />
          <button type="submit" disabled={singleBusy || !reg.trim()} className="btn-primary whitespace-nowrap">
            {singleBusy ? "Scraping…" : "Scrape & import"}
          </button>
        </div>
        {singleBusy && <p className="text-xs text-slate-400">Driving the browser through holstein.ca (all tabs)… ~10s.</p>}
        {single && <ul className="rounded-md border border-slate-200 bg-slate-50 px-3"><Row o={single} /></ul>}
      </form>

      <div className="border-t border-slate-100" />

      {/* Bulk */}
      <div className="space-y-2">
        <label className="label">Import many — paste a reg list or upload a CSV</label>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={4} className="input font-mono text-xs"
          placeholder={"HOCANM120781841, HOCANF121517751\n… commas / spaces / newlines all work"} />
        <div className="flex items-center justify-between gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="text-xs" />
          <span className="text-[11px] text-slate-400">Detected <strong>{regs.length}</strong> reg #{regs.length === 1 ? "" : "s"}</span>
        </div>
        <button type="button" onClick={importAll} disabled={bulkBusy || !regs.length} className="btn-primary">
          {bulkBusy ? `Importing… ${progress?.done ?? 0}/${progress?.total ?? 0}` : `Scrape & import ${regs.length || ""} animal${regs.length === 1 ? "" : "s"}`}
        </button>

        {progress && (
          <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
        )}
        {summary && <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">{summary} <a href="/animals" className="underline">View animals →</a></div>}
        {rows.length > 0 && <ul className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-white px-3">{rows.map((o, i) => <Row key={i} o={o} />)}</ul>}
      </div>
    </div>
  );
}
