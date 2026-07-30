"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ReportRow, TraitChange } from "@/lib/proof-change";

// Trim to at most 2 decimals without trailing zeros.
const fmt = (n: number | null) => (n == null ? "—" : String(Math.round(n * 100) / 100));
const signed = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}`);
const pctStr = (p: number | null) => (p == null ? "—" : `${p > 0 ? "+" : ""}${Math.round(p * 100)}%`);

function deltaClass(d: number | null) {
  if (d == null || d === 0) return "text-slate-400";
  return d > 0 ? "text-emerald-600" : "text-red-600";
}
function arrow(d: number | null) {
  if (d == null || d === 0) return "";
  return d > 0 ? "▲" : "▼";
}

export function ProofChangeTable({
  rows, keyTraits, sort, dir, params,
}: {
  rows: ReportRow[];
  keyTraits: { code: string; label: string }[];
  sort: string;
  dir: "asc" | "desc";
  /** Every other active filter, carried through when a header is clicked. */
  params: Record<string, string>;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const cols = 3 + keyTraits.length;

  // --- horizontal scrollbar mirrored above the table ---------------------
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0);
  const lock = useRef<"top" | "body" | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => setScrollW(el.scrollWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows, open]);

  const onTopScroll = useCallback(() => {
    if (lock.current === "body") { lock.current = null; return; }
    lock.current = "top";
    if (bodyRef.current && topRef.current) bodyRef.current.scrollLeft = topRef.current.scrollLeft;
  }, []);
  const onBodyScroll = useCallback(() => {
    if (lock.current === "top") { lock.current = null; return; }
    lock.current = "body";
    if (bodyRef.current && topRef.current) topRef.current.scrollLeft = bodyRef.current.scrollLeft;
  }, []);

  // Clicking a header sorts by it; clicking the active one flips direction.
  const sortHref = (code: string) => {
    const p = new URLSearchParams(params);
    const active = sort === code;
    p.set("sort", code);
    p.set("dir", active && dir === "desc" ? "asc" : "desc");
    return `/reports/proof-changes?${p.toString()}`;
  };
  const caret = (code: string) => (sort === code ? (dir === "desc" ? " ↓" : " ↑") : "");
  const headCls = (code: string) =>
    `th cursor-pointer select-none whitespace-nowrap hover:text-brand-700 ${sort === code ? "text-brand-700" : ""}`;

  return (
    <div className="card">
      {/* Mirror scrollbar so you can pan the wide table without scrolling down */}
      <div ref={topRef} onScroll={onTopScroll} className="overflow-x-auto overflow-y-hidden border-b border-slate-100" style={{ scrollbarWidth: "thin" }}>
        <div style={{ width: scrollW, height: 1 }} />
      </div>

      <div ref={bodyRef} onScroll={onBodyScroll} className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="th sticky left-0 z-10 bg-slate-50">
                <Link href={sortHref("name")} className={sort === "name" ? "text-brand-700" : "hover:text-brand-700"}>Bull{caret("name")}</Link>
              </th>
              <th className="th whitespace-nowrap">Proofs compared</th>
              {keyTraits.map((t) => {
                const code = t.code.toLowerCase();
                return (
                  <th key={t.code} className={`${headCls(code)} text-right`} title={`Sort by ${t.label} change`}>
                    <Link href={sortHref(code)}>{t.label}{caret(code)}</Link>
                  </th>
                );
              })}
              <th className={`${headCls("flags")} text-center`} title="Sort by number of key traits flagged">
                <Link href={sortHref("flags")}>Flags{caret("flags")}</Link>
              </th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const c = r.change;
              const byCode = new Map(c.keyChanges.map((k) => [k.code, k]));
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
                      {c.previousRun ?? "?"} <span className="text-slate-300">→</span> {c.latestRun ?? "?"}
                    </td>
                    {keyTraits.map((t) => {
                      const k = byCode.get(t.code);
                      return (
                        <td key={t.code} className="td text-right">
                          {!k || k.delta == null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <>
                              <div className={`font-semibold tabular-nums ${deltaClass(k.delta)}`}>
                                {arrow(k.delta)} {signed(k.delta)}
                                {k.flagged && <span className="ml-1 rounded bg-amber-100 px-1 align-middle text-[9px] font-bold text-amber-700">!</span>}
                              </div>
                              <div className="text-[10px] tabular-nums text-slate-400">{fmt(k.previous)}→{fmt(k.latest)}</div>
                            </>
                          )}
                        </td>
                      );
                    })}
                    <td className="td text-center" title={`${c.keyFlaggedCount} key trait(s) flagged · ${c.flaggedCount} flagged across all traits`}>
                      {c.keyFlaggedCount > 0
                        ? <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">{c.keyFlaggedCount}</span>
                        : <span className="text-slate-300">0</span>}
                      {c.flaggedCount > c.keyFlaggedCount && <span className="ml-1 text-[10px] text-slate-400">+{c.flaggedCount - c.keyFlaggedCount}</span>}
                    </td>
                    <td className="td text-right text-slate-400">{isOpen ? "▲" : "▼"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/60">
                      <td className="td" colSpan={cols + 2}>
                        <BullDetail change={c} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One compact line per trait: the CHANGE first, then the name and detail. */
function TraitLine({ t }: { t: TraitChange }) {
  return (
    <div className={`flex items-baseline gap-2 rounded px-1.5 py-[3px] ${t.flagged ? "bg-amber-50" : t.key ? "bg-brand-50/40" : ""}`}>
      <span className={`w-[68px] shrink-0 text-right text-xs font-semibold tabular-nums ${deltaClass(t.delta)}`}>
        {arrow(t.delta)} {signed(t.delta)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700" title={t.name}>
        {t.name}{t.key && <span className="ml-1 text-[8px] uppercase text-brand-500">key</span>}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-slate-400" title="previous → latest">
        {fmt(t.previous)}→{fmt(t.latest)}
      </span>
      <span className={`w-11 shrink-0 text-right text-[10px] tabular-nums ${t.flagged ? "font-semibold text-amber-700" : "text-slate-400"}`} title="SD from how the lineup moved">
        {t.z == null ? "—" : `${t.z > 0 ? "+" : ""}${t.z}`}
      </span>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-slate-300" title="% change (reference only)">
        {pctStr(t.pct)}
      </span>
    </div>
  );
}

function BullDetail({ change }: { change: ReportRow["change"] }) {
  const keys = change.allChanges.filter((t) => t.key);
  const others = change.allChanges.filter((t) => !t.key);
  return (
    <div className="space-y-2 py-1">
      <div className="text-xs text-slate-600"><span className="font-semibold">What changed most:</span> {change.summary}</div>

      <div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Key traits</div>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((t) => <TraitLine key={t.code} t={t} />)}
        </div>
      </div>

      <div>
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          All other traits ({others.length}) · {change.flaggedCount - change.keyFlaggedCount} flagged
        </div>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
          {others.map((t) => <TraitLine key={t.code} t={t} />)}
        </div>
      </div>

      <div className="text-[10px] text-slate-400">
        Columns: change · trait · previous→latest · SD from the lineup · % (reference).
      </div>
    </div>
  );
}
