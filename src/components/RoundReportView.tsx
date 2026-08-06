"use client";

import { useState } from "react";
import { Card, Table } from "@/components/ui";
import { fmtNum } from "@/lib/format";
// Type-only import: the data engine is server-only, so only its shapes cross into
// this client component. The five trait columns are fixed, so they live here.
import type { RoundReport, TierAverages, MoveRow, FullRow, NewcomerRow, RoundValues } from "@/lib/proof-round-report";

const TRAITS = [
  { label: "LPI", col: "lpi" },
  { label: "Milk", col: "milk" },
  { label: "Fat", col: "fat" },
  { label: "Protein", col: "prot" },
  { label: "Conformation", col: "conf" },
] as const;

const shortLabel = (l: string) => (l === "Conformation" ? "Conf" : l === "Protein" ? "Prot" : l);
const numOf = (v: RoundValues | null, col: string): number | null =>
  v ? ((v[col as keyof RoundValues] as number | null) ?? null) : null;

function Chg({ n, dp = 0 }: { n: number | null | undefined; dp?: number }) {
  if (n == null || !Number.isFinite(n)) return <span className="text-slate-400">—</span>;
  const cls = n > 0 ? "text-emerald-700" : n < 0 ? "text-red-700" : "text-slate-400";
  return <span className={`font-semibold ${cls}`}>{n > 0 ? "+" : ""}{fmtNum(n, dp)}</span>;
}

function NameLink({ name, url }: { name: string; url: string | null }) {
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-navy-800 hover:underline">{name}</a>
    : <span className="font-medium text-slate-800">{name}</span>;
}

// --- average boxes ----------------------------------------------------------

function AvgRow({ label, a }: { label: string; a: TierAverages }) {
  const boxes: [string, number | null][] = [
    ["LPI", a.lpi], ["Milk kg", a.milk], ["Fat kg", a.fat], ["Protein kg", a.prot], ["Conformation", a.conf],
  ];
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-sm font-semibold text-navy-800">{label}</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {boxes.map(([lbl, v]) => {
          const cls = v == null ? "text-slate-400" : v > 0 ? "text-emerald-700" : v < 0 ? "text-red-700" : "text-slate-400";
          return (
            <div key={lbl} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-3 text-center">
              <div className={`text-xl font-extrabold ${cls}`}>{v == null ? "—" : (v > 0 ? "+" : "") + fmtNum(v, 1)}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{lbl}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">{fmtNum(a.n)} of {fmtNum(a.population)} bulls moved</div>
    </div>
  );
}

// --- movers -----------------------------------------------------------------

function moverRows(rows: MoveRow[]) {
  if (!rows.length) {
    return <tr><td className="td text-center italic text-slate-400" colSpan={6}>None in this population.</td></tr>;
  }
  return rows.map((r, i) => (
    <tr key={r.id}>
      <td className="td text-center text-slate-400">{i + 1}</td>
      <td className="td"><NameLink name={r.name} url={r.profileUrl} /></td>
      <td className="td font-mono text-xs text-slate-600">{r.naab ?? "—"}</td>
      <td className="td text-right">{fmtNum(r.from)}</td>
      <td className="td text-right">{fmtNum(r.to)}</td>
      <td className="td text-right"><Chg n={r.change} /></td>
    </tr>
  ));
}

function MoverCard({ title, rows, fromRun, toRun }: { title: string; rows: MoveRow[]; fromRun: string; toRun: string }) {
  return (
    <Card title={title}>
      <Table head={<>
        <th className="th">#</th><th className="th">Name</th><th className="th">NAAB</th>
        <th className="th text-right">{fromRun}</th><th className="th text-right">{toRun}</th><th className="th text-right">Change</th>
      </>}>
        {moverRows(rows)}
      </Table>
    </Card>
  );
}

// --- full table (grouped header) --------------------------------------------

