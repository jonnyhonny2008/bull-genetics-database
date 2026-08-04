"use client";

// Deliberately the same table as the Proof Change and Interim Change reports —
// same sticky first column, same click-a-row-to-expand, same sortable headers,
// same detail panel. The only thing this report adds is a CONFIDENCE percentage
// beside every projected value. Someone who can read one of these reports can
// read all three without being taught anything new.

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HScroll } from "./HScroll";
import type { ForecastRow, TraitForecast, Confidence } from "@/lib/proof-forecast";

const fmt = (n: number | null) => (n == null ? "—" : String(Math.round(n * 100) / 100));
const signed = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}`);
const pct = (c: number | null) => (c == null ? "—" : `${Math.round(c * 100)}%`);

/** Colour the confidence figure so a weak projection is visible at a glance. */
export function confidenceClass(c: number | null): string {
  if (c == null) return "text-slate-400";
  return c >= 0.7 ? "text-emerald-600" : c >= 0.45 ? "text-amber-600" : "text-red-600";
}

function deltaClass(d: number | null) {
  if (d == null || d === 0) return "text-slate-400";
  return d > 0 ? "text-emerald-600" : "text-red-600";
}

/** How much history stands behind the forecast — muted, so it never competes
 *  with the confidence percentage for attention. */
const EVIDENCE_TONE: Record<Confidence, string> = {
  high: "text-slate-400",
  medium: "text-slate-400",
  low: "text-amber-600",
};

export function ProofForecastTable({
  rows, keyTraits, sort, dir, params, basePath, targetLabel, isApril,
}: {
  rows: ForecastRow[];
  keyTraits: { code: string; label: string }[];
  sort: string;
  dir: "asc" | "desc";
  /** Every other active filter, carried through when a header is clicked. */
  params: Record<string, string>;
  basePath: string;
  targetLabel: string;
  /** On an April round the projection has a direction, so the change is shown. */
  isApril: boolean;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const cols = 3 + keyTraits.length;

  // An expanded panel lives inside the table, so without help it inherits the
  // table's full (scrolled) width — it would drift off-screen with the table and
  // never notice its own overflow. Measuring the visible card and pinning the
  // panel to that width keeps it in view and lets it scroll on its own.
  const cardRef = useRef<HTMLDivElement>(null);
  const [panelW, setPanelW] = useState(0);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const update = () => setPanelW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Clicking a header sorts by it; clicking the active one flips direction.
  const sortHref = (code: string) => {
    const p = new URLSearchParams(params);
    const active = sort === code;
    p.set("sort", code);
    p.set("dir", active && dir === "desc" ? "asc" : "desc");
    return `${basePath}?${p.toString()}`;
  };
  const caret = (code: string) => (sort === code ? (dir === "desc" ? " ↓" : " ↑") : "");
  const headCls = (code: string) =>
    `th cursor-pointer select-none whitespace-nowrap hover:text-brand-700 ${sort === code ? "text-brand-700" : ""}`;

  return (
    <div className="card" ref={cardRef}>
      <HScroll label="drag or shift+scroll" stickyTop>
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th sticky left-0 z-10 bg-slate-50">
                <Link href={sortHref("name")} className={sort === "name" ? "text-brand-700" : "hover:text-brand-700"}>Bull{caret("name")}</Link>
              </th>
              <th className="th whitespace-nowrap">Projected round</th>
              {keyTraits.map((t) => {
                const code = t.code.toLowerCase();
                return (
                  <th
                    key={t.code}
                    className={`${headCls(code)} text-right`}
                    title={`Projected ${t.label} for ${targetLabel}, and the confidence in that value`}
                  >
                    <Link href={sortHref(code)}>{t.label}{caret(code)}</Link>
                  </th>
                );
              })}
              <th
                className={`${headCls("certainty")} text-center`}
                title="Average confidence across the nine key traits"
              >
                <Link href={sortHref("certainty")}>Confidence{caret("certainty")}</Link>
              </th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const f = r.forecast;
              const byCode = new Map(f.keyForecasts.map((k) => [k.code, k]));
              const isOpen = !!open[r.id];
              return (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer align-top hover:bg-slate-50" onClick={() => toggle(r.id)}>
                    <td className="td sticky left-0 z-10 bg-white">
                      <Link href={`/animals/${r.id}`} onClick={(e) => e.stopPropagation()} className="link font-medium">{r.name}</Link>
                      <div className="text-[10px] text-slate-400">
                        {r.naab && <span className="font-mono">NAAB {r.naab}</span>}
                        {r.breed && <span className="ml-1">· {r.breed}</span>}
                      </div>
                    </td>
                    <td className="td whitespace-nowrap text-xs text-slate-500">
                      {f.fromRun ?? "?"} <span className="text-slate-300">→</span> {targetLabel}
                    </td>
                    {keyTraits.map((t) => {
                      const k = byCode.get(t.code);
                      return (
                        <td key={t.code} className="td text-right">
                          {!k || k.predicted == null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <>
                              <div className="font-semibold tabular-nums text-slate-800">{fmt(k.predicted)}</div>
                              {/* The supporting line: how much to trust it, or —
                                  on an April round — the base-change movement. */}
                              {isApril
                                ? <div className={`text-[10px] tabular-nums ${deltaClass(k.delta)}`}>{signed(k.delta)}</div>
                                : <div className={`text-[10px] font-semibold tabular-nums ${confidenceClass(k.confidence)}`}>{pct(k.confidence)}</div>}
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td className="td text-center" title={`Average confidence across the nine key traits · ${f.roundsOnFile} rounds on file`}>
                      {f.confidencePct == null
                        ? <span className="text-slate-300">—</span>
                        : <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${confidenceClass(f.confidencePct)}`}>{pct(f.confidencePct)}</span>}
                      {/* The evidence grade is what the filter above works on,
                          so it has to be visible somewhere. */}
                      <div className={`mt-0.5 text-[9px] uppercase ${EVIDENCE_TONE[f.confidence]}`}>{f.confidence}</div>
                    </td>
                    <td className="td text-right text-slate-400">{isOpen ? "▲" : "▼"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/60">
                      <td className="p-0" colSpan={cols + 2}>
                        <div className="sticky left-0 px-3 py-2" style={panelW ? { width: panelW } : undefined}>
                          <BullDetail row={r} targetLabel={targetLabel} isApril={isApril} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </HScroll>
    </div>
  );
}