function FullRowEl({ row, toRun }: { row: FullRow; toRun: string }) {
  const from = TRAITS.map((t) => <td key={"f" + t.col} className="td text-right">{fmtNum(numOf(row.from, t.col))}</td>);
  if (!row.to) {
    return (
      <tr className="bg-slate-50/60 text-slate-400">
        <td className="td text-center">{row.rank}</td>
        <td className="td"><NameLink name={row.name} url={row.profileUrl} /></td>
        <td className="td font-mono text-xs">{row.naab ?? "—"}</td>
        {from}
        <td className="td text-center italic" colSpan={10}>Not in {toRun}</td>
      </tr>
    );
  }
  const to = TRAITS.map((t) => <td key={"t" + t.col} className="td text-right">{fmtNum(numOf(row.to, t.col))}</td>);
  const chg = TRAITS.map((t) => {
    const f = numOf(row.from, t.col), tv = numOf(row.to, t.col);
    return <td key={"c" + t.col} className="td text-right">{f != null && tv != null ? <Chg n={tv - f} /> : <span className="text-slate-400">—</span>}</td>;
  });
  return (
    <tr>
      <td className="td text-center text-slate-400">{row.rank}</td>
      <td className="td"><NameLink name={row.name} url={row.profileUrl} /></td>
      <td className="td font-mono text-xs text-slate-600">{row.naab ?? "—"}</td>
      {from}{to}{chg}
    </tr>
  );
}