/**
 * One compact line per trait, laid out like the change reports': the headline
 * figure first, then the name, then the supporting detail. Nothing truncates —
 * the line sizes to its content and the panel scrolls sideways instead.
 */
function TraitLine({ t, isApril }: { t: TraitForecast; isApril: boolean }) {
  return (
    <div className={`flex items-baseline gap-2 whitespace-nowrap rounded px-1.5 py-[3px] ${t.key ? "bg-brand-50/40" : ""}`}>
      <span className="w-[68px] shrink-0 text-right text-xs font-semibold tabular-nums text-slate-800">
        {fmt(t.predicted)}
      </span>
      <span className="min-w-[140px] shrink-0 text-[11px] text-slate-700">
        {t.name}{t.key && <span className="ml-1 text-[8px] uppercase text-brand-500">key</span>}
      </span>
      <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-slate-400" title="current → projected">
        {fmt(t.current)}→{fmt(t.predicted)}
      </span>
      <span
        className={`w-11 shrink-0 text-right text-[10px] font-semibold tabular-nums ${isApril ? deltaClass(t.delta) : confidenceClass(t.confidence)}`}
        title={isApril ? "projected change from the base change" : "confidence in this projected value"}
      >
        {isApril ? signed(t.delta) : pct(t.confidence)}
      </span>
    </div>
  );
}

function BullDetail({ row, targetLabel, isApril }: { row: ForecastRow; targetLabel: string; isApril: boolean }) {
  const f = row.forecast;
  const keys = f.allForecasts.filter((t) => t.key);
  const others = f.allForecasts.filter((t) => !t.key);
  return (
    <div className="space-y-2 py-1">
      <div className="text-xs text-slate-600"><span className="font-semibold">Forecast:</span> {f.summary}</div>
      {f.drivers.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {f.drivers.map((d) => (
            <span key={d} className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">{d}</span>
          ))}
        </div>
      )}

      <div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Key traits</div>
        <HScroll label="scroll for cut-off values">
          <div className="grid grid-cols-[repeat(3,max-content)] gap-x-6">
            {keys.map((t) => <TraitLine key={t.code} t={t} isApril={isApril} />)}
          </div>
        </HScroll>
      </div>

      <div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          All other traits ({others.length})
        </div>
        <HScroll label="scroll for cut-off values">
          <div className="grid grid-cols-[repeat(3,max-content)] gap-x-6">
            {others.map((t) => <TraitLine key={t.code} t={t} isApril={isApril} />)}
          </div>
        </HScroll>
      </div>

      <div className="text-[10px] text-slate-400">
        Columns: projected {targetLabel} · trait · current→projected · {isApril ? "change" : "confidence"}.
      </div>
    </div>
  );
}