function FullTable({ report }: { report: RoundReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="th" rowSpan={2}>#</th>
            <th className="th" rowSpan={2}>Name</th>
            <th className="th" rowSpan={2}>NAAB</th>
            <th className="th border-l border-slate-200 text-center" colSpan={5}>{report.fromRun}</th>
            <th className="th border-l border-slate-200 text-center" colSpan={5}>{report.toRun}</th>
            <th className="th border-l border-slate-200 text-center" colSpan={5}>Change</th>
          </tr>
          <tr>
            {TRAITS.map((t) => <th key={"hf" + t.col} className="th text-right">{shortLabel(t.label)}</th>)}
            {TRAITS.map((t) => <th key={"ht" + t.col} className="th text-right">{shortLabel(t.label)}</th>)}
            {TRAITS.map((t) => <th key={"hc" + t.col} className="th text-right">{shortLabel(t.label)}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {report.full.map((row) => <FullRowEl key={row.id} row={row} toRun={report.toRun} />)}
        </tbody>
      </table>
    </div>
  );
}

// --- newcomers (EBV only) ---------------------------------------------------

function NewcomerCard({ title, rows }: { title: string; rows: NewcomerRow[] }) {
  return (
    <Card title={title}>
      <Table head={<>
        <th className="th">#</th><th className="th">Name</th><th className="th">NAAB</th>
        <th className="th text-right">LPI</th><th className="th text-right">Milk</th><th className="th text-right">Fat</th>
        <th className="th text-right">Prot</th><th className="th text-right">Conf</th><th className="th text-right">Rel%</th>
      </>}>
        {rows.length === 0
          ? <tr><td className="td text-center italic text-slate-400" colSpan={9}>No bulls received their first daughter proof this round.</td></tr>
          : rows.map((r, i) => (
            <tr key={r.id}>
              <td className="td text-center text-slate-400">{i + 1}</td>
              <td className="td"><NameLink name={r.name} url={r.profileUrl} /></td>
              <td className="td font-mono text-xs text-slate-600">{r.naab ?? "—"}</td>
              <td className="td text-right">{fmtNum(r.lpi)}</td>
              <td className="td text-right">{fmtNum(r.milk)}</td>
              <td className="td text-right">{fmtNum(r.fat)}</td>
              <td className="td text-right">{fmtNum(r.prot)}</td>
              <td className="td text-right">{fmtNum(r.conf)}</td>
              <td className="td text-right">{r.rel == null ? "—" : `${Math.round(r.rel * 100)}%`}</td>
            </tr>
          ))}
      </Table>
    </Card>
  );
}

// --- the whole in-app view --------------------------------------------------

export function RoundReportView({ report }: { report: RoundReport }) {
  const [tier, setTier] = useState(0);
  const t = report.tiers[tier];

  return (
    <div className="space-y-4">
      {report.type === "ebv" && (
        <div className="space-y-4">
          <div>
            <h2 className="mb-1 text-lg font-semibold text-slate-800">Top 10 Newly Proven — PA in {report.fromRun}, now EBV in {report.toRun}</h2>
            <p className="mb-2 text-xs text-slate-500">Bulls that were genomic (PA) in {report.fromRun} and received their first daughter proof (EBV) in {report.toRun}.</p>
            <div className="space-y-3">
              <NewcomerCard title={`Top 10 Newcomers by LPI (${report.toRun})`} rows={report.newcomersByLpi} />
              <NewcomerCard title={`Top 10 Newcomers by Conformation (${report.toRun})`} rows={report.newcomersByConf} />
            </div>
          </div>
          <div>
            <h2 className="mb-1 text-lg font-semibold text-slate-800">Newly Proven — Gains &amp; Drops (PA → EBV)</h2>
            <p className="mb-2 text-xs text-slate-500">{report.fromRun} values are the genomic (PA) proof; {report.toRun} values are the first daughter proof (EBV) — how far the proof moved when real daughter data replaced the genomic estimate.</p>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <MoverCard title="▲ Top 10 LPI Gains" rows={report.newProvenLpiGains} fromRun={report.fromRun} toRun={report.toRun} />
              <MoverCard title="▼ Bottom 10 LPI Drops" rows={report.newProvenLpiDrops} fromRun={report.fromRun} toRun={report.toRun} />
              <MoverCard title="▲ Top 10 Conformation Gains" rows={report.newProvenConfGains} fromRun={report.fromRun} toRun={report.toRun} />
              <MoverCard title="▼ Bottom 10 Conformation Drops" rows={report.newProvenConfDrops} fromRun={report.fromRun} toRun={report.toRun} />
            </div>
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-1 text-lg font-semibold text-slate-800">Proof Change Summary — {report.fromRun} → {report.toRun}</h2>
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          The database holds the <strong>NAAB-coded Holstein bulls</strong> only — {fmtNum(report.fromCount)} in {report.fromRun} and{" "}
          {fmtNum(report.toCount)} in {report.toRun} ({fmtNum(report.universe)} across both), not the full breed. &ldquo;Top&nbsp;1,000&rdquo;
          therefore shows the whole lineup; the tiers are ranked by {report.toRun} standings so &ldquo;Top&nbsp;200&rdquo; stays a real subset.
        </p>

        <div className="mb-3 inline-flex rounded-full bg-slate-100 p-1">
          {report.tiers.map((tb, i) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTier(i)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${i === tier ? "bg-navy-800 text-white" : "text-slate-600 hover:text-slate-900"}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <Card title={`Average change — ${t.label}`}>
          <AvgRow label={`By LPI Rank — ${t.label}`} a={t.byLpi} />
          <AvgRow label={`By Conformation Rank — ${t.label}`} a={t.byConf} />
        </Card>

        <h3 className="mb-2 mt-4 text-base font-semibold text-navy-800">LPI Gainers &amp; Losers — {t.label}</h3>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MoverCard title="▲ Top 10 LPI Gainers" rows={t.lpiGainers} fromRun={report.fromRun} toRun={report.toRun} />
          <MoverCard title="▼ Top 10 LPI Losers" rows={t.lpiLosers} fromRun={report.fromRun} toRun={report.toRun} />
        </div>

        <h3 className="mb-2 mt-4 text-base font-semibold text-navy-800">Conformation Gainers &amp; Losers — {t.label}</h3>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <MoverCard title="▲ Top 10 Conformation Gainers" rows={t.confGainers} fromRun={report.fromRun} toRun={report.toRun} />
          <MoverCard title="▼ Top 10 Conformation Losers" rows={t.confLosers} fromRun={report.fromRun} toRun={report.toRun} />
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold text-slate-800">{report.title}</h2>
        {report.fullAvailable < 100 && (
          <p className="mb-2 text-xs text-slate-500">
            {fmtNum(report.fullAvailable)} {report.type === "ebv" ? "daughter-proven (EBV)" : "genomic (PA)"} NAAB Holstein
            bull{report.fullAvailable === 1 ? "" : "s"} were on file in {report.fromRun} — fewer than 100, so all are shown.
          </p>
        )}
        <Card title={`Full table · ranked by ${report.fromRun} LPI`}>
          <FullTable report={report} />
        </Card>
      </div>
    </div>
  );
}
